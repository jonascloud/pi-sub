import { describe, expect, it, vi } from "vitest";
import type { Usage } from "@earendil-works/pi-ai";
import { Coordinator } from "../src/coordinator.ts";
import type { Worker, WorkerEvent, WorkerOptions } from "../src/worker.ts";

const options: WorkerOptions = {
  cwd: "/",
  provider: "p",
  model: "m",
  thinking: "off",
  name: "test",
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const usage: Usage = {
  input: 1,
  output: 2,
  cacheRead: 3,
  cacheWrite: 4,
  reasoning: 2,
  cacheWrite1h: 1,
  totalTokens: 10,
  cost: {
    input: 1,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
    total: 10,
    totalFromProvider: true,
  },
};
class Fake implements Worker {
  listener: (event: WorkerEvent) => void = () => {};
  active = false;
  text = "";
  billed?: Usage;
  start = vi.fn(async () => {});
  send = vi.fn(async (_text: string): Promise<"started" | "queued"> => {
    this.emit({ type: "agent_start" });
    return "started";
  });
  pause = vi.fn(async () => {
    const cleared = {
      steering: ["cleared steering"],
      followUp: ["cleared follow-up"],
    };
    this.emit({ type: "worker_queue_cleared", ...cleared });
    if (this.active) this.assistant("", "aborted");
    this.emit({ type: "agent_settled", aborted: true });
    return cleared;
  });
  report = vi.fn(async () => {
    if (this.active) throw new Error("Cannot report while worker is active");
    return { text: this.text, usage: this.billed, sessionFile: "native.jsonl" };
  });
  close = vi.fn(async () => {
    this.active = false;
  });
  onEvent(listener: (event: WorkerEvent) => void) {
    this.listener = listener;
    return () => {
      this.listener = () => {};
    };
  }
  emit(event: WorkerEvent) {
    if (event.type === "agent_start") this.active = true;
    if (event.type === "agent_settled") this.active = false;
    this.listener(event);
    if (event.type === "agent_settled")
      this.listener({ type: "worker_state", idle: !this.active });
  }
  assistant(text: string, stopReason: "stop" | "error" | "aborted" = "stop") {
    this.text = text;
    this.billed = usage;
    this.emit({
      type: "message_end",
      message: {
        role: "assistant",
        api: "openai-responses",
        provider: "p",
        model: "m",
        timestamp: 0,
        content: [{ type: "text", text }],
        usage,
        stopReason,
        ...(stopReason === "error" ? { errorMessage: "retryable" } : {}),
      },
    });
  }
  finish(text = "answer") {
    this.assistant(text);
    this.emit({ type: "agent_settled", aborted: false });
  }
  fatal(error = "terminated") {
    this.active = false;
    this.billed = usage;
    this.text = "partial answer";
    this.emit({ type: "worker_error", error });
  }
}
function setup(maxWorkers = 1) {
  const workers: Fake[] = [];
  const onReady = vi.fn();
  const c = new Coordinator({
    maxWorkers,
    onReady,
    createWorker: () => {
      const worker = new Fake();
      workers.push(worker);
      return worker;
    },
  });
  const start = (prompt = "task") =>
    c.start({ prompt, description: prompt, level: 3, worker: options });
  return { c, workers, start, onReady };
}

describe("native task ownership", () => {
  it("admits FIFO only when resident workers are released and combines queued corrections", async () => {
    const { c, workers, start } = setup();
    const a = start("a"),
      b = start("b"),
      d = start("d");
    await tick();
    workers[0]!.finish();
    await tick();
    expect(workers).toHaveLength(1);
    expect(c.get(a)).toMatchObject({ status: "ready", outcome: "reply" });
    await c.message(b, "correction");
    await c.collect(a);
    await tick();
    expect(c.list().map((task) => task.id)).toEqual([d, b]);
    expect(workers[1]!.send).toHaveBeenCalledWith("b\n\ncorrection");
    expect(c.summary()).toMatchObject({ completed: 1, tokens: 10 });
    await c.dispose();
  });
  it("retains a question until accepted and stores only an idempotent result receipt afterward", async () => {
    const { c, workers, start } = setup();
    const id = start();
    await tick();
    workers[0]!.finish("Which schema?");
    await c.wait(id);
    expect(workers[0]!.close).not.toHaveBeenCalled();
    await c.message(id, "Production schema");
    expect(c.get(id).status).toBe("active");
    workers[0]!.finish("Final result");
    const result = await c.collect(id);
    expect(result).toMatchObject({
      outcome: "reply",
      response: "Final result",
    });
    expect(result).not.toHaveProperty("status");
    expect(result).not.toHaveProperty("operation");
    expect(c.list()).toEqual([]);
    expect(() => c.get(id)).toThrow("Unknown live task");
    expect(await c.collect(id)).toEqual(result);
    expect(c.inspect(id)).toEqual(result);
    expect(c.drainUsage()).toEqual(usage);
    expect(c.drainUsage()).toBeUndefined();
    expect(workers[0]!.close).toHaveBeenCalledOnce();
    await c.dispose();
  });
  it("uses native settlement, not intermediate request failures, for finality", async () => {
    const { c, workers, start } = setup();
    const id = start();
    await tick();
    workers[0]!.assistant("", "error");
    expect(c.get(id)).toMatchObject({ status: "active" });
    expect(c.get(id).error).toBeUndefined();
    workers[0]!.finish("Recovered");
    expect(c.get(id)).toMatchObject({
      status: "ready",
      outcome: "reply",
      response: "Recovered",
    });
    await c.dispose();
  });
  it("rechecks authorization immediately before queued admission", async () => {
    let approved = true;
    const worker = new Fake();
    const factory = vi.fn(() => worker);
    const c = new Coordinator({
      maxWorkers: 1,
      createWorker: factory,
      beforeStart: () => {
        if (!approved) throw Error("revoked");
      },
    });
    const a = c.start({ prompt: "a", description: "a", worker: options });
    const b = c.start({ prompt: "b", description: "b", worker: options });
    await tick();
    approved = false;
    worker.finish();
    await c.collect(a);
    await tick();
    expect(factory).toHaveBeenCalledOnce();
    expect(c.get(b)).toMatchObject({
      status: "ready",
      outcome: "error",
      error: "revoked",
    });
    await c.prompt();
    expect(() => c.get(b)).toThrow();
    await c.dispose();
  });
});

describe("input handoff", () => {
  it("does not publish an old settled response while a new started handoff is unresolved", async () => {
    const { c, workers, start, onReady } = setup();
    const id = start();
    await tick();
    const worker = workers[0]!;
    const ack = Promise.withResolvers<"started">();
    worker.send.mockImplementationOnce(() => ack.promise);
    const sending = c.message(id, "next");
    await tick();
    worker.emit({ type: "agent_settled", aborted: false });
    expect(c.get(id).status).toBe("active");
    expect(onReady).not.toHaveBeenCalled();
    await expect(c.collect(id)).rejects.toThrow("Cannot collect");
    worker.emit({ type: "agent_start" });
    ack.resolve("started");
    await sending;
    expect(c.get(id).status).toBe("active");
    expect(onReady).not.toHaveBeenCalled();
    worker.finish("new result");
    expect(c.get(id)).toMatchObject({
      status: "ready",
      response: "new result",
    });
    expect(onReady).toHaveBeenCalledOnce();
    await c.dispose();
  });
  it("publishes a fast new run that starts and settles before the send continuation", async () => {
    const { c, workers, start, onReady } = setup();
    const id = start();
    await tick();
    const worker = workers[0]!;
    const ack = Promise.withResolvers<"started">();
    worker.send.mockImplementationOnce(() => ack.promise);
    const sending = c.message(id, "next");
    await tick();
    worker.emit({ type: "agent_settled", aborted: false });
    worker.emit({ type: "agent_start" });
    worker.finish("fast result");
    expect(onReady).not.toHaveBeenCalled();
    ack.resolve("started");
    await sending;
    expect(c.get(id)).toMatchObject({
      status: "ready",
      response: "fast result",
    });
    expect(onReady).toHaveBeenCalledOnce();
    await c.dispose();
  });
  it("publishes a queued handoff whose existing run settles before acknowledgement", async () => {
    const { c, workers, start } = setup();
    const id = start();
    await tick();
    const worker = workers[0]!;
    const ack = Promise.withResolvers<"queued">();
    worker.send.mockImplementationOnce(() => ack.promise);
    const sending = c.message(id, "steer");
    await tick();
    worker.finish("steered result");
    ack.resolve("queued");
    await sending;
    expect(c.get(id)).toMatchObject({
      status: "ready",
      response: "steered result",
    });
    await c.dispose();
  });
});

describe("user interrupt and prompt", () => {
  it("interrupts resident work, prevents queued admission and keeps children paused after a prompt", async () => {
    const { c, workers, start } = setup();
    const a = start(),
      b = start();
    await tick();
    const interrupted = c.interrupt();
    expect(c.get(b).status).toBe("paused");
    await interrupted;
    expect(c.get(a).status).toBe("paused");
    expect(c.interrupted).toBe(true);
    const later = start("after interrupt");
    expect(c.get(later).status).toBe("paused");
    await expect(c.continue(a)).rejects.toThrow("user prompt");
    expect(await c.prompt()).toBe(true);
    expect(c.interrupted).toBe(false);
    expect(c.get(a).status).toBe("paused");
    expect(c.get(b).status).toBe("paused");
    expect(workers).toHaveLength(1);
    await c.continue(a);
    expect(workers[0]!.send).toHaveBeenLastCalledWith(
      "cleared steering\n\ncleared follow-up",
    );
    await c.stop(a);
    await c.continue(b);
    await tick();
    expect(workers).toHaveLength(2);
    await c.dispose();
  });
  it("does not send the initial task when interrupted during startup", async () => {
    const gate = Promise.withResolvers<void>();
    const worker = new Fake();
    worker.start.mockImplementation(() => gate.promise);
    const c = new Coordinator({ createWorker: () => worker });
    const id = c.start({
      prompt: "initial",
      description: "initial",
      worker: options,
    });
    await tick();
    const interrupted = c.interrupt();
    gate.resolve();
    await interrupted;
    expect(worker.send).not.toHaveBeenCalled();
    expect(c.get(id).pendingInput).toContain("initial");
    await c.dispose();
  });
  it("preserves cleared input when abort fails", async () => {
    const { c, workers, start } = setup();
    const id = start();
    await tick();
    const worker = workers[0]!;
    worker.pause.mockImplementation(async () => {
      worker.active = false;
      worker.emit({
        type: "worker_queue_cleared",
        steering: ["important"],
        followUp: [],
      });
      throw Error("abort failed");
    });
    await expect(c.interrupt()).rejects.toThrow("abort failed");
    await tick();
    expect(c.get(id)).toMatchObject({
      status: "ready",
      outcome: "error",
      pendingInput: ["important"],
    });
    await c.dispose();
  });
  it("closes final failures immediately, then transfers and removes them on user prompt without model action", async () => {
    const { c, workers, start } = setup();
    const id = start();
    await tick();
    workers[0]!.fatal();
    await tick();
    expect(workers[0]!.close).toHaveBeenCalledOnce();
    expect(c.get(id)).toMatchObject({
      status: "ready",
      outcome: "error",
      response: "partial answer",
    });
    const deliver = vi.fn();
    expect(await c.prompt(deliver)).toBe(true);
    expect(deliver).toHaveBeenCalledWith([
      expect.objectContaining({
        id,
        outcome: "error",
        error: "terminated",
        sessionFile: "native.jsonl",
      }),
    ]);
    expect(c.list()).toEqual([]);
    expect(c.summary()).toEqual({ completed: 0, tokens: 0 });
    expect(c.drainUsage()).toEqual(usage);
    await c.collect(id);
    expect(c.drainUsage()).toBeUndefined();
    await c.prompt(deliver);
    expect(deliver).toHaveBeenLastCalledWith([]);
    await c.dispose();
  });
  it("does not let an interrupt during cleanup restart the parent or lose the pending report", async () => {
    const { c, workers, start } = setup();
    const id = start();
    await tick();
    const gate = Promise.withResolvers<void>();
    workers[0]!.close.mockImplementation(() => gate.promise);
    workers[0]!.fatal();
    await tick();
    const deliver = vi.fn();
    const prompt = c.prompt(deliver);
    await tick();
    await c.interrupt();
    gate.resolve();
    expect(await prompt).toBe(false);
    await tick();
    expect(deliver).not.toHaveBeenCalled();
    expect(c.interrupted).toBe(true);
    expect(c.get(id).outcome).toBe("error");
    expect(await c.prompt(deliver)).toBe(true);
    expect(deliver).toHaveBeenCalledOnce();
    expect(c.list()).toEqual([]);
    await c.dispose();
  });
  it("retains ownership after a failed close and retries it before forwarding a prompt", async () => {
    const { c, workers, start } = setup();
    const id = start();
    await tick();
    workers[0]!.close.mockRejectedValueOnce(new Error("close failed"));
    workers[0]!.fatal();
    await tick();
    start("queued behind failed close");
    expect(workers).toHaveLength(1);
    await c.prompt();
    await tick();
    expect(() => c.get(id)).toThrow();
    expect(workers).toHaveLength(2);
    expect(c.inspect(id)).toMatchObject({
      outcome: "error",
      error: expect.stringContaining("Close failed"),
    });
    expect(c.drainUsage()).toEqual(usage);
    await c.dispose();
  });
  it("captures late native usage after process shutdown, not just the live snapshot", async () => {
    const { c, workers, start } = setup();
    const id = start();
    await tick();
    const worker = workers[0]!;
    worker.finish();
    const finalUsage = {
      ...usage,
      input: 11,
      totalTokens: 20,
      cost: { ...usage.cost, total: 20 },
    };
    worker.close.mockImplementation(async () => {
      worker.active = false;
      worker.billed = finalUsage;
    });
    await c.collect(id);
    expect(c.drainUsage()).toEqual(finalUsage);
    expect(c.summary().tokens).toBe(10);
    await c.dispose();
  });
  it("retries a failed stop without retaining a rejected take promise", async () => {
    const { c, workers, start } = setup();
    const id = start();
    await tick();
    workers[0]!.close.mockRejectedValueOnce(Error("temporary close failure"));
    await expect(c.stop(id)).rejects.toThrow("temporary close failure");
    expect(c.get(id).outcome).toBe("error");
    expect(await c.stop(id)).toMatchObject({ outcome: "error" });
    expect(workers[0]!.close).toHaveBeenCalledTimes(2);
    expect(c.list()).toEqual([]);
    await c.dispose();
  });
  it("keeps undelivered inputs in the transferred failure and idempotent receipt", async () => {
    const worker = new Fake();
    worker.send.mockRejectedValueOnce(Error("send failed"));
    const c = new Coordinator({ createWorker: () => worker });
    const id = c.start({
      prompt: "valuable undelivered input",
      description: "task",
      worker: options,
    });
    await tick();
    const deliver = vi.fn();
    await c.prompt(deliver);
    expect(deliver).toHaveBeenCalledWith([
      expect.objectContaining({ pendingInput: ["valuable undelivered input"] }),
    ]);
    expect(c.inspect(id)).toMatchObject({
      pendingInput: ["valuable undelivered input"],
    });
    await c.dispose();
  });
  it("keeps a report when delivery fails", async () => {
    const { c, workers, start } = setup();
    const id = start();
    await tick();
    workers[0]!.fatal();
    await tick();
    await expect(
      c.prompt(() => {
        throw Error("delivery failed");
      }),
    ).rejects.toThrow("delivery failed");
    expect(c.get(id).outcome).toBe("error");
    expect(c.drainUsage()).toBeUndefined();
    await c.prompt();
    expect(c.inspect(id)).toMatchObject({ outcome: "error" });
    await c.dispose();
  });
  it("captures original abort usage and removes stopped tasks", async () => {
    const { c, workers, start } = setup();
    const id = start();
    await tick();
    expect(await c.stop(id)).toMatchObject({ outcome: "stopped" });
    expect(c.list()).toEqual([]);
    expect(workers[0]!.pause).toHaveBeenCalledOnce();
    expect(c.drainUsage()).toEqual(usage);
    await c.stop(id);
    expect(c.drainUsage()).toBeUndefined();
    expect(c.summary().completed).toBe(0);
    await c.dispose();
  });
  it("releases waiters on shutdown without waiting for startup", async () => {
    const gate = Promise.withResolvers<void>();
    const worker = new Fake();
    worker.start.mockImplementation(() => gate.promise);
    const c = new Coordinator({ createWorker: () => worker });
    const id = c.start({
      prompt: "task",
      description: "task",
      worker: options,
    });
    await tick();
    const waiting = c.wait(id);
    void waiting.catch(() => {});
    await c.dispose();
    await expect(waiting).rejects.toThrow("disposed");
    gate.resolve();
    await tick();
    expect(worker.send).not.toHaveBeenCalled();
    expect(worker.report).not.toHaveBeenCalled();
    expect(worker.close).toHaveBeenCalledOnce();
  });
});
