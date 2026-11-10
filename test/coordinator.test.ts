import { describe, expect, it, vi } from "vitest";
import type { Usage } from "@earendil-works/pi-ai";
import { Coordinator, type TaskView } from "../src/coordinator.ts";
import type {
  Worker,
  WorkerEvent,
  WorkerOptions,
  WorkerReport,
} from "../src/worker.ts";

const options: WorkerOptions = {
  cwd: "/",
  sessionDir: "/sessions",
  provider: "p",
  model: "m",
  thinking: "off",
  name: "test",
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const usage = (input: number, output = 0, cacheRead = 0): Usage => ({
  input,
  output,
  cacheRead,
  cacheWrite: 0,
  totalTokens: input + output + cacheRead,
  cost: {
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    total: input + output + cacheRead,
  },
});

/** A run report is available only after physical close, including on stop. */
class Fake implements Worker {
  private report = Promise.withResolvers<WorkerReport>();
  private closed = Promise.withResolvers<void>();
  private listener: (event: WorkerEvent) => void = () => {};
  private finished = false;
  constructor(
    readonly sessionFile: string,
    private sessions: Map<string, Usage>,
  ) {}
  run = vi.fn((_input: string) => this.report.promise);
  stop = vi.fn(() => this.closed.promise);
  onEvent(listener: (event: WorkerEvent) => void) {
    this.listener = listener;
    return () => {
      this.listener = () => {};
    };
  }
  emit(event: WorkerEvent) {
    this.listener(event);
  }
  close(report: Partial<WorkerReport> = {}) {
    if (this.finished) throw new Error("Process already closed");
    this.finished = true;
    if (report.usage)
      this.sessions.set(this.sessionFile, structuredClone(report.usage));
    this.closed.resolve();
    this.report.resolve({
      text: "answer",
      sessionFile: this.sessionFile,
      usage: this.sessions.get(this.sessionFile),
      interrupted: false,
      inputPersisted: true,
      ...report,
    });
  }
  reject(error: Error) {
    this.report.reject(error);
  }
  physicalClose() {
    this.closed.resolve();
  }
}
function setup(maxWorkers = 1, beforeStart?: (task: TaskView) => void) {
  const workers: Fake[] = [];
  const sessions = new Map<string, Usage>();
  const onReady = vi.fn();
  const factory = vi.fn(
    (_options: WorkerOptions, sessionFile: string, _sessionId?: string) => {
      const worker = new Fake(sessionFile, sessions);
      workers.push(worker);
      return worker;
    },
  );
  const c = new Coordinator({
    maxWorkers,
    createWorker: factory,
    onReady,
    beforeStart,
  });
  const start = (prompt = "brief") =>
    c.start({ prompt, description: prompt, level: 3, worker: options });
  return { c, workers, start, factory, onReady };
}

describe("reply delivery is not task acceptance", () => {
  it("delivers a reply once, keeps questions resumable, and isolates successor replies", async () => {
    const { c, workers, start } = setup();
    const id = start();
    expect(c.markDelivered(id, "unknown")).toBe(false);
    workers[0]!.close({ text: "Which schema?", usage: usage(25) });
    await tick();
    const first = c.get(id);
    expect(first.reply).toMatchObject({ delivered: false });
    const changed = vi.fn();
    const detach = c.subscribe(changed);
    expect(c.markDelivered(id, first.reply!.id)).toBe(true);
    expect(c.markDelivered(id, first.reply!.id)).toBe(false);
    expect(changed).toHaveBeenCalledOnce();
    detach();
    expect(c.get(id)).toMatchObject({
      status: "ready",
      response: "Which schema?",
      reply: { delivered: true },
    });
    expect(first.reply!.delivered).toBe(false); // Snapshots cannot change underneath a carrier.
    expect(c.summary().completed).toBe(0);
    expect(c.drainUsage()).toEqual(usage(25)); // Confirmed work, not acceptance, is charged.

    const blocker = start("occupy the slot");
    await c.message(id, "Production");
    expect(c.get(id).status).toBe("queued");
    expect(c.get(id).reply).toBeUndefined();
    expect(c.markDelivered(id, first.reply!.id)).toBe(false);
    workers[1]!.close();
    await tick();
    expect(c.get(blocker).status).toBe("ready");
    expect(workers[2]!.sessionFile).toBe(first.sessionFile);
    expect(workers[2]!.run).toHaveBeenCalledExactlyOnceWith("Production");
    workers[2]!.close({ text: "Checked production.", usage: usage(75) });
    await tick();
    const next = c.get(id);
    expect(next.reply!.id).not.toBe(first.reply!.id);
    expect(c.markDelivered(id, first.reply!.id)).toBe(false);
    expect(c.get(id).reply!.delivered).toBe(false);
    expect(c.markDelivered(id, next.reply!.id)).toBe(true);
    await c.collect(id);
    expect(c.markDelivered(id, next.reply!.id)).toBe(false);
    expect(c.summary().completed).toBe(1);
    expect(c.drainUsage()).toEqual(usage(50));
    await c.dispose();
  });

  it("does not treat a failure or an unknown task as a delivered reply", async () => {
    const { c, workers, start } = setup();
    const id = start();
    workers[0]!.close({ error: "worker failed" });
    await tick();
    expect(c.markDelivered(id, "anything")).toBe(false);
    expect(c.markDelivered("unknown", "anything")).toBe(false);
    expect(c.get(id)).toMatchObject({ status: "ready", outcome: "error" });
    await c.dispose();
  });
});

describe("one session, fresh execution processes", () => {
  it("does not complete or admit on native settlement; closed ready tasks free capacity", async () => {
    const { c, workers, start, onReady } = setup();
    const a = start("a"),
      b = start("b");
    workers[0]!.emit({ type: "agent_settled", aborted: false });
    await tick();
    expect(c.get(a).status).toBe("active");
    expect(workers).toHaveLength(1);
    expect(onReady).not.toHaveBeenCalled();
    await expect(c.collect(a)).rejects.toThrow("Cannot collect");
    workers[0]!.close();
    await tick();
    expect(c.get(a).status).toBe("ready");
    expect(c.get(b).status).toBe("active");
    expect(workers).toHaveLength(2);
    expect(onReady).toHaveBeenCalledOnce();
    workers[1]!.close();
    await tick();
    await c.dispose();
  });

  it("answers and continues with distinct workers but the same explicit session file", async () => {
    const { c, workers, start, factory } = setup();
    const id = start();
    const sessionFile = c.get(id).sessionFile;
    workers[0]!.close({ text: "Which schema?" });
    await tick();
    await c.message(id, "Production");
    expect(workers[1]).not.toBe(workers[0]);
    expect(workers[1]!.run).toHaveBeenCalledExactlyOnceWith("Production");
    const pausing = c.pause(id);
    workers[1]!.close({ interrupted: true });
    await pausing;
    await c.continue(id);
    expect(workers[2]!.run).toHaveBeenCalledExactlyOnceWith(
      "Continue the task.",
    );
    expect(factory.mock.calls.map((call) => call[1])).toEqual([
      sessionFile,
      sessionFile,
      sessionFile,
    ]);
    for (const worker of workers) expect(worker.run).toHaveBeenCalledOnce();
    workers[2]!.close();
    await tick();
    await c.dispose();
  });

  it("paused tasks release capacity without implicit resume on a user prompt", async () => {
    const { c, workers, start } = setup();
    const a = start(),
      b = start("queued");
    const interrupted = c.interrupt();
    const later = start("later");
    expect(c.get(b).status).toBe("paused");
    workers[0]!.close({ interrupted: true });
    await interrupted;
    await expect(c.continue(a)).rejects.toThrow("user prompt");
    await c.prompt();
    expect(workers).toHaveLength(1);
    for (const id of [a, b, later]) expect(c.get(id).status).toBe("paused");
    await c.continue(b);
    expect(workers).toHaveLength(2);
    expect(c.get(a).status).toBe("paused");
    workers[1]!.close();
    await tick();
    await c.dispose();
  });

  it("resumes all paused tasks in creation order across the worker limit", async () => {
    const { c, workers, start } = setup();
    const ids = ["first", "second", "third"].map(start);
    const sessions = ids.map((id) => c.get(id).sessionFile);
    const interrupted = c.interrupt();
    workers[0]!.close({ interrupted: true });
    await interrupted;
    await c.prompt();
    for (const task of c.list()) await c.continue(task.id);
    for (let i = 0; i < ids.length; i++) {
      expect(workers).toHaveLength(i + 2);
      expect(workers[i + 1]!.sessionFile).toBe(sessions[i]);
      workers[i + 1]!.close();
      await tick();
    }
    await c.dispose();
  });

  it("a closed paused execution frees capacity without taking the task", async () => {
    const { c, workers, start } = setup();
    const a = start("a"),
      b = start("b");
    const pausing = c.pause(a);
    await tick();
    expect(workers).toHaveLength(1);
    workers[0]!.close({ interrupted: true });
    await pausing;
    expect(c.get(a).status).toBe("paused");
    expect(c.get(b).status).toBe("active");
    expect(workers).toHaveLength(2);
    workers[1]!.close();
    await tick();
    await c.dispose();
  });

  it("admits FIFO and combines corrections while queued", async () => {
    const { c, workers, start } = setup();
    start("a");
    const b = start("b"),
      d = start("d");
    await c.message(b, "correction");
    workers[0]!.close();
    await tick();
    expect(workers[1]!.run).toHaveBeenCalledExactlyOnceWith("b\n\ncorrection");
    expect(c.get(d).status).toBe("queued");
    workers[1]!.close();
    await tick();
    workers[2]!.close();
    await tick();
    await c.dispose();
  });
});

describe("journal expectations across executions", () => {
  it("retains the journal identity and the last usage when continuation preflight fails", async () => {
    const { c, workers, start, factory } = setup();
    const id = start();
    expect(factory.mock.calls[0]![2]).toBeUndefined();
    workers[0]!.close({ sessionId: "native-session", usage: usage(25) });
    await tick();
    await c.message(id, "continue with this correction");
    expect(factory.mock.calls[1]![2]).toBe("native-session");
    workers[1]!.close({
      sessionId: undefined,
      usage: undefined,
      text: "",
      error: "Native session file is missing",
      inputPersisted: false,
    });
    await tick();
    expect(c.get(id)).toMatchObject({
      outcome: "error",
      tokens: 25,
      pendingInput: ["continue with this correction"],
    });
    await c.collect(id);
    expect(c.drainUsage()).toEqual(usage(25));
    await c.dispose();
  });

  it("allows a fresh start after interruption before any journal was created", async () => {
    const { c, workers, start, factory } = setup();
    const id = start();
    const pausing = c.pause(id);
    workers[0]!.close({ interrupted: true, inputPersisted: false });
    await pausing;
    await c.continue(id);
    expect(factory.mock.calls[1]![2]).toBeUndefined();
    expect(workers[1]!.run).toHaveBeenCalledExactlyOnceWith("brief");
    workers[1]!.close({ sessionId: "created-on-retry" });
    await tick();
    await c.dispose();
  });
});

describe("input ownership at close", () => {
  it.each([false, true])(
    "redirect waits for close and requeues old input only if unpersisted (%s)",
    async (inputPersisted) => {
      const { c, workers, start } = setup();
      const id = start("brief");
      const sending = c.message(id, "correction");
      expect(workers[0]!.stop).toHaveBeenCalledOnce();
      await tick();
      expect(workers).toHaveLength(1);
      workers[0]!.physicalClose();
      await tick();
      expect(workers).toHaveLength(1);
      expect(c.get(id).status).toBe("active");
      workers[0]!.close({ interrupted: true, inputPersisted });
      await sending;
      expect(workers).toHaveLength(2);
      expect(workers[1]!.run).toHaveBeenCalledExactlyOnceWith(
        inputPersisted ? "correction" : "brief\n\ncorrection",
      );
      expect(workers[1]!.stop).not.toHaveBeenCalled();
      workers[1]!.close();
      await tick();
      await c.dispose();
    },
  );

  it.each([false, true])(
    "interrupt during redirect cancels restart and retains input (%s)",
    async (inputPersisted) => {
      const { c, workers, start } = setup();
      const id = start("brief");
      const sending = c.message(id, "correction");
      const interrupted = c.interrupt();
      workers[0]!.close({ interrupted: true, inputPersisted });
      await Promise.all([sending, interrupted]);
      expect(workers).toHaveLength(1);
      expect(c.get(id)).toMatchObject({
        status: "paused",
        pendingInput: inputPersisted ? ["correction"] : ["brief", "correction"],
      });
      await c.prompt();
      expect(workers).toHaveLength(1);
      await c.continue(id);
      expect(workers[1]!.run).toHaveBeenCalledExactlyOnceWith(
        inputPersisted ? "correction" : "brief\n\ncorrection",
      );
      workers[1]!.close();
      await tick();
      await c.dispose();
    },
  );
});

describe("final reports and receipts", () => {
  it.each(["collect", "stop", "failure"] as const)(
    "preserves cumulative display and charges each execution once before %s",
    async (take) => {
      const { c, workers, start } = setup();
      const id = start();
      workers[0]!.close({ usage: usage(8, 2) });
      await tick();
      expect(c.drainUsage()).toEqual(usage(8, 2));
      await c.message(id, "next");
      workers[1]!.close({
        usage: usage(12, 3, 10),
        ...(take === "failure" ? { error: "failed" } : {}),
      });
      await tick();
      expect(c.drainUsage()).toEqual(usage(4, 1, 10));
      if (take === "collect") await c.collect(id);
      else if (take === "stop") await c.stop(id);
      else await c.prompt();
      await c.collect(id);
      await c.stop(id);
      await c.prompt();
      expect(c.drainUsage()).toBeUndefined();
      expect(c.summary()).toEqual({
        completed: take === "collect" ? 1 : 0,
        inputTokens: 12,
        outputTokens: 3,
      });
      const receipt = c.inspect(id);
      expect(receipt).not.toHaveProperty("worker");
      expect(receipt).not.toHaveProperty("run");
      expect(receipt).not.toHaveProperty("status");
      structuredClone(receipt);
      await c.dispose();
    },
  );

  it("sweeps final errors without another worker and preserves undelivered input", async () => {
    const { c, workers, start, factory } = setup();
    const id = start("valuable brief");
    workers[0]!.close({
      text: "partial",
      error: "terminated",
      inputPersisted: false,
      usage: usage(7),
    });
    await tick();
    expect(c.get(id)).toMatchObject({ status: "ready", outcome: "error" });
    const deliver = vi.fn();
    await c.prompt(deliver);
    expect(deliver).toHaveBeenCalledWith([
      expect.objectContaining({
        id,
        outcome: "error",
        error: "terminated",
        pendingInput: ["valuable brief"],
      }),
    ]);
    expect(factory).toHaveBeenCalledOnce();
    expect(c.list()).toEqual([]);
    expect(c.inspect(id)).toMatchObject({ pendingInput: ["valuable brief"] });
    expect(c.drainUsage()).toEqual(usage(7));
    await c.dispose();
  });

  it("reconciles streamed counts with saved session usage across continuations", async () => {
    const { c, workers, start } = setup();
    const id = start();
    const stream = (worker: Fake, value: Usage) =>
      worker.emit({
        type: "message_end",
        message: {
          role: "assistant",
          api: "openai-completions",
          provider: "p",
          model: "m",
          content: [],
          stopReason: "stop",
          usage: value,
          timestamp: 0,
        },
      });
    stream(workers[0]!, usage(10, 2, 88));
    expect(c.summary()).toMatchObject({ inputTokens: 10, outputTokens: 2 });
    workers[0]!.close({ usage: usage(12, 3, 185) });
    await tick();
    expect(c.get(id).tokens).toBe(200);

    await c.message(id, "next");
    stream(workers[1]!, usage(5, 4, 41));
    expect(c.summary()).toMatchObject({ inputTokens: 17, outputTokens: 7 });
    workers[1]!.close({ usage: usage(20, 10, 270) });
    await tick();
    expect(c.summary()).toMatchObject({ inputTokens: 20, outputTokens: 10 });
    expect((await c.collect(id)).tokens).toBe(300);
    expect(c.drainUsage()).toEqual(usage(20, 10, 270));

    const next = start("another task");
    workers[2]!.close({ usage: usage(7, 8, 5) });
    await tick();
    await c.collect(next);
    expect(c.summary()).toMatchObject({ inputTokens: 27, outputTokens: 18 });
    await c.dispose();
  });

  it("does not disguise a genuine report failure as a successful pause", async () => {
    const { c, workers, start } = setup();
    const id = start();
    const pausing = c.pause(id);
    workers[0]!.close({
      interrupted: true,
      error: "Corrupt native session file",
      inputPersisted: false,
    });
    await pausing;
    expect(c.get(id)).toMatchObject({
      status: "ready",
      outcome: "error",
      pendingInput: ["brief"],
    });
    const deliver = vi.fn();
    await c.prompt(deliver);
    expect(deliver).toHaveBeenCalledOnce();
    expect(c.list()).toEqual([]);
    await c.dispose();
  });

  it("retains a failed report if delivery throws", async () => {
    const { c, workers, start } = setup();
    const id = start();
    workers[0]!.close({ error: "failed" });
    await tick();
    await expect(
      c.prompt(() => {
        throw Error("delivery failed");
      }),
    ).rejects.toThrow("delivery failed");
    expect(c.get(id).outcome).toBe("error");
    await c.prompt();
    expect(c.inspect(id).outcome).toBe("error");
    await c.dispose();
  });

  it("accepts a normal transformed reply without replaying an unproven literal input", async () => {
    const { c, workers, start } = setup();
    const id = start();
    workers[0]!.close({ inputPersisted: false, text: "transformed reply" });
    await tick();
    expect(c.get(id)).toMatchObject({
      status: "ready",
      outcome: "reply",
      response: "transformed reply",
    });
    expect(c.get(id).pendingInput).toBeUndefined();
    await c.dispose();
  });

  it("retries a failed stop without releasing its process or poisoning collection", async () => {
    const { c, workers, start } = setup();
    const id = start();
    start("queued");
    workers[0]!.stop.mockRejectedValueOnce(Error("termination failed"));
    await expect(c.stop(id)).rejects.toThrow("termination failed");
    expect(c.get(id)).toMatchObject({ status: "active", outcome: "error" });
    expect(workers).toHaveLength(1);
    const retry = c.stop(id);
    workers[0]!.close({ interrupted: true, usage: usage(7) });
    expect(await retry).toMatchObject({ id, outcome: "error" });
    expect(workers).toHaveLength(2);
    expect(c.drainUsage()).toEqual(usage(7));
    workers[1]!.close();
    await tick();
    await c.dispose();
  });

  it("recovers after both an unexpected run rejection and a failed first stop", async () => {
    const { c, workers, start } = setup();
    const id = start();
    start("queued");
    workers[0]!.stop.mockRejectedValueOnce(Error("termination failed"));
    workers[0]!.reject(Error("report transport failed"));
    await tick();
    expect(c.get(id)).toMatchObject({ status: "active", outcome: "error" });
    expect(workers).toHaveLength(1);
    const retry = c.stop(id);
    workers[0]!.physicalClose();
    expect(await retry).toMatchObject({
      outcome: "error",
      pendingInput: ["brief"],
      error: expect.stringContaining("report transport failed"),
    });
    expect(workers).toHaveLength(2);
    workers[1]!.close();
    await tick();
    await c.dispose();
  });

  it("unexpected run rejection is not success and retains ownership until stop closes", async () => {
    const { c, workers, start, onReady } = setup();
    const id = start();
    start("queued");
    workers[0]!.reject(Error("report transport failed"));
    await tick();
    expect(workers[0]!.stop).toHaveBeenCalledOnce();
    expect(workers).toHaveLength(1);
    expect(c.get(id).status).toBe("active");
    expect(onReady).not.toHaveBeenCalled();
    workers[0]!.physicalClose();
    await tick();
    expect(c.get(id)).toMatchObject({
      status: "ready",
      outcome: "error",
      error: "report transport failed",
      pendingInput: ["brief"],
    });
    workers[1]!.close();
    await tick();
    await c.dispose();
  });
});

describe("admission and shutdown", () => {
  it("keeps input and releases admission when event subscription throws", async () => {
    const { c, workers, start, factory } = setup();
    const original = factory.getMockImplementation()!;
    factory.mockImplementationOnce((...args) => {
      const worker = original(...args);
      worker.onEvent = () => {
        throw new Error("subscription failed");
      };
      return worker;
    });
    const id = start("keep this input");
    expect(c.get(id)).toMatchObject({
      status: "ready",
      outcome: "error",
      pendingInput: ["keep this input"],
    });
    expect(workers[0]!.run).not.toHaveBeenCalled();
    const next = start("next");
    expect(c.get(next).status).toBe("active");
    expect(await c.collect(id)).toMatchObject({
      outcome: "error",
      error: "subscription failed",
    });
    workers[1]!.close();
    await tick();
    await c.dispose();
  });

  it("aggregates confirmed usage once and drains independently", async () => {
    const { c, workers, start } = setup();
    const a = start("a");
    workers[0]!.close({
      usage: {
        ...usage(2),
        reasoning: 3,
        cost: { ...usage(2).cost, totalFromProvider: true },
      },
    });
    await tick();
    await c.collect(a);
    await c.collect(a);
    const b = start("b");
    workers[1]!.close({
      usage: {
        ...usage(4),
        cacheWrite1h: 5,
        cost: { ...usage(4).cost, totalFromProvider: false },
      },
    });
    await tick();
    await c.collect(b);
    expect(c.drainUsage()).toMatchObject({
      totalTokens: 6,
      reasoning: 3,
      cacheWrite1h: 5,
      cost: { total: 6, totalFromProvider: false },
    });
    expect(c.drainUsage()).toBeUndefined();
    await c.dispose();
  });

  it("charges only the growth of optional counters across continuations", async () => {
    const { c, workers, start } = setup();
    const id = start();
    workers[0]!.close({ usage: { ...usage(2), reasoning: 3 } });
    await tick();
    c.drainUsage();
    await c.message(id, "next");
    workers[1]!.close({
      usage: { ...usage(5), reasoning: 7, cacheWrite1h: 1 },
    });
    await tick();
    expect(c.drainUsage()).toEqual({
      ...usage(3),
      reasoning: 4,
      cacheWrite1h: 1,
    });
    await c.dispose();
  });

  it("rechecks authorization on queued admission, answers and resume", async () => {
    let approved = true;
    const beforeStart = vi.fn(() => {
      if (!approved) throw Error("revoked");
    });
    const { c, workers, start, factory } = setup(1, beforeStart);
    const a = start(),
      b = start("queued");
    approved = false;
    workers[0]!.close();
    await tick();
    expect(c.get(b)).toMatchObject({ outcome: "error", error: "revoked" });
    await c.message(a, "answer");
    expect(c.get(a)).toMatchObject({
      outcome: "error",
      error: "revoked",
      pendingInput: ["answer"],
    });
    approved = true;
    const d = start("pause me");
    const pausing = c.pause(d);
    workers[1]!.close({ interrupted: true });
    await pausing;
    approved = false;
    await c.continue(d);
    expect(c.get(d)).toMatchObject({ outcome: "error", error: "revoked" });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(beforeStart).toHaveBeenCalledTimes(5);
    await c.dispose();
  });

  it("stops queued work before it starts and returns independent idempotent receipts", async () => {
    const { c, workers, start } = setup();
    start("active");
    const id = start("never started");
    const result = await c.stop(id);
    expect(result).toMatchObject({
      outcome: "stopped",
      pendingInput: ["never started"],
    });
    expect(workers).toHaveLength(1);
    result.execution.model = "mutated";
    expect(c.inspect(id).execution.model).toBe("m");
    expect(await c.stop(id)).toEqual(await c.collect(id));
    workers[0]!.close();
    await tick();
    await c.dispose();
  });

  it.each(["stop", "dispose"] as const)(
    "%s waits for physical close even before any native start event",
    async (action) => {
      const { c, workers, start } = setup();
      const id = start();
      let done = false;
      const closing = (action === "stop" ? c.stop(id) : c.dispose()).then(
        () => {
          done = true;
        },
      );
      await tick();
      expect(done).toBe(false);
      expect(workers[0]!.stop).toHaveBeenCalledOnce();
      workers[0]!.close({ interrupted: true, inputPersisted: false });
      await closing;
      expect(c.list()).toEqual([]);
      if (action === "stop")
        expect(c.inspect(id)).toMatchObject({
          outcome: "stopped",
          pendingInput: ["brief"],
        });
      await c.dispose();
    },
  );

  it("wait supports abort, timeout, and final report completion", async () => {
    const { c, workers, start } = setup();
    const id = start();
    const abort = new AbortController();
    const waiting = c.wait(id, abort.signal);
    abort.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    await expect(c.wait(id, undefined, 1)).rejects.toThrow("timed out");
    const final = c.wait(id);
    workers[0]!.close();
    await expect(final).resolves.toMatchObject({ status: "ready" });
    await c.dispose();
  });
});
