import { expect, test } from "vitest";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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
async function host(env: Record<string, string> = {}, profile?: string) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-sub-extension-"));
  const agentDir = profile ?? join(cwd, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      extensions: [resolve("test/fixtures/provider.js"), resolve("index.ts")],
      enabledModels: ["worker-test/fake"],
      retry: {
        enabled: true,
        maxRetries: 2,
        baseDelayMs: 10000,
        maxDelayMs: 10000,
      },
    }),
  );
  if (!profile)
    await writeFile(
      join(agentDir, "pi-sub-config.json"),
      JSON.stringify({ "6": "worker-test/fake:off" }),
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
      (await client.getCommands())
        .filter((command) => command.name.startsWith("sub:"))
        .map((command) => command.name)
        .sort(),
    ).toEqual(["sub:continue", "sub:pause", "sub:stop"]);
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
  return JSON.parse(
    result.content.find((part) => part.type === "text")!.text,
  ) as {
    id: string;
    status: string;
    response: string;
    error?: string;
    report?: { id: string; bytes: number; file?: string };
  };
}
function details(message: { details?: unknown }) {
  return (
    message.details as {
      tasks: { id: string; sessionFile: string; execution: string }[];
    }
  ).tasks[0]!;
}
test("cached reports survive continuation and acceptance, but not runtime replacement", async () => {
  const { client, cwd, dispose } = await host({ WORKER_TEST_LARGE_CHILD: "1" });
  try {
    await client.promptAndWait("integration:read-via-wait", undefined, 20000);
    const first = await latestResult(client);
    expect(first).toMatchObject({
      status: "ready",
      report: { id: expect.any(String), bytes: expect.any(Number) },
    });
    expect(first.report!.file).toBeUndefined();
    expect(Buffer.byteLength(first.response)).toBeLessThanOrEqual(512);
    const taskMessage = (await client.getMessages()).findLast(
      (m) => m.role === "toolResult" && m.toolName === "sub_task",
    );
    if (!taskMessage || taskMessage.role !== "toolResult")
      throw Error("Missing task");
    // The waiting tool already delivered this report: no extra notification turn.
    const messages = await client.getMessages();
    expect(messages.filter((m) => m.role === "assistant")).toHaveLength(3);
    expect(
      messages.some(
        (m) => m.role === "custom" && m.customType === "pi-sub:response",
      ),
    ).toBe(false);
    const journal = details(taskMessage).sessionFile;
    expect(basename(journal)).toBe(`${first.id}.jsonl`);
    expect(dirname(journal)).not.toBe(cwd);

    await client.promptAndWait("integration:refine-task", undefined, 20000);
    await client.promptAndWait("integration:accept", undefined, 20000);
    const accepted = await latestResult(client);
    expect(accepted.status).toBe("accepted");
    expect(accepted.report!.id).not.toBe(first.report!.id);

    let offset = 0;
    let pages = "";
    do {
      await client.promptAndWait(
        `integration:report:${first.report!.id}:${offset}`,
        undefined,
        20000,
      );
      const result = (await client.getMessages()).findLast(
        (m) => m.role === "toolResult" && m.toolName === "sub_result",
      );
      if (!result || result.role !== "toolResult")
        throw Error("Missing report page");
      expect(result.isError).toBe(false);
      const page = (
        result.details as {
          report: {
            id: string;
            bytes: number;
            offset: number;
            next?: number;
            text?: string;
          };
        }
      ).report;
      expect(page).toMatchObject({
        id: first.report!.id,
        bytes: first.report!.bytes,
        offset,
      });
      expect(page).not.toHaveProperty("text");
      const text = result.content.find((part) => part.type === "text")!.text;
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(8192);
      pages += text;
      if (page.next === undefined) break;
      expect(page.next).toBeGreaterThan(offset);
      offset = page.next;
    } while (true);
    expect(pages).toContain("Evidence line 漢字");
    expect(pages).toContain("END_OF_LARGE_REPORT");
    await client.newSession();
    await expect(access(dirname(journal))).rejects.toThrow();
    await client.promptAndWait(
      `integration:report:${first.report!.id}:0`,
      undefined,
      20000,
    );
    const stale = (await client.getMessages()).findLast(
      (m) => m.role === "toolResult" && m.toolName === "sub_result",
    );
    expect(stale).toMatchObject({ isError: true });
  } finally {
    await dispose();
  }
}, 90000);

