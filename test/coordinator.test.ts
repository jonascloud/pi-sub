import { describe, expect, it, vi } from "vitest";
import type { Usage } from "@earendil-works/pi-ai";
import { Coordinator } from "../src/coordinator.ts";
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

/** A report exists only once the process has ended, also when it was stopped. */
class Fake implements Worker {
  private report = Promise.withResolvers<WorkerReport>();
  private listener: (event: WorkerEvent) => void = () => {};
  constructor(
    readonly sessionFile: string,
    readonly continues: boolean,
  ) {}
  run = vi.fn((_input: string) => this.report.promise);
  stop = vi.fn(async () => {
    await this.report.promise;
  });
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
    this.report.resolve({
      text: "answer",
      interrupted: false,
      inputPersisted: true,
      saved: true,
      sessionLost: false,
      ...report,
    });
  }
}
function setup(maxWorkers = 1) {
  const workers: Fake[] = [];
  const onSettled = vi.fn();
  const c = new Coordinator({
    maxWorkers,
    createWorker: (_options, sessionFile, continues) => {
      const worker = new Fake(sessionFile, continues ?? false);
      workers.push(worker);
      return worker;
    },
    onSettled,
  });
  const start = (prompt = "brief") =>
    c.start({ prompt, description: prompt, level: 3, worker: options });
  return { c, workers, start, onSettled };
}

describe("a task is a conversation on one session", () => {
  it("replies, continues on the same session with a fresh process, and is removed on acceptance", async () => {
    const { c, workers, start, onSettled } = setup();
    const id = start();
    expect(c.get(id)).toMatchObject({ status: "active", unsent: 0 });
    expect(workers[0]!.run).toHaveBeenCalledExactlyOnceWith("brief");
    expect(workers[0]!.continues).toBe(false);
    workers[0]!.emit({ type: "agent_settled", aborted: false } as WorkerEvent);
    expect(c.get(id).status).toBe("active"); // Only process exit ends an execution.
    workers[0]!.close({ text: "Which schema?" });
    await tick();
    expect(c.get(id)).toMatchObject({
      status: "ready",
      response: "Which schema?",
      delivered: false,
    });
    expect(onSettled).toHaveBeenCalledOnce();
    c.markDelivered(id);
    expect(c.get(id).delivered).toBe(true);

    await c.message(id, "Production");
    expect(c.get(id)).toMatchObject({
      status: "active",
      response: "",
      delivered: false,
    });
    expect(workers[1]!.sessionFile).toBe(workers[0]!.sessionFile);
    expect(workers[1]!.continues).toBe(true);
    expect(workers[1]!.run).toHaveBeenCalledExactlyOnceWith("Production");
    workers[1]!.close({ text: "Checked production." });
    await tick();
    expect(c.accept(id)).toMatchObject({
      status: "accepted",
      response: "Checked production.",
    });
    expect(c.list()).toEqual([]);
    expect(() => c.get(id)).toThrow("Unknown task");
    await c.dispose();
  });

  it("runs up to the limit in creation order and combines corrections while queued", async () => {
    const { c, workers, start } = setup();
    const a = start("a"),
      b = start("b"),
      d = start("d");
    await c.message(b, "also this");
    expect(c.list().map((task) => task.status)).toEqual([
      "active",
      "queued",
      "queued",
    ]);
    expect(c.get(b).unsent).toBe(2);
    workers[0]!.close();
    await tick();
    expect(c.get(a).status).toBe("ready"); // A ready task holds no slot.
    expect(workers[1]!.run).toHaveBeenCalledExactlyOnceWith("b\n\nalso this");
    workers[1]!.close();
    await tick();
    expect(c.get(d).status).toBe("active");
    workers[2]!.close();
    await tick();
    await c.dispose();
  });

  it("only settled tasks can be accepted", async () => {
    const { c, workers, start } = setup();
    const id = start();
    expect(() => c.accept(id)).toThrow("Cannot accept a active task");
    workers[0]!.close({ error: "failed" });
    await tick();
    expect(c.accept(id)).toMatchObject({ status: "accepted", error: "failed" });
    await c.dispose();
  });
});

