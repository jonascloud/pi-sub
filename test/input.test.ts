import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import type { TaskResult, TaskView } from "../src/coordinator.ts";
import piSub from "../index.ts";
import * as models from "../src/models.ts";
import * as workers from "../src/worker.ts";
import { SUBAGENT_GUIDANCE } from "../src/messages.ts";
import { replyBatch, taskReport } from "../src/replies.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

const fake = vi.hoisted(() => ({
  interrupted: false,
  runnable: true,
  idle: true,
  tasks: [] as TaskView[],
  prompt:
    vi.fn<(deliver: (failures: TaskResult[]) => void) => Promise<boolean>>(),
  interrupt: vi.fn<() => Promise<void>>(),
  onReady: undefined as ((task: TaskView) => void) | undefined,
  start: vi.fn(),
  stop: vi.fn(),
  markDelivered: vi.fn(),
}));
vi.mock("../src/coordinator.ts", () => ({
  Coordinator: class {
    constructor(options: { onReady: (task: TaskView) => void }) {
      fake.onReady = options.onReady;
    }
    get interrupted() {
      return fake.interrupted;
    }
    get runnable() {
      return fake.runnable;
    }
    prompt = fake.prompt;
    interrupt = fake.interrupt;
    start = fake.start;
    stop = fake.stop;
    markDelivered = fake.markDelivered;
    get = () => ({ id: "new-task" });
    drainUsage = () => undefined;
    list = () => [...fake.tasks].reverse();
    subscribe = () => () => {};
    dispose = async () => {};
  },
}));
vi.mock("../src/widget.ts", () => ({ mountWidget: () => () => {} }));

afterEach(async () => {
  await flushReplies();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.stubEnv("PI_SUB_CHILD", "");
  fake.interrupted = false;
  fake.runnable = true;
  fake.idle = true;
  fake.tasks = [];
  fake.start.mockReset().mockReturnValue("new-task");
  fake.stop.mockReset();
  fake.markDelivered.mockReset().mockImplementation((id, replyId) => {
    const task = fake.tasks.find(
      (task) => task.id === id && task.reply?.id === replyId,
    );
    if (task?.reply) task.reply.delivered = true;
  });
  fake.prompt.mockReset().mockResolvedValue(true);
  fake.interrupt.mockReset().mockImplementation(async () => {
    fake.interrupted = true;
    fake.runnable = false;
  });
});

function setup(mode = "rpc") {
  const handlers = new Map<
    string,
    (event: any, ctx: ExtensionContext) => any
  >();
  const commands = new Map<
    string,
    { handler: (args: string, ctx: ExtensionContext) => Promise<void> }
  >();
  const tools = new Map<
    string,
    ToolRenderers & {
      description: string;
      execute: (...args: any[]) => Promise<any>;
    }
  >();
  const messages: AgentMessage[] = [];
  const sendMessage = vi.fn((message) => {
    messages.push({ ...message, role: "custom", timestamp: 0 });
  });
  const registerMessageRenderer = vi.fn();
  const notify = vi.fn();
  const abort = vi.fn();
  let terminalInput: ((data: string) => unknown) | undefined;
  const ctx = {
    mode,
    hasUI: true,
    abort,
    isIdle: () => fake.idle,
    sessionManager: {
      getBranch: () =>
        messages.flatMap((message, index) =>
          message.role === "custom"
            ? [{ ...message, type: "custom_message", id: String(index) }]
            : [],
        ),
      buildSessionProjection: () => ({ messages }),
    },
    isProjectTrusted: () => true,
    ui: {
      notify,
      setWidget: vi.fn(),
      setEditorText: vi.fn(),
      onTerminalInput: (listener: typeof terminalInput) => {
        terminalInput = listener;
        return () => {};
      },
    },
  } as unknown as ExtensionContext;
  piSub({
    on: (name: string, handler: (event: any, ctx: ExtensionContext) => any) =>
      handlers.set(name, handler),
    registerCommand: (name: string, command: any) =>
      commands.set(name, command),
    registerMessageRenderer,
    registerTool: (tool: {
      name: string;
      description: string;
      execute: (...args: any[]) => Promise<any>;
    }) => tools.set(tool.name, tool),
    sendMessage,
  } as unknown as ExtensionAPI);
  const emit = (type: string, fields: Record<string, unknown> = {}) => {
    const handler = handlers.get(type);
    if (!handler) throw new Error(`No handler for ${type}`);
    return handler(
      {
        type,
        ...(["turn_end", "agent_before_settle"].includes(type)
          ? {
              entries: [],
              continue: false,
              outcome: "completed",
              context: { contextMessages: messages, pendingMessages: [] },
            }
          : {}),
        ...fields,
      },
      ctx,
    );
  };
  emit("session_start");
  return {
    ctx,
    emit,
    commands,
    tools,
    sendMessage,
    notify,
    abort,
    registerMessageRenderer,
    messages,
    ready(task: TaskView) {
      fake.tasks = [...fake.tasks.filter((old) => old.id !== task.id), task];
      fake.onReady!(task);
    },
    key: (data: string) => terminalInput!(data),
  };
}

