import { expect, test } from "vitest";
import type { TaskResult, TaskView } from "../src/coordinator.ts";
import { reportDetails } from "../src/reports.ts";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
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
  const visible = JSON.parse(
    result.content.find((part) => part.type === "text")!.text,
  );
  const details = reportDetails(result.details) as TaskView | TaskResult;
  expect(visible.id).toBe(details.id);
  if (visible.file)
    expect(await readFile(visible.file, "utf8")).toContain(details.response);
  else expect(visible.response).toBe(details.response);
  expect(visible).not.toHaveProperty("execution");
  expect(visible).not.toHaveProperty("sessionFile");
  return details;
}

test("native file handoffs deliver without reading, stay resumable and survive acceptance and shutdown", async () => {
  const { client, cwd, dispose } = await host({ WORKER_TEST_LARGE_CHILD: "1" });
  try {
    await client.promptAndWait("integration:read-via-wait", undefined, 20000);
    const messages = await client.getMessages();
    const result = messages.findLast(
      (message) =>
        message.role === "toolResult" && message.toolName === "sub_result",
    )!;
    if (result.role !== "toolResult") throw new Error("Missing result");
    const ref = JSON.parse(
      result.content.find((part) => part.type === "text")!.text,
    );
    expect(ref.file).toContain(join(cwd, ".pi/pi-sub/reports"));
    const original = await readFile(ref.file, "utf8");
    expect(original).toContain("Evidence line 漢字\n");
    expect(original).toContain("END_OF_LARGE_REPORT");
    expect(
      Buffer.byteLength(
        result.content.find((part) => part.type === "text")!.text,
      ),
    ).toBeLessThanOrEqual(50 * 1024);
    await client.promptAndWait("integration:inspect", undefined, 20000);
    const first = await latestResult(client);
    expect(first).toMatchObject({
      status: "ready",
      reply: { delivered: true },
    });
    await client.promptAndWait("integration:refine-task", undefined, 20000);
    await client.promptAndWait("integration:accept", undefined, 20000);
    expect(await latestResult(client)).toMatchObject({
      id: first.id,
      outcome: "reply",
    });
    expect(
      (await client.getMessages())
        .filter((message) => message.role === "toolResult")
        .map((message) => message.toolName),
    ).not.toContain("read");
    await client.stop();
    expect(await readFile(ref.file, "utf8")).toBe(original);
  } finally {
    await dispose();
  }
}, 30000);

test("native acceptance reports its committed state on publication failure and retains a retrievable receipt", async () => {
  const { client, cwd, dispose } = await host({ WORKER_TEST_LARGE_CHILD: "1" });
  try {
    await client.promptAndWait("integration:read-via-wait", undefined, 20000);
    const first = await latestResult(client);
    const directory = join(cwd, ".pi/pi-sub/reports");
    const backup = directory + "-backup";
    // A deterministic storage failure, also when tests run as root.
    await rename(directory, backup);
    await writeFile(directory, "not a directory");
    await client.promptAndWait("integration:accept", undefined, 20000);
    const failed = (await client.getMessages()).findLast(
      (message) =>
        message.role === "toolResult" && message.toolName === "sub_result",
    );
    if (!failed || failed.role !== "toolResult")
      throw new Error("Missing result");
    expect(failed.isError).toBe(true);
    const visible = JSON.parse(
      failed.content.find((part) => part.type === "text")!.text,
    );
    expect(visible).toMatchObject({
      id: first.id,
      archived: true,
      outcome: "reply",
      reportError: expect.any(String),
    });
    expect(visible).not.toHaveProperty("file");
    expect(reportDetails(failed.details)).toMatchObject({
      id: first.id,
      outcome: "reply",
      response: first.response,
    });
    expect(reportDetails(failed.details)).not.toHaveProperty("status");
    await client.promptAndWait("integration:refine-task", undefined, 20000);
    const followUp = (await client.getMessages()).findLast(
      (message) =>
        message.role === "toolResult" && message.toolName === "sub_message",
    );
    expect(followUp).toMatchObject({
      isError: true,
      details: expect.stringContaining("Unknown live task"),
    });
    await rm(directory);
    await rename(backup, directory);
    await client.promptAndWait("integration:failure-receipt", undefined, 20000);
    const receipt = await latestResult(client);
    expect(receipt).toMatchObject({
      id: first.id,
      outcome: "reply",
      response: first.response,
    });
    expect(receipt).not.toHaveProperty("status");
  } finally {
    await dispose();
  }
}, 30000);

