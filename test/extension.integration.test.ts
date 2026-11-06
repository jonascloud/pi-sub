import { expect, test } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  RpcClient,
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
      enabledModels: ["worker-test/fake"],
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
    cliPath: resolve("test/fixtures/rpc-model-picker.js"),
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
        readFile(join(agentDir, "pi-sub-config.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      if (accept) expect(await client.prompt("accept")).toBe("handled");
    }
    if ((research && accept) || (!research && profile))
      await eventually(async () => {
        const ladder = JSON.parse(
          await readFile(join(agentDir, "pi-sub-config.json"), "utf8"),
        );
        expect(ladder["6"]).toBe(
          `${env.WORKER_TEST_PICK_MODEL ?? "worker-test/fake"}:off`,
        );
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
        ladder: Record<string, string>;
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

test("native reply delivery keeps the task and its session available for follow-up", async () => {
  const { client, agentDir, dispose } = await host({}, undefined, false);
  try {
    await writeFile(
      join(agentDir, "pi-sub-config.json"),
      JSON.stringify({
        "6": "worker-test/fake:off",
      }),
    );
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
  const { client, agentDir, dispose } = await host({}, undefined, false);
  try {
    await writeFile(
      join(agentDir, "pi-sub-config.json"),
      JSON.stringify({
        "6": "worker-test/fake:off",
      }),
    );
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
  const { client, cwd, agentDir, dispose } = await host(
    { WORKER_TEST_CHILD_PIDS: "1" },
    undefined,
    false,
  );
  const gate = nextEvent(
    client,
    (event) =>
      event.type === "tool_execution_start" && event.toolName === "bash",
  );
  try {
    await writeFile(
      join(agentDir, "pi-sub-config.json"),
      JSON.stringify({
        "6": "worker-test/fake:off",
      }),
    );
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
test("bootstraps, delegates, accepts and reports original child usage once", async () => {
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
    expect(stats.cost).toBe(stats.assistantMessages * 10 + 20); // setup + task
    expect(stats.tokens.input).toBe(stats.assistantMessages * 10 + 20);
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

test("the human-selected ladder delegates outside the main session's model scope", async () => {
  const { client, agentDir, dispose } = await host({
    WORKER_TEST_TWO_MODELS: "1",
    WORKER_TEST_PICK_MODEL: "worker-test/other",
  });
  try {
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

test("research refinements recheck availability through the common admission guard", async () => {
  const { client, agentDir, dispose } = await host(
    { WORKER_TEST_TWO_MODELS: "1" },
    undefined,
    true,
    false,
  );
  try {
    const ready = await proposal(client, "6");
    const before = await readFile(ready.task.sessionFile, "utf8");
    await client.setModel("worker-test", "other");
    expect(await client.prompt("/test-remove-setup-model")).toBe("handled");
    expect(
      (await client.getAvailableModels()).some((model) => model.id === "fake"),
    ).toBe(false);
    expect(await client.prompt("integration:refine-proposal")).toBe("handled");
    await eventually(async () =>
      expect(JSON.stringify(await client.getMessages())).toContain(
        "retained execution is no longer available",
      ),
    );
    expect(await readFile(ready.task.sessionFile, "utf8")).toBe(before);
    await expect(
      readFile(join(agentDir, "pi-sub-config.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await dispose();
  }
}, 20000);

test("cancelling the candidate dialog never creates a task or configuration", async () => {
  const { client, agentDir, dispose } = await host(
    { WORKER_TEST_PICKER_CANCEL: "1" },
    undefined,
    false,
  );
  try {
    expect(await client.prompt("/sub:models")).toBe("handled");
    expect((await client.getSessionStats()).assistantMessages).toBe(0);
    await expect(
      readFile(join(agentDir, "pi-sub-config.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await client.getMessages()).some(
        (message) =>
          message.role === "custom" &&
          message.customType === "pi-sub:models" &&
          !!message.details,
      ),
    ).toBe(false);
  } finally {
    await dispose();
  }
}, 20000);

test("real input cannot accept the candidate stage and cancel dismisses its pending dialog", async () => {
  const { client, agentDir, dispose } = await host(
    { WORKER_TEST_PICKER_HOLD: "1" },
    undefined,
    false,
  );
  const dialog = nextEvent(client, (event) => {
    const ui = event as unknown as { type: string; method?: string };
    return ui.type === "extension_ui_request" && ui.method === "select";
  });
  try {
    const opening = client.prompt("/sub:models");
    await dialog.promise;
    expect(await client.prompt("accept")).toBe("handled");
    expect((await client.getSessionStats()).assistantMessages).toBe(0);
    await expect(
      readFile(join(agentDir, "pi-sub-config.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await client.prompt("cancel")).toBe("handled");
    expect(await opening).toBe("handled");
  } finally {
    dialog.dispose();
    await dispose();
  }
}, 20000);

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
    const path = join(agentDir, "pi-sub-config.json");
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await client.prompt("accept")).toBe("handled");
    await eventually(async () =>
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
        "7": "worker-test/fake:off",
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
    const path = join(agentDir, "pi-sub-config.json"),
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
      readFile(join(agentDir, "pi-sub-config.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await client.prompt("accept")).toBe("handled");
    expect(
      JSON.parse(await readFile(join(agentDir, "pi-sub-config.json"), "utf8")),
    ).toHaveProperty("6");
  } finally {
    refused.dispose();
    await dispose();
  }
}, 60000);

test("acceptance never clobbers a config edited while its proposal was open", async () => {
  const { client, agentDir, dispose } = await host({}, undefined, true, false);
  try {
    const path = join(agentDir, "pi-sub-config.json"),
      manual = JSON.stringify({
        "9": "worker-test/fake:off",
      });
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

test("two working directories share the profile ladder without project overrides", async () => {
  const first = await host();
  let second: Awaited<ReturnType<typeof host>> | undefined;
  try {
    second = await host({}, first.agentDir, false);
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