const failure: TaskResult = {
  id: "failed",
  level: 1,
  description: "test task",
  sessionFile: "native.jsonl",
  execution: { provider: "test", model: "fake", thinking: "off" },
  turns: 0,
  toolUses: 0,
  tokens: 0,
  elapsedMs: 0,
  response: "",
  outcome: "error",
  error: "worker exited",
};

test("every subagent tool and transcript message has a native renderer", () => {
  const { tools, registerMessageRenderer } = setup();
  for (const tool of tools.values()) {
    expect(tool.renderCall).toBeTypeOf("function");
    expect(tool.renderResult).toBeTypeOf("function");
  }
  expect(
    registerMessageRenderer.mock.calls.map(([name]) => name).sort(),
  ).toEqual(["pi-sub:failures", "pi-sub:response", "pi-sub:stopped"]);
});

test("operator stop preserves machine-readable content and supplies presentation metadata", async () => {
  const { commands, ctx, sendMessage } = setup();
  const report = { ...failure, outcome: "stopped" as const };
  fake.stop.mockResolvedValue(report);
  await commands.get("sub:stop")!.handler("failed", ctx);
  expect(sendMessage).toHaveBeenCalledWith(
    {
      customType: "pi-sub:stopped",
      display: true,
      content: JSON.stringify([taskReport(report)]),
      details: [report],
    },
    { triggerTurn: false },
  );
});

test("tool handoffs omit diagnostics, retain full details and locate truncated responses", async () => {
  const { tools, ctx } = setup();
  const report = {
    ...failure,
    response: "Partial result",
    pendingInput: ["Unsent correction"],
  };
  for (const response of [report.response, "x".repeat(60000)]) {
    const value = { ...report, response };
    fake.stop.mockResolvedValue(value);
    const result = await tools
      .get("sub_control")!
      .execute(
        "stop",
        { id: value.id, action: "stop" },
        new AbortController().signal,
        () => {},
        ctx,
      );
    expect(result.details).toEqual(value);
    const text = result.content[0].text;
    if (response.length < 60000) {
      expect(JSON.parse(text)).toEqual({
        id: value.id,
        description: value.description,
        outcome: "error",
        response,
        error: value.error,
        pendingInput: value.pendingInput,
      });
      expect(text).not.toContain(value.sessionFile);
    } else {
      expect(text).toContain("[Truncated; full responses: native.jsonl]");
      expect(text.length).toBeLessThan(response.length);
    }
  }
});

test.each(["interactive", "rpc"])(
  "%s input delegates cleanup and forwards its report without a model turn",
  async (source) => {
    const { emit, sendMessage } = setup();
    fake.prompt.mockImplementation(async (deliver) => {
      deliver([failure]);
      return true;
    });
    expect(await emit("input", { source, text: "continue" })).toBeUndefined();
    expect(fake.prompt).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        customType: "pi-sub:failures",
        details: [failure],
        content: expect.stringContaining("Collected failures:"),
      }),
      { triggerTurn: false },
    );
  },
);

test("new tasks select from fresh configuration after asynchronous directory preparation", async () => {
  const { ctx, tools } = setup();
  vi.spyOn(models, "availableModels").mockReturnValue([
    { provider: "test", model: "fake", thinking: ["off"] },
    { provider: "test", model: "other", thinking: ["off"] },
  ]);
  const load = vi
    .spyOn(models, "loadLadder")
    .mockReturnValue({ "6": "test/fake:off" });
  const directory = Promise.withResolvers<string>();
  vi.spyOn(workers, "workerDirectory").mockReturnValue(directory.promise);
  const pending = tools
    .get("sub_task")!
    .execute(
      "call",
      { level: 3, prompt: "brief" },
      new AbortController().signal,
      () => {},
      ctx,
    );
  load.mockReturnValue({ "6": "test/other:off" });
  directory.resolve("/tmp/sessions");
  await pending;
  expect(fake.start).toHaveBeenCalledWith(
    expect.objectContaining({
      worker: expect.objectContaining({ model: "other" }),
    }),
  );
});