test("native reply delivery keeps the task and its session available for follow-up", async () => {
  const { client, dispose } = await host();
  try {
    const delivered = (previous?: string) =>
      eventually(async () => {
        const messages = await client.getMessages();
        const index = messages.findLastIndex(
          (message) =>
            message.role === "custom" &&
            message.customType === "pi-sub:response" &&
            (message.details as { replies: { reply: { id: string } }[] })
              .replies[0]?.reply.id !== previous,
        );
        expect(index).toBeGreaterThanOrEqual(0);
        // The native parent has made a request containing the notification.
        expect(
          messages
            .slice(index + 1)
            .some((message) => message.role === "assistant"),
        ).toBe(true);
        const message = messages[index]!;
        if (message.role !== "custom") throw new Error("No reply notification");
        return (
          message.details as {
            replies: {
              id: string;
              sessionFile: string;
              reply: { id: string; delivered: boolean };
            }[];
          }
        ).replies[0]!;
      });
    await client.promptAndWait("integration:notify", undefined, 20000);
    const first = await delivered();
    expect(first.reply.delivered).toBe(false); // The queued snapshot is not a receipt.
    await client.promptAndWait("integration:inspect", undefined, 20000);
    expect(await latestResult(client)).toMatchObject({
      id: first.id,
      status: "ready",
      outcome: "reply",
      reply: { id: first.reply.id, delivered: true },
    });
    await client.promptAndWait("integration:refine-task", undefined, 20000);
    const next = await delivered(first.reply.id);
    expect(next.id).toBe(first.id);
    expect(next.sessionFile).toBe(first.sessionFile);
    expect(next.reply.id).not.toBe(first.reply.id);
    await client.promptAndWait("integration:inspect", undefined, 20000);
    expect(await latestResult(client)).toMatchObject({
      id: first.id,
      status: "ready",
      reply: { id: next.reply.id, delivered: true },
    });
  } finally {
    await dispose();
  }
}, 40000);

test("a complete tool delivery needs no acceptance call and causes no delayed notification", async () => {
  const { client, dispose } = await host();
  try {
    await client.promptAndWait("integration:read-via-wait", undefined, 20000);
    const messages = await client.getMessages();
    expect(
      messages.filter((message) => message.role === "assistant"),
    ).toHaveLength(3);
    expect(
      messages.filter(
        (message) =>
          message.role === "custom" && message.customType === "pi-sub:response",
      ),
    ).toHaveLength(0);
    expect(await latestResult(client)).toMatchObject({
      status: "ready",
      outcome: "reply",
    });
    await client.promptAndWait("integration:inspect", undefined, 20000);
    expect(await latestResult(client)).toMatchObject({
      status: "ready",
      outcome: "reply",
      reply: { delivered: true },
    });
    expect(
      (await client.getMessages()).filter(
        (message) =>
          message.role === "custom" && message.customType === "pi-sub:response",
      ),
    ).toHaveLength(0);
  } finally {
    await dispose();
  }
}, 30000);

test("native turn boundaries batch concurrent replies into the already required next request", async () => {
  const { client, cwd, dispose } = await host({ WORKER_TEST_CHILD_PIDS: "1" });
  const gate = nextEvent(
    client,
    (event) =>
      event.type === "tool_execution_start" && event.toolName === "bash",
  );
  try {
    const settled = nextEvent(
      client,
      (event) => event.type === "agent_settled",
    );
    try {
      await client.prompt("integration:batch");
      await gate.promise;
      // Keep a real parent tool open until both child processes have exited.
      // Replies must not be sent as follow-ups while this turn is still active.
      await eventually(async () => {
        const files = await readdir(join(cwd, "child-pids"));
        expect(files).toHaveLength(2);
        for (const file of files) {
          const pid = Number(
            await readFile(join(cwd, "child-pids", file), "utf8"),
          );
          expect(() => process.kill(pid, 0)).toThrow();
          expect(
            await readFile(join(cwd, ".pi/pi-sub/sessions", file), "utf8"),
          ).toContain("fake response");
        }
      });
      expect(
        (await client.getMessages()).filter(
          (message) =>
            message.role === "custom" &&
            message.customType === "pi-sub:response",
        ),
      ).toHaveLength(0);
      await writeFile(join(cwd, "parent-release"), "continue");
      await settled.promise;
    } finally {
      settled.dispose();
    }
    const messages = await client.getMessages();
    const batches = messages.filter(
      (message) =>
        message.role === "custom" && message.customType === "pi-sub:response",
    );
    expect(batches).toHaveLength(1);
    if (batches[0]!.role !== "custom") throw Error("Missing native batch");
    expect(
      (
        batches[0]!.details as { replies: { description: string }[] }
      ).replies.map((reply) => reply.description),
    ).toEqual(["First review", "Second review"]);
    // The tool-calling request and its natural continuation, not a third acknowledgement turn.
    expect(
      messages.filter((message) => message.role === "assistant"),
    ).toHaveLength(2);
    await client.promptAndWait("integration:inspect", undefined, 20000);
    expect(await latestResult(client)).toMatchObject({
      status: "ready",
      reply: { delivered: true },
    });
    expect(
      (await client.getMessages()).filter(
        (message) =>
          message.role === "custom" && message.customType === "pi-sub:response",
      ),
    ).toHaveLength(1);
  } finally {
    gate.dispose();
    await dispose();
  }
}, 40000);

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
    expect(await latestResult(client)).toMatchObject({ outcome: "reply" });
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
    const rendered = JSON.stringify(exportedData.renderedTools);
    expect(rendered.includes("Delegated")).toBe(true);
    expect(rendered.includes("Accepted")).toBe(true);
    expect(rendered.includes("Required level:")).toBe(true);
    expect(rendered.includes("Delegating…")).toBe(false);
    await client.promptAndWait("integration:repeat", undefined, 20000);
    const repeated = await client.getSessionStats();
    expect(repeated.cost).toBe(repeated.assistantMessages * 10 + 10);

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
      outcome: "reply",
      execution: { provider: "worker-test", model: "other", thinking: "off" },
    });
  } finally {
    await dispose();
  }
}, 30000);

