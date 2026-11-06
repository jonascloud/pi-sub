import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createWorker, type Worker, type WorkerEvent } from "../src/worker.ts";

const native = vi.hoisted(() => {
  const state = {
    model: { provider: "test", id: "fake" },
    thinkingLevel: "off",
    isStreaming: false,
    isCompacting: false,
    pendingMessageCount: 0,
  };
  return {
    state,
    listeners: new Set<(event: unknown) => void>(),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    prompt: vi.fn<() => Promise<"started" | "queued" | "handled">>(),
    getState: vi.fn(async () => ({ ...state })),
  };
});
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  RpcClient: class {
    start = native.start;
    stop = native.stop;
    prompt = native.prompt;
    getState = native.getState;
    onEvent(listener: (event: unknown) => void) {
      native.listeners.add(listener);
      return () => native.listeners.delete(listener);
    }
  },
}));
function emit(event: unknown) {
  for (const listener of [...native.listeners]) listener(event);
}
const flush = () => vi.advanceTimersByTimeAsync(0);
let worker: Worker;
let events: WorkerEvent[];
beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  native.prompt.mockReset();
  native.getState
    .mockReset()
    .mockImplementation(async () => ({ ...native.state }));
  native.stop.mockReset().mockResolvedValue();
  native.listeners.clear();
  native.state.isStreaming = false;
  worker = createWorker({
    cwd: process.cwd(),
    provider: "test",
    model: "fake",
    thinking: "off",
    name: "test",
  });
  await worker.start();
  native.getState.mockClear();
  events = [];
  worker.onEvent((event) => events.push(event));
});
afterEach(async () => {
  await worker.close();
  vi.useRealTimers();
});
const states = () => events.filter((event) => event.type === "worker_state");

test("an older retry start cannot confirm a new input; post-ACK state is always fresh", async () => {
  const ack = Promise.withResolvers<"started">();
  const oldProbe = Promise.withResolvers<typeof native.state>();
  native.prompt.mockReturnValueOnce(ack.promise);
  native.getState.mockImplementationOnce(() => oldProbe.promise);
  const sending = worker.send("next");
  emit({ type: "agent_start" });
  emit({ type: "agent_settled", aborted: false });
  await flush();
  native.state.isStreaming = true;
  ack.resolve("started");
  await flush();
  const finished = vi.fn();
  void sending.then(finished);
  expect(finished).not.toHaveBeenCalled();
  oldProbe.resolve({ ...native.state, isStreaming: false });
  await expect(sending).resolves.toBe("started");
  expect(native.getState).toHaveBeenCalledTimes(2);
  expect(states().at(-1)).toEqual({ type: "worker_state", idle: false });
  expect(native.prompt).toHaveBeenCalledWith("next", undefined, "steer");
});

test("a late old settlement during the post-ACK probe never becomes authoritative", async () => {
  native.state.isStreaming = true;
  native.prompt.mockResolvedValueOnce("started");
  const probe = Promise.withResolvers<typeof native.state>();
  native.getState.mockImplementationOnce(() => probe.promise);
  const sending = worker.send("new run");
  await flush();
  emit({ type: "agent_settled", aborted: false }); // Old extension hook finally finished; NEW run is active.
  probe.resolve({ ...native.state });
  await sending;
  await flush();
  expect(states().length).toBeGreaterThan(0);
  expect(states().every((event) => event.idle === false)).toBe(true);
  expect(native.getState.mock.calls.length).toBeGreaterThanOrEqual(2);
});

test("a start invalidates an idle snapshot and forces a fresh bounded verification", async () => {
  const probe = Promise.withResolvers<typeof native.state>();
  native.getState.mockImplementationOnce(() => probe.promise);
  emit({ type: "agent_settled", aborted: false });
  await flush();
  native.state.isStreaming = true;
  emit({ type: "agent_start" });
  probe.resolve({ ...native.state, isStreaming: false });
  await flush();
  expect(native.getState).toHaveBeenCalledTimes(2);
  expect(states()).toEqual([{ type: "worker_state", idle: false }]);
});

test("a fast run may start and settle before the ACK continuation", async () => {
  native.prompt.mockImplementationOnce(async () => {
    native.state.isStreaming = true;
    emit({ type: "agent_start" });
    native.state.isStreaming = false;
    emit({ type: "agent_settled", aborted: false });
    return "started";
  });
  await expect(worker.send("fast")).resolves.toBe("started");
  expect(states().at(-1)).toEqual({ type: "worker_state", idle: true });
  await vi.advanceTimersByTimeAsync(4000);
  expect(native.getState).toHaveBeenCalledTimes(2); // Event verification + fresh post-ACK verification; no idle polling.
});

test("an idle snapshot alone does not finish a run whose settlement hooks are pending", async () => {
  native.prompt.mockResolvedValueOnce("started");
  emit({ type: "agent_start" });
  native.state.isStreaming = false; // Pi clears its flag before awaiting settlement handlers.
  await worker.send("fast run");
  expect(states().at(-1)).toEqual({ type: "worker_state", idle: false });
  emit({ type: "agent_settled", aborted: false });
  await flush();
  expect(states().at(-1)).toEqual({ type: "worker_state", idle: true });
});

test("queued steering needs no new start event", async () => {
  native.state.isStreaming = true;
  native.prompt.mockResolvedValueOnce("queued");
  await expect(worker.send("steer")).resolves.toBe("queued");
  expect(states()).toEqual([{ type: "worker_state", idle: false }]);
});

test("only verified quiescence stops heartbeat; settlement itself is just a hint", async () => {
  native.state.isStreaming = true;
  emit({ type: "agent_start" });
  const probe = Promise.withResolvers<typeof native.state>();
  native.getState.mockImplementationOnce(() => probe.promise);
  emit({ type: "agent_settled", aborted: false });
  await flush();
  expect(states()).toEqual([]);
  native.state.isStreaming = false;
  probe.resolve({ ...native.state });
  await flush();
  expect(states()).toEqual([{ type: "worker_state", idle: true }]);
  await vi.advanceTimersByTimeAsync(5000);
  expect(native.getState).toHaveBeenCalledOnce();
});

test.each(["close", "dialog"])(
  "%s interrupts a pending post-ACK verification",
  async (action) => {
    native.prompt.mockResolvedValueOnce("started");
    native.getState.mockImplementationOnce(() => new Promise(() => {}));
    const sending = worker.send("next");
    const rejected = expect(sending).rejects.toThrow(
      action === "close"
        ? "Worker is closed"
        : "Unsupported extension UI dialog",
    );
    await flush();
    if (action === "close") await worker.close();
    else emit({ type: "extension_ui_request", method: "confirm" });
    await rejected;
    await worker.close();
    expect(native.listeners.size).toBe(0);
  },
);

test("handled and rejected inputs do not probe or wait for an unrelated start", async () => {
  native.prompt.mockResolvedValueOnce("handled");
  await expect(worker.send("/handled")).rejects.toThrow("handled");
  native.prompt.mockRejectedValueOnce(Error("preflight rejected"));
  await expect(worker.send("rejected")).rejects.toThrow("preflight rejected");
  expect(native.getState).not.toHaveBeenCalled();
});

test("failed process closure can be retried without reopening the worker", async () => {
  native.stop.mockRejectedValueOnce(Error("temporary close failure"));
  await expect(worker.close()).rejects.toThrow("temporary close failure");
  await worker.close();
  expect(native.stop).toHaveBeenCalledTimes(2);
  await expect(worker.send("cannot reopen")).rejects.toThrow("closed");
});