test("cancellation during runtime directory preparation never admits an orphan task", async () => {
  const { ctx, tools } = setup();
  vi.spyOn(models, "availableModels").mockReturnValue([
    { provider: "test", model: "fake", thinking: ["off"] },
  ]);
  vi.spyOn(models, "loadLadder").mockReturnValue({
    "6": "test/fake:off",
  });
  const directory = Promise.withResolvers<string>();
  const prepare = vi
    .spyOn(workers, "workerDirectory")
    .mockReturnValue(directory.promise);
  const controller = new AbortController();
  const pending = tools
    .get("sub_task")!
    .execute(
      "call",
      { level: 3, prompt: "brief" },
      controller.signal,
      () => {},
      ctx,
    );
  expect(prepare).toHaveBeenCalledOnce();
  controller.abort();
  directory.resolve("/fixture/.pi/pi-sub/sessions");
  expect(await pending).toMatchObject({ isError: true });
  expect(fake.start).not.toHaveBeenCalled();
});

test("extension input neither sweeps failures nor reopens admission", async () => {
  const { emit, sendMessage } = setup();
  fake.interrupted = true;
  await emit("input", { source: "extension", text: "notification" });
  expect(fake.prompt).not.toHaveBeenCalled();
  expect(fake.interrupted).toBe(true);
  expect(sendMessage).not.toHaveBeenCalled();
});

test("a cancelled prompt handoff is handled, including interruption during pending cleanup", async () => {
  const { emit } = setup();
  const pending = Promise.withResolvers<boolean>();
  fake.prompt.mockReturnValue(pending.promise);
  const input = emit("input", { source: "rpc", text: "next" });
  await emit("agent_settled", { aborted: true });
  pending.resolve(false); // The coordinator's epoch check rejects the interrupted handoff.
  expect(await input).toEqual({ action: "handled" });
  expect(fake.interrupted).toBe(true);
  expect(fake.prompt).toHaveBeenCalledOnce();
});

test("settled abort interrupts without a live signal (retry backoff)", () => {
  const { emit } = setup();
  emit("agent_settled", { aborted: false });
  expect(fake.interrupt).not.toHaveBeenCalled();
  emit("agent_settled", { aborted: true });
  expect(fake.interrupt).toHaveBeenCalledOnce();
});

test("signal abort and settlement do not duplicate the interruption fallback", () => {
  const { emit, ctx } = setup();
  const controller = new AbortController();
  Object.assign(ctx, { signal: controller.signal });
  emit("turn_start", { turnIndex: 0, timestamp: 0 });
  controller.abort();
  emit("agent_settled", { aborted: true });
  expect(fake.interrupt).toHaveBeenCalledOnce();
});

test("compaction's own signal interrupts children", () => {
  const { emit } = setup();
  const controller = new AbortController();
  emit("session_before_compact", { signal: controller.signal });
  controller.abort();
  expect(fake.interrupt).toHaveBeenCalledOnce();
});

test("a later manual compaction abort is not suppressed by a previously interrupted run", () => {
  const { emit } = setup();
  emit("agent_settled", { aborted: true });
  fake.interrupted = false; // An explicit operator continuation reopened admission without a new parent run.
  const controller = new AbortController();
  emit("session_before_compact", { signal: controller.signal });
  controller.abort();
  expect(fake.interrupt).toHaveBeenCalledTimes(2);
});

test("a custom notification cannot restart an interrupted parent", () => {
  const { emit, abort } = setup();
  fake.interrupted = true;
  emit("before_agent_start", {
    prompt: "child notification",
    systemPromptOptions: { sections: {} },
  });
  expect(abort).toHaveBeenCalledOnce();
  expect(fake.prompt).not.toHaveBeenCalled();
});