test("continuations recheck native availability without modifying the retained journal", async () => {
  const { client, dispose } = await host({ WORKER_TEST_TWO_MODELS: "1" });
  try {
    await client.promptAndWait("integration:read-via-wait", undefined, 20000);
    const task = await latestResult(client);
    const before = await readFile(task.sessionFile, "utf8");
    await client.setModel("worker-test", "other");
    expect(await client.prompt("/test-remove-model")).toBe("handled");
    expect(
      (await client.getAvailableModels()).some((model) => model.id === "fake"),
    ).toBe(false);
    await client.promptAndWait("integration:refine-task", undefined, 20000);
    const result = (await client.getMessages()).findLast(
      (message) =>
        message.role === "toolResult" && message.toolName === "sub_message",
    );
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain(
      "retained execution is no longer available",
    );
    expect(await readFile(task.sessionFile, "utf8")).toBe(before);
  } finally {
    await dispose();
  }
}, 30000);

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
    expect(await latestResult(client)).toMatchObject({ outcome: "reply" });
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
      outcome: "reply",
    });
    expect(
      await readFile(join(second.cwd, ".pi/pi-sub/.gitignore"), "utf8"),
    ).toBe("*\n");
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

test.each([false, true])(
  "user input collects failures without a cleanup call, even with broken report storage (%s)",
  async (brokenStorage) => {
    const { client, cwd, dispose } = await host(
      brokenStorage ? { WORKER_TEST_LARGE_CHILD: "1" } : {},
    );
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
      const storage = join(cwd, ".pi/pi-sub/reports");
      if (brokenStorage) await writeFile(storage, "not a directory");
      await client.promptAndWait(
        "integration:failure-cleanup",
        undefined,
        20000,
      );
      const after = await client.getMessages();
      expect(
        after.filter((message) => message.role === "toolResult"),
      ).toHaveLength(count);
      const notice = after.find(
        (message) =>
          message.role === "custom" && message.customType === "pi-sub:failures",
      );
      if (!notice || notice.role !== "custom")
        throw new Error(
          "Failure was not transferred into native parent history",
        );
      const reports = reportDetails(notice.details) as TaskResult[];
      expect(reports).toEqual([
        expect.objectContaining({
          outcome: "error",
          error: expect.stringContaining("fatal synthetic failure"),
          sessionFile: expect.stringMatching(/\.jsonl$/),
        }),
      ]);
      expect(
        after.some(
          (message) =>
            message.role === "user" &&
            JSON.stringify(message.content).includes(
              "integration:failure-cleanup",
            ),
        ),
      ).toBe(true);
      expect(after.at(-1)?.role).toBe("assistant");
      if (brokenStorage) {
        expect(JSON.parse(String(notice.content))).toMatchObject({
          id: reports[0]!.id,
          archived: true,
          reportError: expect.any(String),
        });
        expect(reports[0]!.error).toContain("END_OF_FAILURE_REPORT");
        await rm(storage);
      }
      const pending = await client.getSessionStats();
      expect(pending.cost).toBe(pending.assistantMessages * 10); // failure usage awaits a tool result
      await client.promptAndWait(
        "integration:failure-receipt",
        undefined,
        20000,
      );
      const receipt = await latestResult(client);
      expect(receipt).toMatchObject({
        id: reports[0]!.id,
        outcome: "error",
        error: reports[0]!.error,
      });
      expect(receipt).not.toHaveProperty("status");
      const delivered = await client.getSessionStats();
      expect(delivered.cost).toBe(delivered.assistantMessages * 10 + 10);
      await client.promptAndWait(
        "integration:failure-receipt",
        undefined,
        20000,
      );
      const repeated = await client.getSessionStats();
      expect(repeated.cost).toBe(repeated.assistantMessages * 10 + 10);
      expect(
        (await client.getMessages()).filter(
          (message) =>
            message.role === "custom" &&
            message.customType === "pi-sub:failures",
        ),
      ).toHaveLength(1);
    } finally {
      failed.dispose();
      await dispose();
    }
  },
  60000,
);

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
    const path = join(agentDir, "pi-sub-config.json");
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
