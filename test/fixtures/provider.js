import {
  contentText,
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const child = process.env.PI_SUB_CHILD === "1";
const large = child && process.env.WORKER_TEST_LARGE_CHILD;
const call = (...tools) =>
  fauxAssistantMessage(tools, { stopReason: "toolUse" });
const task = (
  level = 3,
  prompt = "Return a test response.",
  description = "Test task",
) => fauxToolCall("sub_task", { level, prompt, description });

function reply({ messages }) {
  const user = messages.findLastIndex((m) => m.role === "user");
  const prompt = contentText(messages[user]?.content ?? "", "");
  const last = messages
    .slice(user + 1)
    .findLast((m) => m.role === "toolResult");
  const taskId = () =>
    JSON.parse(
      contentText(
        messages.findLast(
          (m) => m.role === "toolResult" && m.toolName === "sub_task",
        ).content,
      ),
    ).id;

  if (child) {
    if (prompt === "integration:child-error")
      throw new Error(
        "fatal synthetic failure" +
          (large
            ? "\n" +
              "Failure evidence 漢字\n".repeat(4000) +
              "END_OF_FAILURE_REPORT"
            : ""),
      );
    if (prompt === "integration:permission")
      return last
        ? fauxAssistantMessage("Permission denied")
        : call(fauxToolCall("protected_action", {}));
    if (large)
      return fauxAssistantMessage(
        "Large report\n" +
          "Evidence line 漢字\n".repeat(4000) +
          "END_OF_LARGE_REPORT",
      );
  } else if (prompt.startsWith("integration:")) {
    const [, scenario, arg, offset] = prompt.split(":");
    if (!last) {
      switch (scenario) {
        case "batch":
          return call(
            task(3, undefined, "First review"),
            task(3, undefined, "Second review"),
            fauxToolCall("bash", {
              command: "while [ ! -f parent-release ]; do sleep 0.05; done",
              timeout: 20,
            }),
          );
        case "report":
          return call(
            fauxToolCall("sub_result", {
              report: arg,
              offset: Number(offset),
              limit: 4096,
            }),
          );
        case "inspect":
          return call(fauxToolCall("sub_result", { id: taskId() }));
        case "continue":
          return call(
            fauxToolCall("sub_control", { id: taskId(), action: "continue" }),
          );
        case "refine-task":
          return call(
            fauxToolCall("sub_message", {
              id: taskId(),
              message: "Check the production schema.",
            }),
          );
        case "accept":
          return call(
            fauxToolCall("sub_result", {
              id: taskId(),
              wait: true,
              timeout: 15,
              finish: true,
            }),
          );
        case "level":
          return call(task(Number(arg)));
        case "failure":
          return call(task(3, "integration:child-error"));
        case "delegate":
        case "read-via-wait":
        case "notify":
        case "probe-global":
        case "pause":
        case "retry":
          return call(task());
        default:
          throw new Error(`Unknown test scenario: ${scenario}`);
      }
    }
    if (last.toolName === "sub_task") {
      if (scenario === "retry") throw new Error("429 rate limit test");
      if (scenario === "delegate" || scenario === "read-via-wait")
        return call(
          fauxToolCall("sub_result", {
            id: taskId(),
            wait: true,
            timeout: 15,
            finish: scenario === "delegate",
          }),
        );
    }
  }
  return fauxAssistantMessage("fake response");
}

async function respond(context, { signal } = {}) {
  if (child && process.env.WORKER_TEST_SLOW_CHILD) {
    if (process.env.WORKER_TEST_CHILD_MARKER)
      writeFileSync(process.env.WORKER_TEST_CHILD_MARKER, "running");
    try {
      await delay(10000, undefined, { signal });
    } catch (error) {
      if (!signal?.aborted) throw error;
      return fauxAssistantMessage(""); // Faux emits the native abort event.
    }
  }
  const crashed = process.env.WORKER_TEST_CRASH_ONCE;
  if (crashed && !existsSync(crashed)) {
    writeFileSync(crashed, "crashed");
    process.exit(42);
  }
  if (
    process.env.WORKER_TEST_CRASH_AFTER_RESPONSE &&
    context.messages.some((m) => m.role === "assistant")
  )
    process.exit(42);
  return reply(context);
}

export default function (pi) {
  const faux = createFauxCore({
    provider: "worker-test",
    models: (process.env.WORKER_TEST_TWO_MODELS
      ? ["fake", "other"]
      : ["fake"]
    ).map((id) => ({ id, reasoning: true })),
    // Test large handoffs, not thousands of tiny streaming deltas.
    tokenSize: { min: 16384, max: 16384 },
  });
  pi.registerProvider("worker-test", {
    baseUrl: faux.models[0].baseUrl,
    apiKey: "test",
    api: faux.api,
    models: faux.models,
    streamSimple(model, context, options) {
      faux.appendResponses([respond]);
      return faux.streamSimple(model, context, options);
    },
  });
  if (child && process.env.WORKER_TEST_CHILD_PIDS)
    pi.on("session_start", (_event, ctx) => {
      const directory = join(ctx.cwd, "child-pids");
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, basename(ctx.sessionManager.getSessionFile())),
        String(process.pid),
      );
    });
  pi.registerCommand("dialog", {
    description: "test",
    handler: (_args, ctx) => ctx.ui.confirm("test", "test"),
  });
}