test("one stable guidance section is replaced, not appended as repeated chat instructions", () => {
  const { emit, sendMessage, tools } = setup();
  const load = vi.spyOn(models, "loadLadder").mockReturnValue({
    "6": "test/fake:off",
    "10": "test/unavailable:off",
  });
  const available = vi
    .spyOn(models, "availableModels")
    .mockReturnValue([{ provider: "test", model: "fake", thinking: ["off"] }]);
  const systemPromptOptions = { sections: { pi_sub: "old section" } };
  emit("before_agent_start", { systemPromptOptions });
  const first = systemPromptOptions.sections.pi_sub;
  emit("before_agent_start", { systemPromptOptions });
  expect(systemPromptOptions.sections.pi_sub).toBe(first);
  expect(first.split(SUBAGENT_GUIDANCE)).toHaveLength(2);
  expect(first).toContain(models.STRENGTH_GUIDANCE);
  expect(first).toBe(
    `${SUBAGENT_GUIDANCE}\n\nAvailable ladder levels (snapshot): 1–6.`,
  );
  load.mockReturnValue({ "8": "test/fake:off" });
  emit("before_agent_start", { systemPromptOptions });
  expect(systemPromptOptions.sections.pi_sub).toContain(
    "levels (snapshot): 1–8.",
  );
  expect(systemPromptOptions.sections.pi_sub).not.toContain("1–6.");
  fake.tasks = [
    {
      ...failure,
      status: "ready",
      activity: "",
      reply: { id: "internal-reply-id", delivered: false },
    },
  ];
  emit("before_agent_start", { systemPromptOptions });
  const snapshot =
    systemPromptOptions.sections.pi_sub.split("\n\nOpen tasks: ")[1]!;
  expect(JSON.parse(snapshot)).toEqual([
    {
      id: failure.id,
      description: failure.description,
      status: "ready",
      outcome: "error",
    },
  ]);
  expect(sendMessage).not.toHaveBeenCalled();
  expect(
    [...tools.values()].reduce((n, tool) => n + tool.description.length, 0),
  ).toBeLessThan(500);
  expect(tools.get("sub_result")!.description).toContain("finish:true");
  available.mockReturnValue([]);
  emit("before_agent_start", { systemPromptOptions });
  expect(systemPromptOptions.sections.pi_sub).toContain(
    "levels (snapshot): none.",
  );
  load.mockImplementation(() => {
    throw new Error("Invalid ladder");
  });
  emit("before_agent_start", { systemPromptOptions });
  expect(systemPromptOptions.sections.pi_sub).toContain(
    "Delegation unavailable: Invalid ladder",
  );
  expect(systemPromptOptions.sections.pi_sub).not.toContain(
    "levels (snapshot):",
  );
});

test.each(["interactive", "rpc"])(
  "%s input has no ladder setup mode or reserved confirmation words",
  async (source) => {
    const { commands, emit, sendMessage, ctx } = setup();
    expect([...commands.keys()].sort()).toEqual([
      "sub:continue",
      "sub:pause",
      "sub:stop",
    ]);
    for (const text of [
      "accept",
      "cancel",
      "Use a cheaper model",
      "/sub:models",
    ])
      expect(await emit("input", { source, text })).toBeUndefined();
    expect(fake.prompt).toHaveBeenCalledTimes(4);
    expect(fake.start).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(ctx.ui.setWidget).not.toHaveBeenCalled();
    expect(ctx.ui.setEditorText).not.toHaveBeenCalled();
  },
);

test("failed input cleanup reports the failure and does not forward the prompt", async () => {
  const { emit, notify } = setup();
  fake.prompt.mockRejectedValue(new Error("Could not close worker"));
  expect(await emit("input", { source: "rpc", text: "accept" })).toEqual({
    action: "handled",
  });
  expect(notify).toHaveBeenCalledWith(
    expect.stringContaining("Could not close worker"),
    "error",
  );
});

test("global /sub:pause interrupts headless work and aborts the parent", async () => {
  const { commands, ctx, abort } = setup();
  await commands.get("sub:pause")!.handler("", ctx);
  expect(fake.interrupt).toHaveBeenCalled();
  expect(abort).toHaveBeenCalledOnce();
  expect(fake.prompt).not.toHaveBeenCalled();
});

test("TUI Escape is global except while a dialog owns Escape", () => {
  const { emit, key, abort } = setup("tui");
  emit("ui_prompt_start", { reason: "ui_prompt", kind: "confirm" });
  key("\u001b");
  expect(fake.interrupt).not.toHaveBeenCalled();
  expect(abort).not.toHaveBeenCalled();
  emit("ui_prompt_end", { reason: "ui_prompt", kind: "confirm" });
  key("\u001b");
  expect(fake.interrupt).toHaveBeenCalledOnce();
  expect(abort).toHaveBeenCalledOnce();
});

