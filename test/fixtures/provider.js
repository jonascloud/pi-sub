import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { writeFileSync } from "node:fs";

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
  if (
    process.env.WORKER_TEST_INTEGRATION &&
    process.env.PI_SUB_CHILD === "1" &&
    text.includes("Approved snapshot (copy exactly into approved):")
  ) {
    const approved = JSON.parse(
      text
        .split("Approved snapshot (copy exactly into approved):\n")[1]
        .split("\n\nReturn only")[0],
    );
    return {
      text: JSON.stringify({
        version: 1,
        methodVersion: 1,
        generatedAt: new Date().toISOString(),
        approved,
        candidates: approved.flatMap((model) =>
          model.thinking.map((thinking) => ({
            provider: model.provider,
            model: model.model,
            thinking,
            power: 6,
            cost: 0.1,
            score: 30,
            source: "https://artificialanalysis.ai/models/test-only",
            retrievedAt: new Date().toISOString(),
            rationale:
              "Synthetic evidence for local integration tests, not a real model assessment.",
            selected: thinking === "off",
          })),
        ),
      }),
    };
  }
  if (process.env.WORKER_TEST_INTEGRATION && process.env.PI_SUB_CHILD !== "1") {
    const results = messages
      .slice(index + 1)
      .filter((message) => message.role === "toolResult");
    if (
      [
        "integration:delegate",
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
      text === "integration:delegate" &&
      results.at(-1)?.toolName === "sub_task"
    ) {
      const task = JSON.parse(
        results.at(-1).content.find((part) => part.type === "text").text,
      );
      return {
        name: "sub_result",
        args: { id: task.id, wait: true, timeout: 15, finish: true },
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
  pi.registerProvider("worker-test", {
    baseUrl: "http://localhost",
    apiKey: "test",
    api: "worker-test-api",
    models: [
      {
        id: "fake",
        name: "Fake",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100000,
        maxTokens: 10000,
      },
    ],
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
            JSON.stringify(message.content).includes("Approved snapshot"),
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
          if (output.name) {
            const toolCall = {
              type: "toolCall",
              id: `call-${Date.now()}`,
              name: output.name,
              arguments: output.args,
            };
            message.content.push(toolCall);
            message.stopReason = "toolUse";
            stream.push({
              type: "toolcall_start",
              contentIndex: 0,
              partial: message,
            });
            stream.push({
              type: "toolcall_delta",
              contentIndex: 0,
              delta: JSON.stringify(output.args),
              partial: message,
            });
            stream.push({
              type: "toolcall_end",
              contentIndex: 0,
              toolCall,
              partial: message,
            });
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
