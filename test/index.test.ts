import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { existsSync } from "node:fs";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { TaskView } from "../src/coordinator.ts";
import piSub from "../index.ts";
import * as models from "../src/models.ts";
import { captureReport, ENVELOPE_BYTES } from "../src/reports.ts";
import { ReportStore } from "../src/report-store.ts";

const task = (id: string, fields: Partial<TaskView> = {}): TaskView => ({
  id,
  description: `Task ${id}`,
  level: 3,
  execution: { provider: "test", model: "fake", thinking: "off" },
  sessionFile: `/sessions/${id}.jsonl`,
  status: "ready",
  activity: "",
  turns: 1,
  toolUses: 0,
  tokens: 16,
  elapsedMs: 1000,
  response: `Answer from ${id}`,
  unsent: 0,
  delivered: false,
  ...fields,
});
const fake = vi.hoisted(() => ({
  idle: true,
  pendingMessages: false,
  tasks: [] as TaskView[],
  usage: undefined as object | undefined,
  reports: undefined as ReportStore | undefined,
  onSettled: () => {},
  start: vi.fn(),
  message: vi.fn(),
  pause: vi.fn(),
  continue: vi.fn(),
  stop: vi.fn(),
  accept: vi.fn(),
  wait: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock("../src/coordinator.ts", async (original) => ({
  ...(await original<typeof import("../src/coordinator.ts")>()),
  Coordinator: class {
    readonly reports = new ReportStore();
    constructor(options: { onSettled: () => void }) {
      fake.onSettled = options.onSettled;
      fake.reports = this.reports;
    }
    start = fake.start;
    message = fake.message;
    pause = fake.pause;
    continue = fake.continue;
    stop = fake.stop;
    accept = fake.accept;
    wait = fake.wait;
    dispose = async () => {
      await fake.dispose();
      this.reports.dispose();
    };
    list = () => fake.tasks.map((item) => ({ ...item }));
    get = (id: string) => {
      const found = fake.tasks.find((item) => item.id === id);
      if (!found) throw new Error(`Unknown task: ${id}`);
      return { ...found };
    };
    markDelivered = (id: string) => {
      const found = fake.tasks.find((item) => item.id === id);
      if (found && (found.status === "ready" || found.status === "failed"))
        found.delivered = true;
    };
    drainUsage = () => {
      const usage = fake.usage;
      fake.usage = undefined;
      return usage;
    };
    subscribe = () => () => {};
  },
}));
vi.mock("../src/widget.ts", () => ({ mountWidget: () => () => {} }));

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const shutdowns: (() => Promise<unknown>)[] = [];
beforeEach(() => {
  vi.stubEnv("PI_SUB_CHILD", "");
  Object.assign(fake, { idle: true, pendingMessages: false, tasks: [] });
  fake.usage = undefined;
  for (const mock of [fake.start, fake.message, fake.pause, fake.continue])
    mock.mockReset();
  fake.dispose.mockReset().mockResolvedValue(undefined);
  fake.stop
    .mockReset()
    .mockImplementation(async (id: string) => task(id, { status: "stopped" }));
  fake.accept
    .mockReset()
    .mockImplementation((id: string) => task(id, { status: "accepted" }));
  // Like the coordinator: pending until its task settles or the signal aborts.
  fake.wait
    .mockReset()
    .mockImplementation(
      (_id: string, signal: AbortSignal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () =>
            reject(new DOMException("Wait aborted", "AbortError")),
          ),
        ),
    );
  vi.spyOn(models, "availableModels").mockReturnValue([
    { provider: "test", model: "fake", thinking: ["off"] },
  ]);
  vi.spyOn(models, "loadLadder").mockReturnValue([
    { power: 6, provider: "test", model: "fake", thinking: "off" },
  ]);
});
afterEach(async () => {
  await turn();
  for (const shutdown of shutdowns.splice(0)) await shutdown();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function setup() {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const commands = new Map<
    string,
    { handler: (args: string, ctx: ExtensionContext) => Promise<void> }
  >();
  const tools = new Map<
    string,
    { description: string; execute: (...args: any[]) => Promise<any> }
  >();
  const sendMessage = vi.fn();
  const renderers: string[] = [];
  const notify = vi.fn();
  const abort = vi.fn();
  const ctx = {
    cwd: "/project",
    mode: "rpc",
    hasUI: true,
    abort,
    isIdle: () => fake.idle,
    hasPendingMessages: () => fake.pendingMessages,
    isProjectTrusted: () => true,
    ui: { notify },
  } as unknown as ExtensionContext;
  piSub({
    on: (name: string, handler: (event: any, ctx: any) => any) =>
      handlers.set(name, handler),
    registerCommand: (name: string, command: any) =>
      commands.set(name, command),
    registerMessageRenderer: (name: string) => renderers.push(name),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    sendMessage,
  } as unknown as ExtensionAPI);
  const emit = (type: string, fields: Record<string, unknown> = {}) =>
    handlers.get(type)!(
      {
        type,
        ...(type === "turn_end" || type === "agent_before_settle"
          ? { entries: [], outcome: "completed" }
          : {}),
        ...fields,
      },
      ctx,
    );
  emit("session_start");
  shutdowns.push(async () => emit("session_shutdown"));
  const call = (name: string, args: object, signal?: AbortSignal, on = ctx) =>
    tools.get(name)!.execute("call", args, signal, () => {}, on);
  const settle = (...settled: TaskView[]) => {
    fake.tasks.push(...settled);
    fake.onSettled();
  };
  const body = (result: { content: { text: string }[] }) =>
    JSON.parse(result.content[0]!.text);
  return {
    ctx,
    emit,
    commands,
    tools,
    sendMessage,
    renderers,
    notify,
    abort,
    call,
    settle,
    body,
    reports: fake.reports!,
  };
}

test("adds four tools, three commands, one message view and one stable prompt section", () => {
  const { tools, commands, renderers, emit, settle } = setup();
  expect([...tools.keys()]).toEqual([
    "sub_task",
    "sub_message",
    "sub_result",
    "sub_control",
  ]);
  expect([...commands.keys()]).toEqual([
    "sub:pause",
    "sub:continue",
    "sub:stop",
  ]);
  expect(renderers).toEqual(["pi-sub:response"]);

  const options = { sections: { pi_sub: "old section" } };
  emit("before_agent_start", { systemPromptOptions: options });
  const section = options.sections.pi_sub;
  expect(section).toContain("Delegate bounded work");
  expect(section.split(models.STRENGTH_GUIDANCE)).toHaveLength(2);
  expect(section).toMatch(/\n\nAvailable ladder levels \(snapshot\): 1–6\.$/);
  // Task state would rewrite the cached prompt prefix on every change.
  settle(task("a"), task("b", { status: "active" }));
  emit("before_agent_start", { systemPromptOptions: options });
  expect(options.sections.pi_sub).toBe(section);
  vi.mocked(models.availableModels).mockReturnValue([]);
  emit("before_agent_start", { systemPromptOptions: options });
  expect(options.sections.pi_sub).toContain("levels (snapshot): none.");
  vi.mocked(models.loadLadder).mockImplementation(() => {
    throw new Error("Invalid ladder");
  });
  emit("before_agent_start", { systemPromptOptions: options });
  expect(options.sections.pi_sub).toMatch(
    /Delegation unavailable: Invalid ladder$/,
  );
});

test("sub_task starts the first sufficient ladder rung in a private session directory", async () => {
  const { call, body, ctx, emit } = setup();
  fake.start.mockImplementation(() => {
    fake.tasks.push(task("new", { status: "active", response: "" }));
    return "new";
  });
  const result = await call("sub_task", {
    level: 3,
    prompt: "Inspect the entry points.",
    description: "Review auth",
  });
  expect(result.isError).toBeUndefined();
  expect(body(result)).toEqual({
    id: "new",
    description: "Task new",
    status: "active",
    response: "",
  });
  const request = fake.start.mock.calls[0]![0];
  expect(request).toMatchObject({
    prompt: "Inspect the entry points.",
    description: "Review auth",
    level: 3,
    worker: {
      provider: "test",
      model: "fake",
      thinking: "off",
      cwd: "/project",
      name: "Review auth",
      args: ["--approve"],
    },
  });
  expect(existsSync(request.worker.sessionDir)).toBe(true);
  // Child sessions are working data: they go with the parent runtime, after its children.
  let exists = false;
  fake.dispose.mockImplementation(async () => {
    exists = existsSync(request.worker.sessionDir);
  });
  await emit("session_shutdown");
  expect(exists).toBe(true);
  expect(existsSync(request.worker.sessionDir)).toBe(false);

  for (const refused of [
    call("sub_task", { level: 3, prompt: "x" }, AbortSignal.abort()),
    call("sub_task", { level: 7, prompt: "x" }),
    call("sub_task", { level: 3, prompt: "x" }, undefined, {
      ...ctx,
      isProjectTrusted: () => false,
    } as ExtensionContext),
  ])
    expect(await refused).toMatchObject({ isError: true });
  expect(fake.start).toHaveBeenCalledOnce();
});

test("a tool result is the model's view of a task, delivers its reply and charges confirmed usage once", async () => {
  const { call, body, settle, sendMessage } = setup();
  const ready = task("a", { status: "failed", error: "exited 1", unsent: 1 });
  fake.idle = false;
  settle(ready, task("b", { status: "active" }));
  fake.usage = { input: 5 };
  const result = await call("sub_result", { id: "a" });
  expect(body(result)).toMatchObject({
    id: ready.id,
    status: "failed",
    error: "exited 1",
    response: ready.response,
  });
  expect(result.details.tasks[0].preview).toBe(ready.response);
  expect(result.usage).toEqual({ input: 5 });
  expect(fake.tasks[0]!.delivered).toBe(true);
  expect((await call("sub_result", { id: "b" })).usage).toBeUndefined();
  expect(fake.tasks[1]!.delivered).toBe(false); // Nothing to deliver yet.
  // What a tool returned is not announced again.
  fake.idle = true;
  fake.onSettled();
  await turn();
  expect(sendMessage).not.toHaveBeenCalled();
  expect(await call("sub_result", { id: "unknown" })).toMatchObject({
    isError: true,
    content: [{ text: "Unknown task: unknown" }],
  });
});

test("sub_result reads, waits, and accepts only what has settled", async () => {
  const { call, body } = setup();
  fake.tasks = [task("ready"), task("active", { status: "active" })];
  fake.wait.mockImplementation(async (id: string) =>
    fake.tasks.find((item) => item.id === id),
  );
  await call("sub_result", { id: "ready", wait: true, timeout: 5 });
  expect(fake.wait).toHaveBeenCalledExactlyOnceWith(
    "ready",
    expect.any(AbortSignal),
    5000,
  );
  expect(fake.accept).not.toHaveBeenCalled();
  expect(
    body(await call("sub_result", { id: "ready", wait: true, finish: true })),
  ).toMatchObject({ id: "ready", status: "accepted" });
  expect(fake.wait).toHaveBeenLastCalledWith("ready", expect.anything(), 30000);
  // A wait that ended early has nothing to accept yet.
  expect(
    body(await call("sub_result", { id: "active", wait: true, finish: true })),
  ).toMatchObject({ id: "active", status: "active" });
  expect(fake.accept).toHaveBeenCalledExactlyOnceWith("ready");
  fake.accept.mockImplementation(() => {
    throw new Error("Cannot accept a active task; stop it instead");
  });
  expect(
    await call("sub_result", { id: "active", finish: true }),
  ).toMatchObject({ isError: true });
});

test("report paging cannot act on a task or trigger another execution", async () => {
  const { call, reports, settle, emit, sendMessage } = setup();
  const taskView = task("a", { response: "evidence 😀\n".repeat(1000) });
  const saved = captureReport(taskView, reports);
  fake.idle = false;
  settle({ ...taskView, ...saved });
  const returned = await call("sub_result", { id: "a" });
  const ref = JSON.parse(returned.content[0].text).report;
  expect(ref.id).toBe(saved.report.id);
  expect(Buffer.byteLength(returned.content[0].text)).toBeLessThanOrEqual(
    ENVELOPE_BYTES,
  );
  fake.tasks = []; // Task is no longer live.
  const page = await call("sub_result", { report: ref.id, limit: 100 });
  expect(page.isError).toBeUndefined();
  expect(page.details.report).toMatchObject({ id: ref.id, next: 100 });
  expect(page.content[0].text).toContain("offset: 100");
  for (const args of [
    { report: ref.id, id: "a" },
    { report: ref.id, finish: true },
    { id: "a", offset: 0 },
    {},
  ])
    expect(await call("sub_result", args)).toMatchObject({ isError: true });
  expect(fake.start).not.toHaveBeenCalled();
  expect(fake.accept).not.toHaveBeenCalled();
  expect(sendMessage).not.toHaveBeenCalled();
  await emit("session_shutdown");
  expect(await call("sub_result", { report: ref.id })).toMatchObject({
    isError: true,
    content: [{ text: "Report no longer available" }],
  });
});

test("sub_message and sub_control act on one task or on all that apply", async () => {
  const { call, body } = setup();
  fake.tasks = [
    task("a", { status: "paused" }),
    task("b", { status: "active" }),
  ];
  expect(
    body(await call("sub_message", { id: "a", message: "Use production." })),
  ).toMatchObject({ id: "a" });
  expect(fake.message).toHaveBeenCalledExactlyOnceWith("a", "Use production.");
  fake.message.mockRejectedValue(new Error("Task is stopping"));
  expect(await call("sub_message", { id: "a", message: "x" })).toMatchObject({
    isError: true,
    content: [{ text: "Task is stopping" }],
  });

  expect(
    body(await call("sub_control", { action: "pause", id: "b" })),
  ).toMatchObject({ id: "b" });
  expect(fake.pause.mock.calls).toEqual([["b"]]);
  expect(body(await call("sub_control", { action: "continue" }))).toMatchObject(
    [{ id: "a" }],
  );
  expect(fake.continue.mock.calls).toEqual([["a"]]); // Only paused tasks continue.
  expect(body(await call("sub_control", { action: "stop" }))).toMatchObject([
    { id: "a", status: "stopped" },
    { id: "b", status: "stopped" },
  ]);
  fake.tasks = [];
  expect(body(await call("sub_control", { action: "pause" }))).toEqual([]);
});

test("replies and failures of one event-loop turn wake an idle parent with one message", async () => {
  const { settle, sendMessage, emit } = setup();
  const failed = task("b", {
    status: "failed",
    error: "worker exited",
    response: "Read three files.",
  });
  settle(task("a"));
  settle(failed);
  settle(task("c", { status: "active" }));
  await turn();
  expect(sendMessage).toHaveBeenCalledExactlyOnceWith(
    {
      customType: "pi-sub:response",
      display: true,
      content:
        "Subagent a (Task a)\nAnswer from a\n\n" +
        "Subagent b (Task b) failed\nworker exited\n\nLast response:\nRead three files.",
      details: {
        tasks: [
          expect.objectContaining({ id: "a", status: "ready" }),
          expect.objectContaining({ id: "b", status: "failed" }),
        ],
      },
    },
    { triggerTurn: true },
  );
  expect(fake.tasks.map((item) => item.delivered)).toEqual([true, true, false]);
  fake.onSettled();
  await turn();
  expect(emit("turn_end")).toBeUndefined();
  expect(sendMessage).toHaveBeenCalledOnce(); // Handing over is delivery.
});

test("a running parent gets replies with the request it makes anyway; dialogs defer them", async () => {
  const { settle, sendMessage, emit, ctx } = setup();
  fake.idle = false;
  settle(task("a"));
  await turn();
  expect(sendMessage).not.toHaveBeenCalled();
  for (const outcome of ["error", "aborted"])
    expect(emit("turn_end", { outcome })).toBeUndefined();
  Object.assign(ctx, { signal: AbortSignal.abort() });
  expect(emit("turn_end")).toBeUndefined();
  Object.assign(ctx, { signal: undefined });
  emit("ui_prompt_start");
  expect(emit("agent_before_settle")).toBeUndefined();
  fake.idle = true;
  emit("ui_prompt_end");
  fake.idle = false; // Still running once the dialog closed.
  await turn();
  const draft = { type: "custom", customType: "other" };
  expect(emit("agent_before_settle", { entries: [draft] })).toEqual({
    entries: [
      draft,
      expect.objectContaining({
        type: "custom_message",
        customType: "pi-sub:response",
        content: "Subagent a (Task a)\nAnswer from a",
      }),
    ],
    continue: true,
  });
  expect(emit("turn_end")).toBeUndefined();
  expect(sendMessage).not.toHaveBeenCalled();
});

test("aborting the parent leaves its children alone and holds their replies until the user speaks", async () => {
  const { emit, settle, sendMessage, abort } = setup();
  settle(task("early")); // Scheduled in the very turn the abort settles.
  await emit("agent_settled", { aborted: true });
  expect(fake.pause).not.toHaveBeenCalled();
  settle(task("a"));
  await turn();
  expect(sendMessage).not.toHaveBeenCalled(); // Escape stopped the parent; nothing of ours restarts it.
  await emit("input", { source: "extension", text: "notification" });
  await emit("ui_prompt_end");
  await turn();
  expect(sendMessage).not.toHaveBeenCalled();
  expect(abort).not.toHaveBeenCalled();

  expect(
    await emit("input", { source: "interactive", text: "go on" }),
  ).toBeUndefined(); // User input passes through untouched.
  fake.idle = false;
  expect(emit("turn_end").entries[0].content).toContain("Subagent early");
  fake.idle = true;
  settle(task("late"));
  await emit("agent_settled", { aborted: false });
  await turn();
  expect(sendMessage).toHaveBeenCalledOnce(); // Idle delivery works again.
});

test("/sub:pause stops everything and holds replies until /sub:continue; with an ID it pauses one child", async () => {
  const { commands, ctx, abort, settle, sendMessage, notify } = setup();
  fake.tasks = [
    task("a", { status: "active" }),
    task("b", { status: "queued" }),
  ];
  await commands.get("sub:pause")!.handler(" a ", ctx);
  expect(fake.pause.mock.calls).toEqual([["a"]]);
  expect(abort).not.toHaveBeenCalled();
  await commands.get("sub:pause")!.handler("", ctx);
  expect(fake.pause.mock.calls).toEqual([["a"], ["a"], ["b"]]);
  expect(abort).toHaveBeenCalledOnce();
  settle(task("finished-first")); // Replied before its process was signalled.
  await turn();
  expect(sendMessage).not.toHaveBeenCalled();

  fake.tasks[0]!.status = "paused";
  await commands.get("sub:continue")!.handler("", ctx);
  expect(fake.continue.mock.calls).toEqual([["a"]]);
  await turn();
  expect(sendMessage).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ customType: "pi-sub:response" }),
    { triggerTurn: true },
  );
  fake.tasks = [];
  await commands.get("sub:continue")!.handler("", ctx);
  expect(notify).toHaveBeenCalledExactlyOnceWith("No paused tasks.", "info");
  fake.continue.mockImplementation(() => {
    throw new Error("Task is not paused");
  });
  await commands.get("sub:continue")!.handler("x", ctx);
  expect(notify).toHaveBeenLastCalledWith("Task is not paused", "error");
});

test("/sub:stop tells the parent what the user stopped, without a turn", async () => {
  const { commands, ctx, sendMessage, notify, reports, call } = setup();
  await commands.get("sub:stop")!.handler("", ctx);
  expect(notify).toHaveBeenCalledExactlyOnceWith("No tasks to stop.", "info");
  fake.tasks = [task("a"), task("b", { status: "active" })];
  const ref = reports.put("partial results on stop");
  fake.stop.mockImplementation(async (id: string) =>
    task(id, { status: "stopped", ...(id === "b" ? { report: ref } : {}) }),
  );
  await commands.get("sub:stop")!.handler("", ctx);
  expect(sendMessage).toHaveBeenCalledExactlyOnceWith(
    {
      customType: "pi-sub:stopped",
      display: true,
      content: `The user stopped: a (Task a); b (Task b) · report: ${ref.id}`,
      details: {},
    },
    { triggerTurn: false },
  );
  expect(
    (await call("sub_result", { report: ref.id })).content[0].text,
  ).toContain("partial results on stop");
  await commands.get("sub:stop")!.handler("b", ctx);
  expect(fake.stop).toHaveBeenLastCalledWith("b");
});

test("a steering message ends waits and keeps the parent from blocking until it arrives", async () => {
  const { emit, call, body } = setup();
  fake.tasks = [task("a", { status: "active" })];
  fake.idle = false;
  const wait = (signal?: AbortSignal, finish = false) =>
    call("sub_result", { id: "a", wait: true, finish }, signal);
  let yielded = false;
  const followed = wait().then((result) => {
    yielded = true;
    return result;
  });
  await emit("input", {
    source: "interactive",
    text: "afterwards",
    streamingBehavior: "followUp",
  });
  await turn();
  expect(yielded).toBe(false); // A follow-up asks to be read after the work.
  const first = wait();
  await emit("input", {
    source: "interactive",
    text: "one more thing",
    streamingBehavior: "steer",
  });
  fake.pendingMessages = true; // Pi queues it once the handlers have returned.
  for (const result of await Promise.all([followed, first])) {
    expect(result.isError).toBeUndefined();
    expect(body(result)).toMatchObject({ id: "a", status: "active" });
  }
  expect(fake.wait).toHaveBeenCalledTimes(2);
  // A sequential sibling wait starts before the message is delivered, and
  // its acceptance has nothing to accept yet.
  expect(body(await wait(undefined, true))).toMatchObject({ status: "active" });
  expect(fake.wait).toHaveBeenCalledTimes(2);
  expect(fake.accept).not.toHaveBeenCalled();

  // Delivered. The follow-up still queued behind it holds nothing back.
  emit("message_start", { message: { role: "assistant" } });
  expect(body(await wait())).toMatchObject({ status: "active" });
  emit("message_start", { message: { role: "user" } });
  const aborted = new AbortController();
  const blocking = wait(aborted.signal);
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(fake.wait).toHaveBeenCalledTimes(3);
  aborted.abort(); // Escape remains an interruption, not a yield.
  expect(await blocking).toMatchObject({
    isError: true,
    content: [{ text: "Wait aborted" }],
  });
});

test.each([false, true])(
  "a steering message another input handler delays ends a later wait once queued, and never if withdrawn (queued=%s)",
  async (queued) => {
    const { emit, call } = setup();
    fake.tasks = [task("a", { status: "active" })];
    await emit("input", {
      source: "rpc",
      text: "one more thing",
      streamingBehavior: "steer",
    });
    await turn();
    const aborted = new AbortController();
    let settled = false;
    const waiting = call(
      "sub_result",
      { id: "a", wait: true },
      aborted.signal,
    ).then((result) => {
      settled = true;
      return result;
    });
    await turn();
    expect(fake.wait).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    fake.pendingMessages = queued;
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(settled).toBe(queued);
    aborted.abort();
    expect((await waiting).isError).toBe(queued ? undefined : true);
  },
);

test("shutdown cancels a scheduled wakeup and tolerates none of its own state", async () => {
  const { emit, settle, sendMessage, notify } = setup();
  settle(task("a"));
  await emit("session_shutdown");
  await turn();
  expect(sendMessage).not.toHaveBeenCalled();
  expect(fake.dispose).toHaveBeenCalledOnce();
  expect(notify).not.toHaveBeenCalled();
});