test("terminal errors notify the human, never trigger the parent LLM", () => {
  const { emit, notify, sendMessage } = setup();
  emit("agent_start"); // Lazily constructs the actual factory's coordinator callbacks.
  fake.runnable = false;
  fake.onReady!({ ...failure, status: "ready", level: 1, activity: "" });
  expect(notify).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("worker exited"),
    "error",
  );
  expect(sendMessage).not.toHaveBeenCalled();
});

const flushReplies = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

test("announcing a batch is not delivery; only complete parent context messages count", async () => {
  const { emit, sendMessage, ready } = setup();
  emit("agent_start");
  const reply: TaskView = {
    ...failure,
    outcome: "reply",
    error: undefined,
    response: "Question?",
    status: "ready",
    level: 1,
    activity: "",
    reply: { id: "reply-1", delivered: false },
  };
  ready(reply);
  await flushReplies();
  expect(sendMessage).toHaveBeenCalledOnce();
  expect(fake.markDelivered).not.toHaveBeenCalled();
  emit("context", { messages: [] });
  expect(fake.markDelivered).not.toHaveBeenCalled();
  const message = { ...replyBatch([reply])!, role: "custom", timestamp: 0 };
  emit("context", { messages: [{ ...message, content: "preview" }] });
  expect(fake.markDelivered).not.toHaveBeenCalled();
  emit("context", { messages: [message] });
  expect(fake.markDelivered).toHaveBeenCalledExactlyOnceWith(
    reply.id,
    "reply-1",
  );
});

test("ordinary ready replies wake an idle parent only while runnable", async () => {
  const { emit, sendMessage, ready } = setup();
  emit("agent_start");
  const reply: TaskView = {
    ...failure,
    outcome: "reply",
    error: undefined,
    response: "Question?",
    status: "ready",
    level: 1,
    activity: "",
    reply: { id: "idle-reply", delivered: false },
  };
  fake.runnable = false;
  ready(reply);
  await flushReplies();
  expect(sendMessage).not.toHaveBeenCalled();
  fake.runnable = true;
  ready(reply);
  await flushReplies();
  expect(sendMessage).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      customType: "pi-sub:response",
      content: expect.stringContaining("Question?"),
    }),
    { triggerTurn: true },
  );
});

const readyReply = (id: string): TaskView => ({
  ...failure,
  id,
  description: id,
  error: undefined,
  response: `Answer from ${id}`,
  level: 1,
  status: "ready",
  outcome: "reply",
  activity: "",
  reply: { id: `${id}-reply`, delivered: false },
});

test("same-cycle idle replies form one batch and one wakeup, not queued follow-ups", async () => {
  const { emit, ready, sendMessage, messages } = setup();
  emit("agent_start");
  ready(readyReply("a"));
  ready(readyReply("b"));
  expect(sendMessage).not.toHaveBeenCalled();
  await flushReplies();
  expect(sendMessage).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      details: {
        replies: [
          expect.objectContaining({ id: "a" }),
          expect.objectContaining({ id: "b" }),
        ],
      },
    }),
    { triggerTurn: true },
  );
  expect(fake.markDelivered).not.toHaveBeenCalled();
  emit("agent_settled", { aborted: false });
  await flushReplies();
  expect(sendMessage).toHaveBeenCalledOnce(); // Native history remembers the announcement.
  emit("context", { messages });
  expect(fake.markDelivered).toHaveBeenCalledTimes(2);
});

test("active replies join the next safe boundary, preserving other drafts and one continuation", async () => {
  const { emit, ready, sendMessage } = setup();
  emit("agent_start");
  fake.idle = false;
  ready(readyReply("a"));
  ready(readyReply("b"));
  await flushReplies();
  expect(sendMessage).not.toHaveBeenCalled();
  const previous = { type: "custom", customType: "other", data: true };
  const result = emit("turn_end", { entries: [previous], continue: true });
  expect(result.continue).toBe(true);
  expect(result.entries).toHaveLength(2);
  expect(result.entries[0]).toBe(previous);
  expect(result.entries[1]).toMatchObject({
    type: "custom_message",
    details: { replies: [{ id: "a" }, { id: "b" }] },
  });
  expect(fake.markDelivered).not.toHaveBeenCalled();
  expect(sendMessage).not.toHaveBeenCalled();
});