test("concurrent replies share the parent's naturally required next turn", async () => {
  const { client, cwd, dispose } = await host({ WORKER_TEST_CHILD_PIDS: "1" });
  const settled = nextEvent(client, (e) => e.type === "agent_settled");
  try {
    await client.prompt("integration:batch");
    // The parent tool remains busy until both children have exited.
    await eventually(async () => {
      const files = await readdir(join(cwd, "child-pids"));
      expect(files).toHaveLength(2);
      for (const file of files) {
        const pid = Number(
          await readFile(join(cwd, "child-pids", file), "utf8"),
        );
        expect(() => process.kill(pid, 0)).toThrow();
      }
    });
    await writeFile(join(cwd, "parent-release"), "continue");
    await settled.promise;
    const messages = await client.getMessages();
    const batches = messages.filter(
      (m) => m.role === "custom" && m.customType === "pi-sub:response",
    );
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      details: {
        tasks: [
          { description: "First review" },
          { description: "Second review" },
        ],
      },
    });
    expect(messages.filter((m) => m.role === "assistant")).toHaveLength(2);
  } finally {
    settled.dispose();
    await dispose();
  }
}, 30000);

test("a large child failure is bounded and remains readable by report reference", async () => {
  const { client, dispose } = await host({ WORKER_TEST_LARGE_CHILD: "1" });
  try {
    await client.promptAndWait("integration:failure", undefined, 20000);
    await eventually(async () => {
      const message = (await client.getMessages()).findLast(
        (m) => m.role === "custom" && m.customType === "pi-sub:response",
      );
      expect(message).toBeDefined();
    });
    await client.waitForIdle(15000);
    await client.promptAndWait("integration:inspect", undefined, 20000);
    const failed = await latestResult(client);
    expect(failed).toMatchObject({
      status: "failed",
      error: expect.stringContaining("fatal synthetic failure"),
      report: { id: expect.any(String) },
    });
    expect(Buffer.byteLength(failed.error!)).toBeLessThanOrEqual(240);
    await client.promptAndWait(
      `integration:report:${failed.report!.id}:0`,
      undefined,
      20000,
    );
    const page = (await client.getMessages()).findLast(
      (m) => m.role === "toolResult" && m.toolName === "sub_result",
    );
    expect(page).toMatchObject({ isError: false });
    expect(JSON.stringify(page)).toContain("fatal synthetic failure");
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(8192);
  } finally {
    await dispose();
  }
}, 40000);

test("native session replacement closes active children before removing their journals", async () => {
  const { client, cwd, marker, dispose } = await host({
    WORKER_TEST_SLOW_CHILD: "1",
    WORKER_TEST_CHILD_PIDS: "1",
  });
  try {
    await client.promptAndWait("integration:notify", undefined, 20000);
    await eventually(() => readFile(marker));
    const message = (await client.getMessages()).find(
      (message) =>
        message.role === "toolResult" && message.toolName === "sub_task",
    );
    if (!message || message.role !== "toolResult")
      throw new Error("Missing task");
    const task = details(message);
    const pid = Number(
      await eventually(() =>
        readFile(join(cwd, "child-pids", basename(task.sessionFile)), "utf8"),
      ),
    );
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(await client.newSession()).toMatchObject({ cancelled: false });
    expect(() => process.kill(pid, 0)).toThrow();
    await expect(access(dirname(task.sessionFile))).rejects.toThrow();
  } finally {
    await dispose();
  }
}, 30000);

