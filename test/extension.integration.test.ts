import { expect, test } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  RpcClient,
  getPackageDir,
  type JsonAgentSessionEvent,
} from "@earendil-works/pi-coding-agent";

async function eventually<T>(
  read: () => Promise<T>,
  timeout = 15000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: unknown;
  do {
    try {
      return await read();
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  } while (Date.now() < deadline);
  throw last;
}
async function host(
  env: Record<string, string> = {},
  profile?: string,
  research = true,
) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-sub-extension-"));
  const agentDir = profile ?? join(cwd, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      extensions: [resolve("test/fixtures/provider.js"), resolve("index.ts")],
      retry: {
        enabled: true,
        maxRetries: 2,
        baseDelayMs: 10000,
        maxDelayMs: 10000,
      },
    }),
  );
  const marker = join(cwd, "child-started");
  const client = new RpcClient({
    cliPath: join(getPackageDir(), "dist/cli.js"),
    cwd,
    provider: "worker-test",
    model: "fake",
    args: ["--thinking", "off", "--approve"],
    env: {
      PI_CODING_AGENT_DIR: agentDir,
      PI_SUB_CHILD: "",
      WORKER_TEST_INTEGRATION: "1",
      WORKER_TEST_CHILD_MARKER: marker,
      ...env,
    },
  });
  const dispose = async () => {
    await client.stop();
    await rm(cwd, { recursive: true, force: true });
  };
  try {
    await client.start();
    await client.getState();
    expect(
      (await client.getCommands()).some(
        (command) => command.name === "sub:models",
      ),
    ).toBe(true);
    if (research) expect(await client.prompt("/sub:models")).toBe("handled");
    await eventually(async () => {
      const catalog = JSON.parse(
        await readFile(join(agentDir, "pi-sub/models.json"), "utf8"),
      );
      expect(catalog.version).toBe(2);
      expect(catalog).not.toHaveProperty("approved");
      expect(catalog.candidates.length).toBeGreaterThan(0);
      expect(
        catalog.candidates.every(
          (candidate: object) => !("selected" in candidate),
        ),
      ).toBe(true);
    });
    return { client, marker, dispose, cwd, agentDir };
  } catch (error) {
    await dispose();
    throw error;
  }
}
function nextEvent(
  client: RpcClient,
  matches: (event: JsonAgentSessionEvent) => boolean,
) {
  const result = Promise.withResolvers<void>();
  const timer = setTimeout(
    () => result.reject(new Error("Expected native event did not arrive")),
    15000,
  );
  const unsubscribe = client.onEvent((event) => {
    if (matches(event)) result.resolve();
  });
  void result.promise.catch(() => {});
  return {
    promise: result.promise,
    dispose: () => {
      clearTimeout(timer);
      unsubscribe();
    },
  };
}
async function latestResult(client: RpcClient) {
  const result = (await client.getMessages()).findLast(
    (message) =>
      message.role === "toolResult" && message.toolName === "sub_result",
  );
  if (!result || result.role !== "toolResult")
    throw new Error("Missing sub_result");
  expect(result.isError).toBe(false);
  return JSON.parse(result.content.find((part) => part.type === "text")!.text);
}

/** Real parent Pi + real child Pi; only the model provider is synthetic. */
test("bootstraps, delegates, accepts and reports original child usage once", async () => {
  const { client, dispose } = await host();
  try {
    await client.promptAndWait("integration:delegate", undefined, 20000);
    const messages = await client.getMessages();
    expect(
      messages.some(
        (message) =>
          message.role === "toolResult" &&
          message.toolName === "sub_task" &&
          !message.isError,
      ),
    ).toBe(true);
    expect(await latestResult(client)).toMatchObject({ outcome: "reply" });
    const stats = await client.getSessionStats();
    expect(stats.cost).toBe(stats.assistantMessages * 10 + 20); // setup + task
    expect(stats.tokens.input).toBe(stats.assistantMessages * 10 + 20);
    await client.promptAndWait("integration:repeat", undefined, 20000);
    const repeated = await client.getSessionStats();
    expect(repeated.cost).toBe(repeated.assistantMessages * 10 + 20);

    const created = nextEvent(
      client,
      (event) =>
        event.type === "tool_execution_end" && event.toolName === "sub_task",
    );
    try {
      await client.prompt("integration:pause");
      await created.promise;
      await client.abort();
    } finally {
      created.dispose();
    }
    await client.promptAndWait("integration:inspect", undefined, 20000);
    expect(await latestResult(client)).toMatchObject({ status: "paused" });
    await client.promptAndWait("integration:continue", undefined, 20000);
    await client.promptAndWait("integration:accept", undefined, 20000);
    const accepted = await latestResult(client);
    expect(accepted).toMatchObject({ outcome: "reply" });
    expect(accepted).not.toHaveProperty("status");
  } finally {
    await dispose();
  }
}, 60000);