test("a complete same-turn tool return suppresses its notification without accepting it", () => {
  const { emit, ready } = setup();
  emit("agent_start");
  fake.idle = false;
  const a = readyReply("a"),
    b = readyReply("b");
  ready(a);
  ready(b);
  const message: AgentMessage = {
    role: "toolResult",
    toolName: "sub_result",
    toolCallId: "read-a",
    timestamp: 0,
    isError: false,
    details: JSON.parse(JSON.stringify(a)),
    content: [{ type: "text", text: JSON.stringify(a) }],
  };
  const result = emit("turn_end", {
    context: { contextMessages: [message], pendingMessages: [] },
  });
  expect(result.entries[0].details.replies).toHaveLength(1);
  expect(result.entries[0].details.replies[0].id).toBe("b");
  expect(fake.tasks).toHaveLength(2);
  expect(fake.markDelivered).not.toHaveBeenCalled();
  emit("context", { messages: [message] });
  expect(a.reply!.delivered).toBe(true);
});

test("flushes use current identities and omit accepted, stopped and superseded replies", async () => {
  const { emit, ready, sendMessage } = setup();
  emit("agent_start");
  ready(readyReply("accepted"));
  ready(readyReply("stopped"));
  ready(readyReply("changed"));
  const next = {
    ...readyReply("changed"),
    response: "Successor",
    reply: { id: "successor", delivered: false },
  };
  fake.tasks = [next];
  await flushReplies();
  expect(sendMessage).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      details: {
        replies: [
          expect.objectContaining({
            id: "changed",
            response: "Successor",
            reply: { id: "successor", delivered: false },
          }),
        ],
      },
    }),
    { triggerTurn: true },
  );
});

test("interruption retains unannounced replies and cannot wake the parent", async () => {
  const { emit, ready, sendMessage } = setup();
  emit("agent_start");
  ready(readyReply("a"));
  emit("agent_settled", { aborted: true });
  await flushReplies();
  expect(sendMessage).not.toHaveBeenCalled();
  expect(emit("turn_end")).toBeUndefined();
  fake.runnable = true;
  fake.interrupted = false;
  expect(emit("turn_end").entries[0].details.replies[0].id).toBe("a");
});

test("late replies can join the settlement boundary and truncated announcements are not repeated", async () => {
  const { emit, ready, sendMessage } = setup();
  emit("agent_start");
  fake.idle = false;
  expect(emit("turn_end")).toBeUndefined();
  const a = { ...readyReply("a"), response: "x".repeat(20000) };
  ready(a);
  const result = emit("agent_before_settle");
  expect(result.continue).toBe(true);
  const notification = {
    ...replyBatch([a])!,
    role: "custom" as const,
    timestamp: 0,
  };
  expect(
    emit("turn_end", {
      context: { contextMessages: [notification], pendingMessages: [] },
    }),
  ).toBeUndefined();
  emit("context", { messages: [notification] });
  expect(a.reply!.delivered).toBe(false);
  await flushReplies();
  expect(sendMessage).not.toHaveBeenCalled();
});

test("input preparation retries replies that arrived while admission was temporarily closed", async () => {
  const { emit, ready, sendMessage } = setup();
  emit("agent_start");
  fake.prompt.mockImplementation(async () => {
    fake.runnable = false;
    ready(readyReply("during-preparation"));
    fake.runnable = true;
    return true;
  });
  await emit("input", { source: "rpc", text: "next user prompt" });
  await flushReplies();
  expect(sendMessage).toHaveBeenCalledOnce();
});

test("a boundary proposal neither acknowledges nor dequeues replies before native commit", () => {
  const { emit, ready, messages } = setup();
  emit("agent_start");
  fake.idle = false;
  ready(readyReply("a"));
  const proposed = emit("turn_end");
  expect(emit("turn_end")).toEqual(proposed); // A dropped proposal can be retried.
  messages.push({ ...proposed.entries[0], role: "custom", timestamp: 0 });
  expect(emit("agent_before_settle")).toBeUndefined();
  expect(fake.markDelivered).not.toHaveBeenCalled();
});

test.each(["error", "aborted"])(
  "a %s boundary does not request reply continuation",
  (outcome) => {
    const { emit, ready, ctx } = setup();
    emit("agent_start");
    fake.idle = false;
    ready(readyReply("a"));
    expect(emit("turn_end", { outcome })).toBeUndefined();
    Object.assign(ctx, { signal: AbortSignal.abort() });
    expect(emit("turn_end")).toBeUndefined();
  },
);

test("shutdown cancels a scheduled idle flush", async () => {
  const { emit, ready, sendMessage } = setup();
  emit("agent_start");
  ready(readyReply("a"));
  await emit("session_shutdown");
  await flushReplies();
  expect(sendMessage).not.toHaveBeenCalled();
});
