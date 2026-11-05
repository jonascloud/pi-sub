import { describe, expect, it, vi } from "vitest";
import { Coordinator } from "../src/coordinator.ts";
import type { Worker, WorkerEvent, WorkerOptions } from "../src/worker.ts";

const options: WorkerOptions = {
  cwd: "/",
  provider: "p",
  model: "m",
  thinking: "off",
  name: "test",
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const usage = {
  input: 1,
  output: 2,
  cacheRead: 3,
  cacheWrite: 4,
  totalTokens: 10,
  cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
};
class Fake implements Worker {
  listener: (event: WorkerEvent) => void = () => {};
  start = vi.fn(async () => {});
  send = vi.fn(async (_message: string) => {
    this.listener({ type: "agent_start" } as WorkerEvent);
  });
  pause = vi.fn(async () => {
    const cleared = { steering: ["steer"], followUp: ["follow"] };
    this.listener({ type: "worker_queue_cleared", ...cleared });
    return cleared;
  });
  report = vi.fn(async () => ({
    text: "answer",
    sessionFile: "session",
    usage,
  }));
  close = vi.fn(async () => {});
  onEvent(listener: (event: WorkerEvent) => void) {
    this.listener = listener;
    return () => {};
  }
  settled() {
    this.listener({ type: "agent_settled" } as WorkerEvent);
  }
}
function setup(maxWorkers = 1) {
  const workers: Fake[] = [];
  const c = new Coordinator({
    maxWorkers,
    createWorker: () => {
      const w = new Fake();
      workers.push(w);
      return w;
    },
  });
  const start = (prompt = "prompt") =>
    c.start({ prompt, description: prompt, worker: options });
  return { c, workers, start };
}
describe("Coordinator", () => {
  it("caps resident workers and admits FIFO only after close", async () => {
    const { c, workers, start } = setup();
    const a = start("a"),
      b = start("b"),
      d = start("d");
    await tick();
    workers[0]!.settled();
    await tick();
    expect(workers).toHaveLength(1);
    expect(c.get(b).status).toBe("queued");
    await c.message(b, "correction");
    await c.collect(a);
    await tick();
    expect(workers).toHaveLength(2);
    expect(workers[1]!.send).toHaveBeenCalledWith("b\n\ncorrection");
    expect(c.list().map((t) => t.id)).toEqual([d, b, a]);
    await c.dispose();
  });
  it("rechecks authorization before delayed admission and retains queued corrections", async () => {
    const worker = new Fake();
    let approved = true;
    const factory = vi.fn(() => worker);
    const c = new Coordinator({
      maxWorkers: 1,
      createWorker: factory,
      beforeStart: () => {
        if (!approved) throw new Error("approval revoked");
      },
    });
    const a = c.start({ prompt: "a", description: "a", worker: options });
    const b = c.start({ prompt: "b", description: "b", worker: options });
    await tick();
    await c.message(b, "Use the corrected schema.");
    approved = false;
    worker.settled();
    await c.collect(a);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(c.get(b)).toMatchObject({
      status: "error",
      error: "approval revoked",
      pendingInput: ["b", "Use the corrected schema."],
    });
    await c.dispose();
  });
  it("preserves cleared input even when pause fails", async () => {
    const { c, workers, start } = setup();
    const id = start();
    await tick();
    const worker = workers[0]!;
    worker.pause.mockImplementation(async () => {
      worker.listener({
        type: "worker_queue_cleared",
        steering: ["important correction"],
        followUp: [],
      });
      throw new Error("abort failed");
    });
    await expect(c.pause(id)).rejects.toThrow("abort failed");
    expect(c.get(id)).toMatchObject({
      status: "error",
      pendingInput: ["important correction"],
    });
    await c.dispose();
  });
  it("marks queued tasks paused before releasing capacity", async () => {
    const { c, workers, start } = setup();
    const a = start(),
      b = start();
    await tick();
    const pause = c.pauseAll();
    expect(c.get(b).status).toBe("paused");
    await pause;
    await c.stop(a);
    expect(workers).toHaveLength(1);
    await c.continue(b);
    await tick();
    expect(workers).toHaveLength(2);
    await c.dispose();
  });
  it("does not send an initial prompt when interrupted during startup", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const worker = new Fake();
    worker.start = vi.fn(() => gate);
    const c = new Coordinator({ createWorker: () => worker });
    const id = c.start({ prompt: "p", description: "p", worker: options });
    await tick();
    const paused = c.pause(id);
    release();
    await paused;
    expect(worker.send).not.toHaveBeenCalled();
    expect(c.get(id).status).toBe("paused");
    await c.message(id, "correction");
    expect(worker.send.mock.calls.map((c) => c[0])).toEqual([
      "p\n\nsteer\n\nfollow\n\ncorrection",
    ]);
    await c.dispose();
  });
  it("wait timeout and abort do not stop execution", async () => {
    const { c, start } = setup();
    const id = start();
    await tick();
    await expect(c.wait(id, undefined, 1)).rejects.toThrow(/timed out/);
    const controller = new AbortController();
    const wait = c.wait(id, controller.signal);
    controller.abort();
    await expect(wait).rejects.toMatchObject({ name: "AbortError" });
    expect(c.get(id).status).toBe("running");
    await c.dispose();
  });
  it("keeps a paused wait pending and clears transient request failures on a successful retry", async () => {
    const { c, workers, start } = setup();
    const id = start();
    await tick();
    const waiting = c.wait(id);
    let settled = false;
    void waiting.then(() => {
      settled = true;
    });
    await c.pause(id);
    await tick();
    expect(settled).toBe(false);
    await c.continue(id);
    workers[0]!.listener({
      type: "message_end",
      message: {
        role: "assistant",
        api: "openai-responses",
        provider: "p",
        model: "m",
        usage,
        timestamp: 0,
        content: [],
        stopReason: "error",
        errorMessage: "retryable",
      },
    } as WorkerEvent);
    expect(c.get(id).status).toBe("running");
    expect(c.get(id).error).toBeUndefined();
    workers[0]!.listener({
      type: "message_end",
      message: {
        role: "assistant",
        api: "openai-responses",
        provider: "p",
        model: "m",
        usage,
        timestamp: 0,
        content: [{ type: "text", text: "recovered" }],
        stopReason: "stop",
      },
    } as WorkerEvent);
    workers[0]!.settled();
    expect((await waiting).response).toBe("recovered");
    expect(c.get(id).error).toBeUndefined();
    await c.dispose();
  });
  it("notifies an asynchronous startup failure once", async () => {
    const worker = new Fake();
    const onReady = vi.fn();
    worker.start = vi.fn(async () => {
      worker.listener({ type: "worker_error", error: "startup failed" });
      throw new Error("startup failed");
    });
    const c = new Coordinator({ createWorker: () => worker, onReady });
    const id = c.start({
      prompt: "task",
      description: "task",
      worker: options,
    });
    await tick();
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(c.get(id).status).toBe("error");
    await c.dispose();
  });

  it("collects and reports usage exactly once", async () => {
    const { c, workers, start } = setup();
    const id = start();
    await tick();
    workers[0]!.settled();
    expect((await c.collect(id)).response).toBe("answer");
    await c.collect(id);
    expect(workers[0]!.report).toHaveBeenCalledTimes(1);
    expect(workers[0]!.close).toHaveBeenCalledTimes(1);
    expect(c.drainUsage()).toEqual(usage);
    expect(c.drainUsage()).toBeUndefined();
  });
  it("retains errors and releases waiters on dispose", async () => {
    const { c, workers, start } = setup();
    const id = start(),
      queued = start();
    await tick();
    workers[0]!.listener({ type: "worker_error", error: "broken" });
    expect(c.get(id).error).toBe("broken");
    const waiting = c.wait(queued);
    await c.dispose();
    expect((await waiting).status).toBe("closed");
    expect(workers[0]!.close).toHaveBeenCalledTimes(1);
    expect(workers[0]!.report).not.toHaveBeenCalled();
    expect(() => start()).toThrow(/disposed/);
  });
  it("captures usage after abort before stopping", async () => {
    const { c, workers, start } = setup();
    const id = start();
    await tick();
    let aborted = false;
    workers[0]!.pause = vi.fn(async () => {
      aborted = true;
      return { steering: [], followUp: [] };
    });
    workers[0]!.report = vi.fn(async () => ({
      text: aborted ? "partial" : "stale",
      usage,
      sessionFile: "s",
    }));
    await c.stop(id);
    expect(c.get(id).response).toBe("partial");
    expect(c.drainUsage()).toEqual(usage);
    expect(workers[0]!.pause.mock.invocationCallOrder[0]).toBeLessThan(
      workers[0]!.report.mock.invocationCallOrder[0]!,
    );
  });
  it("blocks collection while a message is being sent and ignores stale settled events", async () => {
    const { c, workers, start } = setup();
    const id = start();
    await tick();
    workers[0]!.settled();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    workers[0]!.send = vi.fn(async () => {
      await gate;
    });
    const sending = c.message(id, "answer");
    await tick();
    workers[0]!.settled();
    expect(c.get(id).status).toBe("running");
    await expect(c.collect(id)).rejects.toThrow();
    workers[0]!.listener({ type: "agent_start" } as WorkerEvent);
    workers[0]!.settled();
    await expect(c.collect(id)).rejects.toThrow();
    release();
    await sending;
    expect((await c.collect(id)).status).toBe("closed");
  });
  it("closes startup immediately on shutdown without waiting for an RPC response", async () => {
    let release!: () => void;
    const worker = new Fake();
    worker.start = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const c = new Coordinator({ createWorker: () => worker });
    const id = c.start({
      prompt: "task",
      description: "task",
      worker: options,
    });
    await tick();
    await c.dispose();
    expect(worker.close).toHaveBeenCalledTimes(1);
    expect(c.get(id).status).toBe("closed");
    release();
    await tick();
    expect(worker.send).not.toHaveBeenCalled();
  });

  it("copies execution metadata and combines queued corrections", async () => {
    const { c, start, workers } = setup();
    const a = start("a"),
      b = start("original");
    await tick();
    await c.pause(b);
    await c.message(b, "correction");
    await c.stop(a);
    await tick();
    expect(workers[1]!.send).toHaveBeenCalledWith("original\n\ncorrection");
    const view = c.get(b);
    view.execution.model = "changed";
    expect(c.get(b).execution.model).toBe("m");
    await c.dispose();
  });
});
