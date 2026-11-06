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
  accept = true,
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
      WORKER_TEST_READONLY_RESEARCH: "1",
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
    if (research) {
      expect(await client.prompt("/sub:models")).toBe("handled");
      await proposal(client, "6");
      await expect(
        readFile(join(agentDir, "pi-sub/models.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      if (accept) expect(await client.prompt("accept")).toBe("handled");
    }
    if (!research || accept)
      await eventually(async () => {
        const ladder = JSON.parse(
          await readFile(join(agentDir, "pi-sub/models.json"), "utf8"),
        );
        expect(ladder["6"]).toEqual({
          model: "worker-test/fake:off",
          cost: 0.1,
        });
        expect(Object.keys(ladder)).toEqual(["6"]);
      });
    return { client, marker, dispose, cwd, agentDir };
  } catch (error) {
    await dispose();
    throw error;
  }
}
async function proposal(client: RpcClient, rung: string) {
  return eventually(async () => {
    const message = (await client.getMessages()).findLast((message) => {
      if (message.role !== "custom" || message.customType !== "pi-sub:models")
        return false;
      const details = message.details as {
        proposal?: { ladder?: Record<string, unknown> };
      };
      return !!details?.proposal?.ladder?.[rung];
    });
    if (!message || message.role !== "custom") throw Error("No draft proposal");
    return message.details as {
      task: { id: string; sessionFile: string };
      proposal: {
        ladder: Record<string, { model: string; cost: number | null }>;
        comparison: string;
      };
    };
  });
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

test("proposal and prompt refinements remain drafts until explicit acceptance", async () => {
  const { client, agentDir, dispose } = await host({}, undefined, true, false);
  try {
    const first = await proposal(client, "6");
    const before = await client.getSessionStats();
    expect(before.assistantMessages).toBe(0);
    expect(await client.prompt("integration:refine-proposal")).toBe("handled");
    const revised = await proposal(client, "7");
    expect(revised.task.id).toBe(first.task.id);
    expect(revised.task.sessionFile).toBe(first.task.sessionFile);
    expect((await client.getSessionStats()).assistantMessages).toBe(0);
    const path = join(agentDir, "pi-sub/models.json");
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await client.prompt("accept")).toBe("handled");
    await eventually(async () =>
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
        "7": { model: "worker-test/fake:off", cost: 0.2 },
      }),
    );
    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(3);
    await client.promptAndWait("integration:delegate", undefined, 20000);
    expect(await latestResult(client)).toMatchObject({ outcome: "reply" });
    const stats = await client.getSessionStats();
    expect(stats.cost).toBe(stats.assistantMessages * 10 + 30); // Two research executions + one delegated task, once.
  } finally {
    await dispose();
  }
}, 60000);

test("cancelling a revised proposal preserves the saved ladder and exits refinement mode", async () => {
  const { client, agentDir, dispose } = await host();
  try {
    const path = join(agentDir, "pi-sub/models.json"),
      before = await readFile(path, "utf8");
    expect(await client.prompt("/sub:models")).toBe("handled");
    await client.prompt("integration:refine-proposal");
    await proposal(client, "7");
    expect(await client.prompt("cancel")).toBe("handled");
    expect(await readFile(path, "utf8")).toBe(before);
    const count = (await client.getSessionStats()).assistantMessages;
    await client.promptAndWait(
      "A normal parent question after cancellation",
      undefined,
      20000,
    );
    expect((await client.getSessionStats()).assistantMessages).toBe(count + 1);
  } finally {
    await dispose();
  }
}, 60000);

test("extension-generated slash commands cannot impersonate user acceptance", async () => {
  const { client, agentDir, dispose } = await host({}, undefined, true, false);
  const refused = nextEvent(client, (event) => {
    const ui = event as unknown as {
      type: string;
      method?: string;
      message?: string;
    };
    return (
      ui.type === "extension_ui_request" &&
      ui.method === "notify" &&
      !!ui.message?.includes("Type accept in the normal prompt")
    );
  });
  try {
    expect(await client.prompt("/extension-accept")).toBe("handled");
    await refused.promise;
    await expect(
      readFile(join(agentDir, "pi-sub/models.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await client.prompt("accept")).toBe("handled");
    expect(
      JSON.parse(await readFile(join(agentDir, "pi-sub/models.json"), "utf8")),
    ).toHaveProperty("6");
  } finally {
    refused.dispose();
    await dispose();
  }
}, 60000);

test("acceptance never clobbers a config edited while its proposal was open", async () => {
  const { client, agentDir, dispose } = await host({}, undefined, true, false);
  try {
    const path = join(agentDir, "pi-sub/models.json"),
      manual = JSON.stringify({
        "9": { model: "worker-test/fake:off", cost: 9 },
      });
    await mkdir(join(agentDir, "pi-sub"), { recursive: true });
    await writeFile(path, manual);
    expect(await client.prompt("accept")).toBe("handled");
    expect(await readFile(path, "utf8")).toBe(manual);
    await eventually(async () =>
      expect(JSON.stringify(await client.getMessages())).toContain(
        "Model ladder changed",
      ),
    );
  } finally {
    await dispose();
  }
}, 60000);

test("two working directories share the confirmed ladder and never load a local override or fallback", async () => {
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

test("a manual ladder edit cannot resume a retained execution below its minimum level", async () => {
  const { client, marker, agentDir, dispose } = await host({
    WORKER_TEST_SLOW_CHILD: "1",
  });
  try {
    await client.promptAndWait("integration:pause", undefined, 20000);
    await eventually(() => readFile(marker));
    expect(await client.prompt("/sub:pause")).toBe("handled");
    const path = join(agentDir, "pi-sub/models.json");
    const ladder = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ "2": ladder["6"] }));
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