/** Real parent Pi + real child Pi; only the model provider is synthetic. */
test("delegates from a file-authored ladder and reports original child usage once", async () => {
  const { client, dispose, cwd } = await host();
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
    expect(await latestResult(client)).toMatchObject({ status: "accepted" });
    const stats = await client.getSessionStats();
    expect(stats.cost).toBe(stats.assistantMessages * 10 + 10); // delegated task
    expect(stats.tokens.input).toBe(stats.assistantMessages * 10 + 10);
    const exported = await client.exportHtml(join(cwd, "views.html"));
    const html = await readFile(exported.path, "utf8");
    const embedded =
      /<script id="session-data" type="application\/json">([^<]+)<\/script>/.exec(
        html,
      );
    expect(embedded).not.toBeNull();
    const exportedData = JSON.parse(
      Buffer.from(embedded![1]!, "base64").toString("utf8"),
    );
    expect(exportedData.renderedTools).toBeDefined();

    const created = nextEvent(
      client,
      (event) =>
        event.type === "tool_execution_end" && event.toolName === "sub_task",
    );
    try {
      await client.prompt("integration:pause");
      await created.promise;
      const settled = client.waitForIdle(15000);
      expect(await client.prompt("/sub:pause")).toBe("handled");
      await settled;
    } finally {
      created.dispose();
    }
    await client.promptAndWait("integration:inspect", undefined, 20000);
    expect(await latestResult(client)).toMatchObject({ status: "paused" });
    await client.promptAndWait("integration:continue", undefined, 20000);
    await client.promptAndWait("integration:accept", undefined, 20000);
    const accepted = await latestResult(client);
    expect(accepted).toMatchObject({ status: "accepted" });
  } finally {
    await dispose();
  }
}, 60000);

test("the configured ladder delegates outside the main session's model scope", async () => {
  const { client, agentDir, dispose } = await host({
    WORKER_TEST_TWO_MODELS: "1",
  });
  try {
    await writeFile(
      join(agentDir, "pi-sub-config.json"),
      JSON.stringify({ "6": "worker-test/other:off" }),
    );
    expect((await client.getState()).model?.id).toBe("fake");
    expect(
      JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"))
        .enabledModels,
    ).toEqual(["worker-test/fake"]);
    await client.promptAndWait("integration:delegate", undefined, 20000);
    expect(await latestResult(client)).toMatchObject({
      status: "accepted",
    });
    const created = (await client.getMessages()).findLast(
      (message) =>
        message.role === "toolResult" && message.toolName === "sub_task",
    );
    if (!created || created.role !== "toolResult")
      throw new Error("Missing task");
    expect(details(created).execution).toBe("worker-test/other:off");
  } finally {
    await dispose();
  }
}, 30000);

test("ladder edits affect new tasks, not continuations", async () => {
  const { client, agentDir, dispose } = await host({
    WORKER_TEST_TWO_MODELS: "1",
  });
  try {
    await client.promptAndWait("integration:read-via-wait", undefined, 20000);
    const first = await latestResult(client);
    await writeFile(
      join(agentDir, "pi-sub-config.json"),
      JSON.stringify({ "6": "worker-test/other:off" }),
    );
    await client.promptAndWait("integration:refine-task", undefined, 20000);
    await client.promptAndWait("integration:accept", undefined, 20000);
    const continued = (await client.getMessages()).findLast(
      (m) => m.role === "toolResult" && m.toolName === "sub_result",
    );
    if (!continued || continued.role !== "toolResult")
      throw Error("Missing continuation");
    expect(details(continued)).toMatchObject({
      id: first.id,
      execution: "worker-test/fake:off",
    });
    await client.promptAndWait("integration:delegate", undefined, 20000);
    const created = (await client.getMessages()).findLast(
      (m) => m.role === "toolResult" && m.toolName === "sub_task",
    );
    if (!created || created.role !== "toolResult") throw Error("Missing task");
    expect(details(created)).toMatchObject({
      execution: "worker-test/other:off",
    });
  } finally {
    await dispose();
  }
}, 40000);

test("normal conversation never creates or repairs a ladder and confirmation words reach the parent", async () => {
  const { client, agentDir, dispose } = await host();
  try {
    const path = join(agentDir, "pi-sub-config.json");
    await rm(path);
    await client.promptAndWait("accept", undefined, 20000);
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(path, "{broken");
    await client.promptAndWait("cancel", undefined, 20000);
    expect(await readFile(path, "utf8")).toBe("{broken");
    expect((await client.getSessionStats()).assistantMessages).toBe(2);
    await client.promptAndWait("integration:probe-global", undefined, 20000);
    const result = (await client.getMessages()).findLast(
      (message) =>
        message.role === "toolResult" && message.toolName === "sub_task",
    );
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("Invalid model ladder");
    expect(JSON.stringify(result)).toContain(
      "instructions/create-model-ladder.md",
    );
    expect(await readFile(path, "utf8")).toBe("{broken");
    await writeFile(path, JSON.stringify({ "7": "worker-test/fake:off" }));
    await client.promptAndWait("integration:delegate", undefined, 20000);
    expect(await latestResult(client)).toMatchObject({ status: "accepted" });
    expect(await readFile(path, "utf8")).toBe('{"7":"worker-test/fake:off"}');
  } finally {
    await dispose();
  }
}, 30000);