describe("pausing and redirecting", () => {
  it("pausing every task holds queued work too, and each continues on its own", async () => {
    const { c, workers, start } = setup();
    const ids = ["first", "second", "third"].map(start);
    const pausing = Promise.all(c.list().map((task) => c.pause(task.id)));
    expect(c.get(ids[1]!).status).toBe("paused");
    workers[0]!.close({ interrupted: true });
    await pausing;
    expect(workers).toHaveLength(1); // The freed slot admits nothing paused with it.
    for (const id of ids) expect(c.get(id).status).toBe("paused");
    const later = start("later"); // New work is not held back.
    expect(c.get(later).status).toBe("active");
    for (const id of ids) c.continue(id);
    expect(() => c.continue(later)).toThrow("not paused");
    workers[1]!.close();
    for (let i = 0; i < ids.length; i++) {
      await tick();
      expect(workers[i + 2]!.sessionFile).toBe(c.get(ids[i]!).sessionFile);
      // Only the interrupted one had received its brief.
      expect(workers[i + 2]!.run).toHaveBeenCalledExactlyOnceWith(
        ["Continue the task.", "second", "third"][i],
      );
      workers[i + 2]!.close();
    }
    await tick();
    await c.dispose();
  });

  it.each([false, true])(
    "a message to an active task ends its process and sends again what the session never saved (saved=%s)",
    async (inputPersisted) => {
      const { c, workers, start } = setup();
      const id = start("brief");
      const sending = c.message(id, "correction");
      expect(workers[0]!.stop).toHaveBeenCalledOnce();
      expect(workers).toHaveLength(1); // Never two processes on one session.
      workers[0]!.close({ interrupted: true, inputPersisted });
      await sending;
      expect(c.get(id).status).toBe("active");
      expect(workers[1]!.run).toHaveBeenCalledExactlyOnceWith(
        inputPersisted ? "correction" : "brief\n\ncorrection",
      );
      workers[1]!.close();
      await tick();
      await c.dispose();
    },
  );

  it("a pause during a redirect wins and keeps the correction for the continuation", async () => {
    const { c, workers, start } = setup();
    const id = start("brief");
    const sending = c.message(id, "correction");
    const pausing = c.pause(id);
    workers[0]!.close({ interrupted: true });
    await Promise.all([sending, pausing]);
    expect(workers).toHaveLength(1);
    expect(c.get(id)).toMatchObject({ status: "paused", unsent: 1 });
    c.continue(id);
    expect(workers[1]!.run).toHaveBeenCalledExactlyOnceWith("correction");
    workers[1]!.close();
    await tick();
    await c.dispose();
  });

  it("a process that finished before the pause reached it keeps its reply", async () => {
    const { c, workers, start, onSettled } = setup();
    const id = start();
    const pausing = c.pause(id);
    workers[0]!.close({ text: "done", interrupted: false });
    await pausing;
    expect(c.get(id)).toMatchObject({ status: "ready", response: "done" });
    expect(onSettled).toHaveBeenCalledOnce();
    await c.dispose();
  });
});

describe("failures", () => {
  it("a failed execution keeps its task, session and unsent input for a retry", async () => {
    const { c, workers, start, onSettled } = setup();
    const id = start("valuable brief");
    workers[0]!.close({
      text: "partial",
      error: "Native process exited 1",
      inputPersisted: false,
    });
    await tick();
    expect(c.get(id)).toMatchObject({
      status: "failed",
      error: "Native process exited 1",
      response: "partial",
      unsent: 1,
      delivered: false,
    });
    expect(onSettled).toHaveBeenCalledOnce();
    c.markDelivered(id);

    await c.message(id, "Retry.");
    const retried = c.get(id);
    expect(retried).toMatchObject({ status: "active", delivered: false });
    expect(retried).not.toHaveProperty("error");
    expect(workers[1]!.sessionFile).toBe(workers[0]!.sessionFile);
    expect(workers[1]!.run).toHaveBeenCalledExactlyOnceWith(
      "valuable brief\n\nRetry.",
    );
    workers[1]!.close({ text: "done" });
    await tick();
    expect(c.get(id)).toMatchObject({ status: "ready", response: "done" });
    await c.dispose();
  });

  it("a first start that saved nothing starts again; a lost session is final", async () => {
    const { c, workers, start } = setup();
    const id = start();
    workers[0]!.close({
      error: "Spawn failed",
      saved: false,
      inputPersisted: false,
    });
    await tick();
    await c.message(id, "Again.");
    expect(workers[1]!.continues).toBe(false);
    workers[1]!.close();
    await tick();
    await c.message(id, "More.");
    expect(workers[2]!.continues).toBe(true);
    workers[2]!.close({
      error: "Native session file is missing",
      inputPersisted: false,
      saved: false,
      sessionLost: true,
    });
    await tick();
    expect(c.get(id)).toMatchObject({
      status: "failed",
      error: "Native session file is missing; the session cannot continue",
      unsent: 1,
    });
    await expect(c.message(id, "Retry.")).rejects.toThrow("session is lost");
    expect(workers).toHaveLength(3);
    expect(await c.stop(id)).toMatchObject({ status: "stopped", unsent: 1 });
    await c.dispose();
  });
});

