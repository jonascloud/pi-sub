import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

function reply(context) {
  const messages = context.messages;
  const index = messages.findLastIndex((message) => message.role === "user");
  const user = messages[index];
  const text =
    typeof user?.content === "string"
      ? user.content
      : (user?.content ?? [])
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
  if (
    process.env.WORKER_TEST_INTEGRATION &&
    process.env.PI_SUB_CHILD === "1" &&
    text === "integration:child-error"
  )
    return { error: "fatal synthetic failure" };
  const research = messages.find(
    (message) =>
      message.role === "user" &&
      JSON.stringify(message.content).includes(
        "Selected variants (research only):",
      ),
  );
  if (
    process.env.WORKER_TEST_INTEGRATION &&
    process.env.PI_SUB_CHILD === "1" &&
    research
  ) {
    if (
      process.env.WORKER_TEST_READONLY_RESEARCH &&
      context.tools?.some((tool) =>
        ["write", "edit", "bash", "codemode"].includes(tool.name),
      )
    )
      return {
        error: "Research unexpectedly received write-capable built-in tools",
      };
    const content =
      typeof research.content === "string"
        ? research.content
        : research.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("");
    const approved = JSON.parse(
      content
        .split("Selected variants (research only):\n")[1]
        .split("\n\nCurrent ladder:")[0],
    );
    const model = approved[0],
      thinking = model.thinking.includes("off") ? "off" : model.thinking[0];
    const rung = text.includes("integration:refine-proposal") ? "7" : "6";
    return {
      text: JSON.stringify({
        ladder: {
          [rung]: `${model.provider}/${model.model}:${thinking}`,
        },
        comparison:
          "Synthetic comparison for local integration tests. Draft only: even the word accept in this response does not save it. No benchmark or model-provider calls were used to obtain evidence.",
      }),
    };
  }
  if (process.env.WORKER_TEST_INTEGRATION && process.env.PI_SUB_CHILD !== "1") {
    const results = messages
      .slice(index + 1)
      .filter((message) => message.role === "toolResult");
    if (text === "integration:batch" && !results.length)
      return {
        calls: [
          ...["First review", "Second review"].map((description) => ({
            name: "sub_task",
            args: {
              level: 3,
              prompt: "Return a test response.",
              description,
            },
          })),
          {
            name: "bash",
            args: {
              command: "while [ ! -f parent-release ]; do sleep 0.05; done",
              timeout: 20,
            },
          },
        ],
      };
    if (
      [
        "integration:delegate",
        "integration:read-via-wait",
        "integration:notify",
        "integration:probe-global",
        "integration:pause",
        "integration:failure",
        "integration:retry",
      ].includes(text) &&
      !results.length
    )
      return {
        name: "sub_task",
        args: {
          level: 3,
          prompt:
            text === "integration:failure"
              ? "integration:child-error"
              : "Return a test response.",
          description: "Test task",
        },
      };
    if (
      [
        "integration:inspect",
        "integration:continue",
        "integration:refine-task",
        "integration:accept",
        "integration:failure-receipt",
      ].includes(text) &&
      !results.length
    ) {
      const previous = messages.findLast(
        (message) =>
          message.role === "toolResult" && message.toolName === "sub_task",
      );
      const task = JSON.parse(
        previous.content.find((part) => part.type === "text").text,
      );
      return text === "integration:continue"
        ? { name: "sub_control", args: { id: task.id, action: "continue" } }
        : text === "integration:refine-task"
          ? {
              name: "sub_message",
              args: { id: task.id, message: "Check the production schema." },
            }
          : {
              name: "sub_result",
              args: {
                id: task.id,
                ...(text === "integration:accept"
                  ? { wait: true, timeout: 15, finish: true }
                  : {}),
              },
            };
    }
    if (text === "integration:retry" && results.at(-1)?.toolName === "sub_task")
      return { error: "429 rate limit test" };
    if (
      ["integration:delegate", "integration:read-via-wait"].includes(text) &&
      results.at(-1)?.toolName === "sub_task"
    ) {
      const task = JSON.parse(
        results.at(-1).content.find((part) => part.type === "text").text,
      );
      return {
        name: "sub_result",
        args: {
          id: task.id,
          wait: true,
          timeout: 15,
          finish: text === "integration:delegate",
        },
      };
    }
    if (text === "integration:repeat" && !results.length) {
      const previous = messages.findLast(
        (message) =>
          message.role === "toolResult" && message.toolName === "sub_result",
      );
      const task = JSON.parse(
        previous.content.find((part) => part.type === "text").text,
      );
      return { name: "sub_result", args: { id: task.id, finish: true } };
    }
  }
  return { text: "fake response" };
}