test("two working directories share the profile ladder without project overrides", async () => {
  const first = await host();
  let second: Awaited<ReturnType<typeof host>> | undefined;
  try {
    second = await host({}, first.agentDir);
    const local = join(second.cwd, ".pi/pi-sub-config.json");
    await mkdir(join(second.cwd, ".pi"), { recursive: true });
    await writeFile(local, "not a ladder");
    await second.client.promptAndWait("integration:delegate", undefined, 20000);
    expect(await latestResult(second.client)).toMatchObject({
      status: "accepted",
    });
    await expect(access(join(second.cwd, ".pi/pi-sub"))).rejects.toThrow();
    const global = join(first.agentDir, "pi-sub-config.json");
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
    expect(JSON.stringify(result)).toContain(
      "instructions/create-model-ladder.md",
    );
  } finally {
    await second?.dispose();
    await first.dispose();
  }
}, 60000);

test("an RPC abort stops the parent only: its child finishes and the reply waits for the user", async () => {
  const { client, marker, dispose } = await host({
    WORKER_TEST_SLOW_CHILD: "1",
  });
  // Retry backoff has no live signal; only settlement reports this abort.
  const retry = nextEvent(client, (event) => event.type === "auto_retry_start");
  const responses = async () =>
    (await client.getMessages()).filter(
      (message) =>
        message.role === "custom" && message.customType === "pi-sub:response",
    );
  try {
    await client.prompt("integration:retry");
    await retry.promise;
    await eventually(() => readFile(marker));
    await client.abort();
    const stopped = (await client.getSessionStats()).assistantMessages;
    // The child answers after ten seconds without anyone continuing it.
    await new Promise((resolve) => setTimeout(resolve, 12000));
    expect((await client.getState()).isStreaming).toBe(false);
    expect((await client.getSessionStats()).assistantMessages).toBe(stopped);
    expect(await responses()).toHaveLength(0);
    await client.promptAndWait("And now?", undefined, 20000);
    expect(await responses()).toHaveLength(1);
    await client.promptAndWait("integration:inspect", undefined, 20000);
    expect(await latestResult(client)).toMatchObject({
      status: "ready",
    });
  } finally {
    retry.dispose();
    await dispose();
  }
}, 60000);

test("a steering message ends the parent's wait at once and leaves the child running", async () => {
  const { client, marker, dispose } = await host({
    WORKER_TEST_SLOW_CHILD: "1",
  });
  const waiting = nextEvent(
    client,
    (event) =>
      event.type === "tool_execution_start" && event.toolName === "sub_result",
  );
  try {
    await client.prompt("integration:read-via-wait");
    await waiting.promise;
    await eventually(() => readFile(marker));
    // The child answers after ten seconds and the wait would last fifteen.
    const settled = client.waitForIdle(8000);
    expect(await client.steer("One more thing.")).toBe("queued");
    await settled;
    const messages = await client.getMessages();
    const index = messages.findLastIndex(
      (message) =>
        message.role === "toolResult" && message.toolName === "sub_result",
    );
    expect(await latestResult(client)).toMatchObject({ status: "active" });
    expect(JSON.stringify(messages[index + 1])).toContain("One more thing.");
    expect(messages.at(-1)?.role).toBe("assistant");
    // Never interrupted: the reply still arrives on its own.
    await eventually(async () =>
      expect(
        (await client.getMessages()).some(
          (message) =>
            message.role === "custom" &&
            message.customType === "pi-sub:response",
        ),
      ).toBe(true),
    );
  } finally {
    waiting.dispose();
    await dispose();
  }
}, 60000);

test("the idle RPC operator pause pauses children without calling the parent model", async () => {
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