describe("stopping", () => {
  it("waits for the process, removes the task and frees its slot", async () => {
    const { c, workers, start, onSettled } = setup();
    const id = start();
    const queued = start("queued");
    let stopped = false;
    const stopping = c.stop(id).then((view) => {
      stopped = true;
      return view;
    });
    await expect(c.message(id, "too late")).rejects.toThrow("stopping");
    await tick();
    expect(stopped).toBe(false);
    expect(workers).toHaveLength(1);
    workers[0]!.close({ interrupted: true, inputPersisted: false });
    expect(await stopping).toMatchObject({ id, status: "stopped", unsent: 1 });
    expect(c.list().map((task) => task.id)).toEqual([queued]);
    expect(c.get(queued).status).toBe("active");
    expect(onSettled).not.toHaveBeenCalled();
    // Work that never started stops at once.
    const waiting = start("waiting");
    expect(await c.stop(waiting)).toMatchObject({ status: "stopped" });
    workers[1]!.close();
    await tick();
    await c.dispose();
  });

  it("dispose ends every process before it resolves", async () => {
    const { c, workers, start } = setup(2);
    start();
    start();
    let done = false;
    const disposing = c.dispose().then(() => {
      done = true;
    });
    await tick();
    expect(done).toBe(false);
    for (const worker of workers) {
      expect(worker.stop).toHaveBeenCalledOnce();
      worker.close({ interrupted: true });
    }
    await disposing;
    expect(c.list()).toEqual([]);
    expect(() => start()).toThrow("disposed");
  });
});

describe("retained reports", () => {
  it("keeps immutable full reports across continuations and removal until disposal", async () => {
    const { c, workers, start } = setup();
    const id = start();
    const response = "é".repeat(4000);
    const error = "failure ".repeat(500);
    workers[0]!.close({ text: response, error });
    await tick();
    const first = c.get(id);
    expect(Buffer.byteLength(first.response)).toBeLessThanOrEqual(512);
    expect(Buffer.byteLength(first.error!)).toBeLessThanOrEqual(240);
    const ref = first.report!;
    expect(ref).toBeDefined();
    const original = ref.id;
    first.report!.id = "modified";
    expect(c.get(id).report!.id).toBe(original);
    let text = "",
      offset: number | undefined = 0;
    do {
      const part = c.reports.read(original, offset);
      text += part.text;
      offset = part.next;
    } while (offset !== undefined);
    expect(JSON.parse(text)).toMatchObject({ response, error });
    await c.message(id, "continue");
    expect(c.get(id).report).toBeUndefined();
    workers[1]!.close({ text: "next" });
    await tick();
    const next = c.accept(id).report!;
    expect(next.id).not.toBe(original);
    expect(c.reports.read(original).text).toBe(
      text.slice(0, c.reports.read(original).text.length),
    );
    expect(JSON.parse(c.reports.read(next.id).text).response).toBe("next");
    await c.dispose();
    expect(() => c.reports.read(original)).toThrow();
  });

  it("captures stopped executions and does not treat streamed previews as journal output", async () => {
    const { c, workers, start } = setup();
    const id = start();
    workers[0]!.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "x".repeat(4000) }],
        stopReason: "stop",
        usage: usage(0),
      },
    } as unknown as WorkerEvent);
    expect(Buffer.byteLength(c.get(id).response)).toBeLessThanOrEqual(512);
    const stopping = c.stop(id);
    workers[0]!.close({ text: "", interrupted: true });
    const view = await stopping;
    expect(view.response).toBe("");
    expect(JSON.parse(c.reports.read(view.report!.id).text)).toMatchObject({
      status: "stopped",
      response: "",
    });
    await c.dispose();
  });

  it("removes a queued task synchronously before a message can start it", async () => {
    const { c, workers, start } = setup();
    const active = start();
    const queued = start("queued");
    const stopping = c.stop(queued);
    await expect(c.message(queued, "late")).rejects.toThrow("Unknown task");
    await stopping;
    workers[0]!.close();
    await tick();
    expect(workers).toHaveLength(1);
    await c.stop(active);
    await c.dispose();
  });

  it("preserves the worker limit when observers synchronously queue work", async () => {
    const { c, workers, start } = setup(2);
    const first = start("first");
    let added = false;
    c.subscribe(() => {
      if (
        !added &&
        c
          .list()
          .some(
            (task) => task.description === "second" && task.status === "active",
          )
      ) {
        added = true;
        start("third");
      }
    });
    start("second");
    expect(workers).toHaveLength(2);
    expect(c.list().find((task) => task.description === "third")?.status).toBe(
      "queued",
    );
    workers[0]!.close();
    await tick();
    expect(workers).toHaveLength(3);
    workers[1]!.close();
    workers[2]!.close();
    await tick();
    await c.stop(first);
    await c.dispose();
  });

  it("admits queued work even if onSettled throws", async () => {
    const workers: Fake[] = [];
    const c = new Coordinator({
      maxWorkers: 1,
      createWorker: (_options, file, continues) => {
        const worker = new Fake(file, continues ?? false);
        workers.push(worker);
        return worker;
      },
      onSettled: () => {
        throw new Error("observer");
      },
    });
    const start = () =>
      c.start({
        prompt: "work",
        description: "work",
        level: 1,
        worker: options,
      });
    start();
    start();
    workers[0]!.close();
    await tick();
    expect(workers).toHaveLength(2);
    workers[1]!.close();
    await tick();
    await c.dispose();
  });

  it("survives capture failure and admits queued work", async () => {
    const { c, workers, start } = setup();
    const id = start();
    start("queued");
    vi.spyOn(c.reports, "put").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    workers[0]!.close({ text: "x".repeat(5000) });
    await tick();
    expect(c.get(id)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Report capture failed"),
    });
    expect(c.get(id).report).toBeUndefined();
    expect(Buffer.byteLength(c.get(id).response)).toBeLessThanOrEqual(512);
    expect(workers).toHaveLength(2);
    workers[1]!.close();
    await tick();
    await c.dispose();
  });
});