test("two working directories share profile ratings and never load a local override or fallback", async () => {
  const first = await host();
  let second: Awaited<ReturnType<typeof host>> | undefined;
  try {
    second = await host({}, first.agentDir, false);
    const local = join(second.cwd, ".pi/pi-sub/models.json");
    await mkdir(join(second.cwd, ".pi/pi-sub"), { recursive: true });
    await writeFile(local, "not a catalog");
    await second.client.promptAndWait("integration:delegate", undefined, 20000);
    expect(await latestResult(second.client)).toMatchObject({
      outcome: "reply",
    });
    expect(
      await readFile(join(second.cwd, ".pi/pi-sub/.gitignore"), "utf8"),
    ).toBe("*\n");
    const global = join(first.agentDir, "pi-sub/models.json");
    await writeFile(local, await readFile(global));
    await rm(global);
    await second.client.promptAndWait(
      "integration:probe-global",
      undefined,
      20000,
    );
    const result = (await second.client.getMessages()).findLast(
      (message) =>
        message.role === "toolResult" && message.toolName === "sub_task",
    );
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("run /sub:models");
  } finally {
    await second?.dispose();
    await first.dispose();
  }
}, 60000);

test("a real user prompt collects a final failure without a model cleanup call", async () => {
  const { client, dispose } = await host();
  const failed = nextEvent(client, (event) => {
    const ui = event as unknown as {
      type: string;
      method?: string;
      message?: string;
    };
    return (
      ui.type === "extension_ui_request" &&
      ui.method === "notify" &&
      !!ui.message?.includes("fatal synthetic failure")
    );
  });
  try {
    await client.promptAndWait("integration:failure", undefined, 20000);
    await failed.promise;
    const before = await client.getMessages();
    const count = before.filter(
      (message) => message.role === "toolResult",
    ).length;
    expect((await client.getState()).isStreaming).toBe(false);
    await client.promptAndWait("integration:failure-cleanup", undefined, 20000);
    const after = await client.getMessages();
    expect(
      after.filter((message) => message.role === "toolResult"),
    ).toHaveLength(count);
    const notice = after.find(
      (message) =>
        message.role === "custom" && message.customType === "pi-sub:failures",
    );
    if (!notice || notice.role !== "custom")
      throw new Error("Failure was not transferred into native parent history");
    expect(notice.details).toEqual([
      expect.objectContaining({
        outcome: "error",
        error: "fatal synthetic failure",
        sessionFile: expect.stringMatching(/\.jsonl$/),
      }),
    ]);
    const pending = await client.getSessionStats();
    expect(pending.cost).toBe(pending.assistantMessages * 10 + 10); // only setup delivered so far
    await client.promptAndWait("integration:failure-receipt", undefined, 20000);
    expect(await latestResult(client)).toMatchObject({
      outcome: "error",
      error: "fatal synthetic failure",
    });
    const delivered = await client.getSessionStats();
    expect(delivered.cost).toBe(delivered.assistantMessages * 10 + 20);
    await client.promptAndWait("integration:failure-receipt", undefined, 20000);
    const repeated = await client.getSessionStats();
    expect(repeated.cost).toBe(repeated.assistantMessages * 10 + 20);
    expect(
      (await client.getMessages()).filter(
        (message) =>
          message.role === "custom" && message.customType === "pi-sub:failures",
      ),
    ).toHaveLength(1);
  } finally {
    failed.dispose();
    await dispose();
  }
}, 60000);

test("RPC abort during native retry backoff interrupts the children", async () => {
  const { client, marker, dispose } = await host({
    WORKER_TEST_SLOW_CHILD: "1",
  });
  const retry = nextEvent(client, (event) => event.type === "auto_retry_start");
  try {
    await client.prompt("integration:retry");
    await retry.promise;
    await eventually(() => readFile(marker));
    await client.abort();
    await client.promptAndWait("integration:inspect", undefined, 20000);
    expect(await latestResult(client)).toMatchObject({ status: "paused" });
  } finally {
    retry.dispose();
    await dispose();
  }
}, 60000);

test("a global reassessment cannot resume a retained execution below its minimum level", async () => {
  const { client, marker, agentDir, dispose } = await host({
    WORKER_TEST_SLOW_CHILD: "1",
  });
  try {
    await client.promptAndWait("integration:pause", undefined, 20000);
    await eventually(() => readFile(marker));
    expect(await client.prompt("/sub:pause")).toBe("handled");
    const path = join(agentDir, "pi-sub/models.json");
    const catalog = JSON.parse(await readFile(path, "utf8"));
    for (const candidate of catalog.candidates) candidate.power = 2;
    await writeFile(path, JSON.stringify(catalog));
    await client.promptAndWait("integration:continue", undefined, 20000);
    const result = (await client.getMessages()).findLast(
      (message) =>
        message.role === "toolResult" && message.toolName === "sub_control",
    );
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("minimum level");
    await client.promptAndWait("integration:inspect", undefined, 20000);
    expect(await latestResult(client)).toMatchObject({ status: "paused" });
  } finally {
    await dispose();
  }
}, 60000);

test("the idle RPC operator interrupt pauses children without calling the parent model", async () => {
  const { client, marker, dispose } = await host({
    WORKER_TEST_SLOW_CHILD: "1",
  });
  try {
    await client.promptAndWait("integration:pause", undefined, 20000);
    await eventually(() => readFile(marker));
    const before = await client.getSessionStats();
    expect(await client.prompt("/sub:pause")).toBe("handled");
    expect((await client.getSessionStats()).assistantMessages).toBe(
      before.assistantMessages,
    );
    await client.promptAndWait("integration:inspect", undefined, 20000);
    expect(await latestResult(client)).toMatchObject({ status: "paused" });
  } finally {
    await dispose();
  }
}, 60000);