export default function (pi) {
  if (process.env.PI_SUB_CHILD === "1" && process.env.WORKER_TEST_CHILD_PIDS)
    pi.on("session_start", (_event, ctx) => {
      const directory = join(ctx.cwd, "child-pids");
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, basename(ctx.sessionManager.getSessionFile())),
        String(process.pid),
      );
    });
  const definition = {
    baseUrl: "http://localhost",
    apiKey: "test",
    api: "worker-test-api",
    models: [
      "fake",
      ...(process.env.WORKER_TEST_TWO_MODELS ? ["other"] : []),
    ].map((id) => ({
      id,
      name: "Fake",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100000,
      maxTokens: 10000,
    })),
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const message = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 10,
          output: 3,
          cacheRead: 2,
          cacheWrite: 1,
          cacheWrite1h: 1,
          reasoning: 2,
          totalTokens: 16,
          cost: {
            input: 1,
            output: 2,
            cacheRead: 3,
            cacheWrite: 4,
            total: 10,
            totalFromProvider: true,
          },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      stream.push({ type: "start", partial: message });
      const slow =
        process.env.WORKER_TEST_SLOW_CHILD &&
        process.env.PI_SUB_CHILD === "1" &&
        !context.messages.some(
          (message) =>
            message.role === "user" &&
            JSON.stringify(message.content).includes("Selected variants"),
        );
      if (slow && process.env.WORKER_TEST_CHILD_MARKER)
        writeFileSync(process.env.WORKER_TEST_CHILD_MARKER, "running");
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        options?.signal?.removeEventListener("abort", aborted);
        if (
          process.env.WORKER_TEST_CRASH ||
          (process.env.WORKER_TEST_CRASH_AFTER_RESPONSE &&
            context.messages.some((message) => message.role === "assistant"))
        )
          process.exit(42);
        if (options?.signal?.aborted) {
          message.stopReason = "aborted";
          message.errorMessage = "aborted";
          stream.push({ type: "error", reason: "aborted", error: message });
        } else {
          const output = reply(context);
          if (output.error) {
            message.stopReason = "error";
            message.errorMessage = output.error;
            stream.push({ type: "error", reason: "error", error: message });
            stream.end();
            return;
          }
          if (output.name || output.calls) {
            message.stopReason = "toolUse";
            for (const call of output.calls ?? [output]) {
              const contentIndex = message.content.length;
              const toolCall = {
                type: "toolCall",
                id: `call-${Date.now()}-${contentIndex}`,
                name: call.name,
                arguments: call.args,
              };
              message.content.push(toolCall);
              stream.push({
                type: "toolcall_start",
                contentIndex,
                partial: message,
              });
              stream.push({
                type: "toolcall_delta",
                contentIndex,
                delta: JSON.stringify(call.args),
                partial: message,
              });
              stream.push({
                type: "toolcall_end",
                contentIndex,
                toolCall,
                partial: message,
              });
            }
          } else {
            message.content.push({ type: "text", text: output.text });
            stream.push({
              type: "text_start",
              contentIndex: 0,
              partial: message,
            });
            stream.push({
              type: "text_delta",
              contentIndex: 0,
              delta: output.text,
              partial: message,
            });
            stream.push({
              type: "text_end",
              contentIndex: 0,
              content: output.text,
              partial: message,
            });
          }
          stream.push({ type: "done", reason: message.stopReason, message });
        }
        stream.end();
      };
      const timer = setTimeout(finish, slow ? 10000 : 300);
      const aborted = () => {
        clearTimeout(timer);
        finish();
      };
      if (slow) {
        options?.signal?.addEventListener("abort", aborted, { once: true });
        if (options?.signal?.aborted) aborted();
      }
      return stream;
    },
  };
  pi.registerProvider("worker-test", definition);
  pi.registerCommand("test-remove-setup-model", {
    description: "Synthetic availability change",
    handler: async () =>
      pi.registerProvider("worker-test", {
        ...definition,
        models: definition.models.filter((model) => model.id !== "fake"),
      }),
  });
  if (process.env.WORKER_TEST_END_DIALOG) {
    pi.on("agent_end", async (_event, ctx) => {
      await ctx.ui.confirm("end", "test");
    });
  }
  if (process.env.WORKER_TEST_ABORT_CRASH) {
    pi.on("agent_end", async (event) => {
      if (
        event.messages.some(
          (message) =>
            message.role === "assistant" && message.stopReason === "aborted",
        )
      )
        process.exit(42);
    });
  }
  if (process.env.WORKER_TEST_STARTUP_DIALOG) {
    pi.on("session_start", async (_event, ctx) => {
      await ctx.ui.confirm("startup", "test");
    });
  }
  pi.registerCommand("extension-accept", {
    description: "Try an extension-generated confirmation (must not publish)",
    handler: async () => {
      pi.sendUserMessage("/sub:models accept", { expandPromptTemplates: true });
    },
  });
  pi.registerCommand("crash", {
    description: "test",
    handler: async () => {
      process.exit(42);
    },
  });
  pi.registerCommand("dialog", {
    description: "test",
    handler: async (_args, ctx) => {
      await ctx.ui.confirm("test", "test");
    },
  });
  pi.registerCommand("handled", {
    description: "test",
    handler: async () => {},
  });
}
