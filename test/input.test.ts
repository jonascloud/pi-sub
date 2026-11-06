import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { TaskResult, TaskView } from "../src/coordinator.ts";
import piSub from "../index.ts";

const fake = vi.hoisted(() => ({
  interrupted: false,
  runnable: true,
  prompt:
    vi.fn<(deliver: (failures: TaskResult[]) => void) => Promise<boolean>>(),
  interrupt: vi.fn<() => Promise<void>>(),
  onReady: undefined as ((task: TaskView) => void) | undefined,
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
  },
}));
vi.mock("../src/widget.ts", () => ({ mountWidget: () => () => {} }));

afterEach(() => vi.unstubAllEnvs());

beforeEach(() => {
  vi.stubEnv("PI_SUB_CHILD", "");
  fake.interrupted = false;
  fake.runnable = true;
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
  const sendMessage = vi.fn();
  const notify = vi.fn();
  const abort = vi.fn();
  let terminalInput: ((data: string) => unknown) | undefined;
  const ctx = {
    mode,
    hasUI: true,
    abort,
    isProjectTrusted: () => true,
    ui: {
      notify,
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
    registerTool: vi.fn(),
    sendMessage,
  } as unknown as ExtensionAPI);
  const emit = (type: string, fields: Record<string, unknown> = {}) => {
    const handler = handlers.get(type);
    if (!handler) throw new Error(`No handler for ${type}`);
    return handler({ type, ...fields }, ctx);
  };
  emit("session_start");
  return {
    ctx,
    emit,
    commands,
    sendMessage,
    notify,
    abort,
    key: (data: string) => terminalInput!(data),
  };
}

const failure: TaskResult = {
  id: "failed",
  description: "test task",
  execution: { provider: "test", model: "fake", thinking: "off" },
  turns: 0,
  toolUses: 0,
  tokens: 0,
  elapsedMs: 0,
  response: "",
  outcome: "error",
  error: "worker exited",
};

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
        content: expect.stringContaining("No cleanup tool call is needed"),
      }),
      { triggerTurn: false },
    );
  },
);

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

test("model setup reserves admission before awaiting user-input cleanup", async () => {
  const { commands, ctx, notify } = setup();
  Object.assign(ctx, {
    model: { provider: "test", id: "fake", reasoning: false },
    thinkingLevel: "off",
  });
  const preparation = Promise.withResolvers<boolean>();
  fake.prompt.mockReturnValue(preparation.promise);
  const first = commands.get("sub:models")!.handler("", ctx);
  await commands.get("sub:models")!.handler("", ctx);
  expect(fake.prompt).toHaveBeenCalledOnce();
  expect(notify).toHaveBeenCalledWith(
    expect.stringContaining("already running"),
    "error",
  );
  preparation.resolve(false);
  await first;
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

test("ordinary ready replies trigger a follow-up only while runnable", () => {
  const { emit, sendMessage } = setup();
  emit("agent_start");
  const reply: TaskView = {
    ...failure,
    outcome: "reply",
    error: undefined,
    response: "Question?",
    status: "ready",
    level: 1,
    activity: "",
  };
  fake.runnable = false;
  fake.onReady!(reply);
  expect(sendMessage).not.toHaveBeenCalled();
  fake.runnable = true;
  fake.onReady!(reply);
  expect(sendMessage).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      customType: "pi-sub:response",
      content: expect.stringContaining("Question?"),
    }),
    { deliverAs: "followUp", triggerTurn: true },
  );
});