describe("usage", () => {
  it("charges the growth of each session snapshot once and keeps totals of removed tasks", async () => {
    const { c, workers, start } = setup();
    const id = start();
    workers[0]!.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "streamed" }],
        stopReason: "stop",
        usage: usage(10, 2, 88),
      },
    } as unknown as WorkerEvent);
    expect(c.get(id)).toMatchObject({ response: "streamed", tokens: 100 });
    expect(c.summary()).toEqual({ inputTokens: 10, outputTokens: 2 });
    expect(c.drainUsage()).toBeUndefined(); // Streamed counts are not confirmed.
    workers[0]!.close({ usage: usage(12, 3, 185) });
    await tick();
    expect(c.get(id).tokens).toBe(200);
    expect(c.drainUsage()).toEqual(usage(12, 3, 185));
    expect(c.drainUsage()).toBeUndefined();

    await c.message(id, "next");
    workers[1]!.close({ usage: usage(20, 10, 270), error: "failed" });
    await tick();
    expect(c.drainUsage()).toEqual(usage(8, 7, 85)); // Failed work is charged too.
    await c.message(id, "again");
    workers[2]!.close({ usage: undefined, error: "unreadable" });
    await tick();
    expect(c.get(id).tokens).toBe(300); // The last confirmed snapshot stands.
    expect(c.drainUsage()).toBeUndefined();
    await c.stop(id);
    expect(c.summary()).toEqual({ inputTokens: 20, outputTokens: 10 });
    await c.dispose();
  });
});

describe("waiting observes", () => {
  it("until the task settles, pauses or the timeout passes, and never changes it", async () => {
    const { c, workers, start } = setup();
    const id = start();
    expect(await c.wait(id, undefined, 1)).toMatchObject({ status: "active" });
    const abort = new AbortController();
    const aborted = c.wait(id, abort.signal);
    abort.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    expect(() => c.wait("unknown")).toThrow("Unknown task");

    const paused = c.wait(id);
    const pausing = c.pause(id);
    workers[0]!.close({ interrupted: true });
    await pausing;
    expect(await paused).toMatchObject({ status: "paused" });
    c.continue(id);
    const settled = c.wait(id);
    workers[1]!.close({ error: "failed" });
    expect(await settled).toMatchObject({ status: "failed" });
    expect(await c.wait(id)).toMatchObject({ status: "failed" });

    const other = start("other");
    const removed = c.wait(other);
    const stopping = c.stop(other);
    workers[2]!.close({ interrupted: true });
    await stopping;
    await expect(removed).rejects.toThrow("Task was stopped");
    await c.dispose();
  });
});
