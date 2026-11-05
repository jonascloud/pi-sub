import { randomUUID } from "node:crypto";
import type { Usage } from "@earendil-works/pi-ai";
import {
  createWorker,
  type Worker,
  type WorkerOptions,
  type WorkerEvent,
} from "./worker.ts";

export type TaskStatus =
  | "queued"
  | "starting"
  | "running"
  | "ready"
  | "pausing"
  | "paused"
  | "error"
  | "closed";
export interface TaskView {
  id: string;
  description: string;
  level?: number;
  execution: {
    provider: string;
    model: string;
    thinking: WorkerOptions["thinking"];
  };
  status: TaskStatus;
  turns: number;
  toolUses: number;
  tokens: number;
  elapsedMs: number;
  response: string;
  activity: string;
  error?: string;
  pendingInput?: string[];
  sessionFile?: string;
  collected: boolean;
}
type Task = {
  view: TaskView;
  options: WorkerOptions;
  pending: string[];
  worker?: Worker;
  chain: Promise<void>;
  elapsed: number;
  activeSince?: number;
  usage?: Usage;
  usageReported: boolean;
  closing: boolean;
  closePromise?: Promise<void>;
  busy: boolean;
  awaitingStart: boolean;
  requestError?: string;
};
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Ready and paused workers retain their process and count against maxWorkers until collected or stopped. */
export class Coordinator {
  private tasks = new Map<string, Task>();
  private queue: Task[] = [];
  private listeners = new Set<() => void>();
  private disposed = false;
  private max: number;
  private factory: (options: WorkerOptions) => Worker;
  private onReady?: (task: TaskView) => void;
  private beforeStart?: (task: TaskView) => void;
  constructor(
    options: {
      maxWorkers?: number;
      createWorker?: (options: WorkerOptions) => Worker;
      onReady?: (task: TaskView) => void;
      beforeStart?: (task: TaskView) => void;
    } = {},
  ) {
    this.max = options.maxWorkers ?? 4;
    if (!Number.isInteger(this.max) || this.max < 1)
      throw new Error("maxWorkers must be a positive integer");
    this.factory = options.createWorker ?? createWorker;
    this.onReady = options.onReady;
    this.beforeStart = options.beforeStart;
  }
  private emit() {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* observers cannot break lifecycle */
      }
    }
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private task(id: string) {
    const t = this.tasks.get(id);
    if (!t) throw new Error(`Unknown task: ${id}`);
    return t;
  }
  private view(t: Task): TaskView {
    return {
      ...t.view,
      execution: { ...t.view.execution },
      ...(t.pending.length &&
      ["paused", "pausing", "error"].includes(t.view.status)
        ? { pendingInput: [...t.pending] }
        : {}),
      elapsedMs:
        t.elapsed +
        (t.activeSince === undefined ? 0 : Date.now() - t.activeSince),
    };
  }
  private status(t: Task, status: TaskStatus) {
    const active =
      status === "starting" || status === "running" || status === "pausing";
    if (!active && t.activeSince !== undefined) {
      t.elapsed += Date.now() - t.activeSince;
      t.activeSince = undefined;
    }
    if (active && t.activeSince === undefined) t.activeSince = Date.now();
    t.view.status = status;
    this.emit();
  }
  private serial(t: Task, action: () => Promise<void>): Promise<void> {
    const p = t.chain.then(action);
    t.chain = p.catch(() => {});
    return p;
  }
  private fail(t: Task, e: unknown) {
    const notified = t.view.status === "error";
    t.view.error = errorText(e);
    if (t.closing) {
      this.emit();
      return;
    }
    this.status(t, "error");
    if (!notified) {
      try {
        this.onReady?.(this.view(t));
      } catch {
        /* observer */
      }
    }
  }
  start(request: {
    prompt: string;
    description: string;
    level?: number;
    worker: WorkerOptions;
  }): string {
    if (this.disposed) throw new Error("Coordinator disposed");
    if (!request.prompt.trim())
      throw new Error("Task prompt must not be empty");
    const id = randomUUID();
    const t: Task = {
      view: {
        id,
        description: request.description,
        level: request.level,
        execution: {
          provider: request.worker.provider,
          model: request.worker.model,
          thinking: request.worker.thinking,
        },
        status: "queued",
        turns: 0,
        toolUses: 0,
        tokens: 0,
        elapsedMs: 0,
        response: "",
        activity: "",
        collected: false,
      },
      options: request.worker,
      pending: [request.prompt],
      chain: Promise.resolve(),
      elapsed: 0,
      usageReported: false,
      closing: false,
      busy: false,
      awaitingStart: true,
    };
    this.tasks.set(id, t);
    this.queue.push(t);
    this.emit();
    this.admit();
    return id;
  }
  list(): TaskView[] {
    return [...this.tasks.values()].reverse().map((t) => this.view(t));
  }
  get(id: string): TaskView {
    return this.view(this.task(id));
  }
  private admit() {
    if (this.disposed) return;
    while ([...this.tasks.values()].filter((t) => t.worker).length < this.max) {
      const index = this.queue.findIndex((t) => t.view.status === "queued");
      if (index < 0) return;
      const t = this.queue.splice(index, 1)[0]!;
      try {
        this.beforeStart?.(this.view(t));
        t.worker = this.factory(t.options);
        t.worker.onEvent((e) => this.event(t, e));
      } catch (e) {
        this.fail(t, e);
        continue;
      }
      this.status(t, "starting");
      void this.serial(t, async () => {
        try {
          await t.worker!.start();
          if (t.view.status !== "starting" || t.closing) return;
          this.status(t, "running");
          await this.flush(t);
        } catch (e) {
          this.fail(t, e);
        }
      });
    }
  }
  private async flush(t: Task) {
    while (t.pending.length && t.view.status === "running" && !t.closing) {
      const message = t.pending.join("\n\n");
      t.pending = [];
      try {
        await t.worker!.send(message);
      } catch (e) {
        t.pending.unshift(message);
        throw e;
      }
    }
  }
  private event(t: Task, event: WorkerEvent) {
    if (t.view.status === "closed") return;
    if (event.type === "worker_queue_cleared") {
      t.pending.push(...event.steering, ...event.followUp);
      this.emit();
      return;
    }
    const e = event as unknown as {
      type: string;
      error?: string;
      toolName?: string;
      message?: {
        role?: string;
        content?: { type: string; text?: string }[];
        usage?: Usage;
        stopReason?: string;
        errorMessage?: string;
      };
      assistantMessageEvent?: { type?: string };
    };
    if (e.type === "worker_error") {
      this.fail(t, e.error ?? "Worker error");
      return;
    }
    if (
      e.type === "agent_start" &&
      !t.closing &&
      (t.view.status === "starting" || t.view.status === "running")
    ) {
      t.awaitingStart = false;
      if (t.view.status === "starting") this.status(t, "running");
    }
    if (e.type === "turn_end") t.view.turns++;
    if (e.type === "tool_execution_end") t.view.toolUses++;
    if (e.type === "tool_execution_start") {
      const names: Record<string, string> = {
        read: "rd",
        bash: "cmd",
        edit: "edt",
        write: "wrt",
        find: "fnd",
        ls: "lst",
        grep: "fnd",
      };
      t.view.activity = names[e.toolName ?? ""] ?? "wrk";
    }
    if (e.type === "message_update")
      t.view.activity = e.assistantMessageEvent?.type?.startsWith("thinking")
        ? "thk"
        : "txt";
    if (e.type === "message_end" && e.message?.role === "assistant") {
      t.view.response = (e.message.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("");
      t.view.tokens += e.message.usage?.totalTokens ?? 0;
      // Pi may retry a failed request. Only agent_settled makes its final outcome observable.
      if (
        e.message.stopReason === "error" ||
        (e.message.stopReason === "aborted" &&
          t.view.status === "running" &&
          !t.closing)
      ) {
        t.requestError = e.message.errorMessage ?? "Worker response failed";
      } else if (e.message.stopReason !== "aborted") delete t.requestError;
    }
    if (
      e.type === "agent_settled" &&
      t.view.status === "running" &&
      !t.closing &&
      !t.awaitingStart
    ) {
      t.view.activity = "";
      t.view.error = t.requestError;
      this.status(t, t.view.error ? "error" : "ready");
      try {
        this.onReady?.(this.view(t));
      } catch {
        /* observer */
      }
      return;
    }
    this.emit();
  }
  async message(id: string, message: string): Promise<void> {
    if (!message.trim()) throw new Error("Message must not be empty");
    const t = this.task(id);
    if (
      t.busy ||
      t.closing ||
      ["closed", "error", "pausing"].includes(t.view.status)
    )
      throw new Error(`Cannot message ${t.view.status} task`);
    if (t.view.status === "paused") {
      t.pending.push(message);
      await this.continue(id);
      return;
    }
    t.pending.push(message);
    if (t.view.status === "queued" || t.view.status === "starting") return;
    t.busy = true;
    if (t.view.status === "ready") {
      t.awaitingStart = true;
      this.status(t, "running");
    }
    try {
      await this.serial(t, async () => {
        try {
          await this.flush(t);
        } catch (e) {
          this.fail(t, e);
          throw e;
        }
      });
    } finally {
      t.busy = false;
      this.emit();
    }
  }
  async pause(id: string): Promise<void> {
    const t = this.task(id);
    if (t.view.status === "queued") {
      this.status(t, "paused");
      return;
    }
    if (t.view.status === "pausing") {
      await t.chain;
      const outcome = this.get(id);
      if (outcome.status === "error")
        throw new Error(outcome.error ?? "Pause failed");
      return;
    }
    if (t.view.status !== "running" && t.view.status !== "starting") return;
    this.status(t, "pausing");
    await this.serial(t, async () => {
      if (t.closing) return;
      try {
        await t.worker!.pause();
        if (!t.closing) this.status(t, "paused");
      } catch (e) {
        this.fail(t, e);
        throw e;
      }
    });
  }
  async pauseAll(): Promise<void> {
    // Mark every queued task before any asynchronous pause can release capacity.
    const tasks = [...this.tasks.values()];
    for (const t of tasks)
      if (t.view.status === "queued") this.status(t, "paused");
    await Promise.all(tasks.map((t) => this.pause(t.view.id)));
  }
  async continue(id: string): Promise<void> {
    const t = this.task(id);
    if (t.view.status !== "paused" || t.closing || t.busy)
      throw new Error(`Cannot continue ${t.view.status} task`);
    if (!t.pending.length) t.pending.push("Continue the task.");
    if (!t.worker) {
      this.status(t, "queued");
      this.admit();
      return;
    }
    t.busy = true;
    t.awaitingStart = true;
    delete t.requestError;
    this.status(t, "running");
    try {
      await this.serial(t, async () => {
        try {
          await this.flush(t);
        } catch (e) {
          this.fail(t, e);
          throw e;
        }
      });
    } finally {
      t.busy = false;
      this.emit();
    }
  }
  async continueAll(): Promise<void> {
    await Promise.all(
      [...this.tasks.values()]
        .filter((t) => t.view.status === "paused")
        .map((t) => this.continue(t.view.id)),
    );
  }
  private async close(t: Task, collected: boolean): Promise<void> {
    if (t.closePromise) return t.closePromise;
    const active =
      t.view.status === "running" ||
      t.view.status === "starting" ||
      t.view.status === "pausing";
    t.closing = true;
    t.closePromise = this.serial(t, async () => {
      const worker = t.worker;
      if (worker) {
        if (active && !collected) {
          try {
            await worker.pause();
          } catch (e) {
            t.view.error = [
              t.view.error,
              `Pause before close failed: ${errorText(e)}`,
            ]
              .filter(Boolean)
              .join("; ");
          }
        }
        try {
          const report = await worker.report();
          t.view.response = report.text;
          t.view.sessionFile = report.sessionFile;
          t.usage = report.usage;
        } catch (e) {
          t.view.error = [t.view.error, `Report unavailable: ${errorText(e)}`]
            .filter(Boolean)
            .join("; ");
        }
        try {
          await worker.close();
        } catch (e) {
          t.view.error = [t.view.error, `Close failed: ${errorText(e)}`]
            .filter(Boolean)
            .join("; ");
        }
        t.worker = undefined;
      }
      t.view.collected = collected;
      this.status(t, "closed");
      this.admit();
    });
    return t.closePromise;
  }
  async stop(id: string): Promise<void> {
    const t = this.task(id);
    if (t.view.status === "closed") return;
    await this.close(t, false);
  }
  async collect(id: string): Promise<TaskView> {
    const t = this.task(id);
    if (t.view.status === "closed" && t.view.collected) return this.view(t);
    if (
      t.busy ||
      t.closing ||
      (t.view.status !== "ready" && t.view.status !== "error")
    )
      throw new Error(`Cannot collect ${t.view.status} task`);
    await this.close(t, true);
    return this.view(t);
  }
  wait(
    id: string,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<TaskView> {
    const t = this.task(id);
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        unsubscribe();
        signal?.removeEventListener("abort", abort);
        if (timer !== undefined) clearTimeout(timer);
      };
      const check = () => {
        if (["ready", "error", "closed"].includes(t.view.status)) {
          cleanup();
          resolve(this.view(t));
        }
      };
      const abort = () => {
        cleanup();
        reject(new DOMException("Wait aborted", "AbortError"));
      };
      const unsubscribe = this.subscribe(check);
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      if (timeoutMs !== undefined)
        timer = setTimeout(() => {
          cleanup();
          reject(new Error("Wait timed out"));
        }, timeoutMs);
      check();
    });
  }
  drainUsage(): Usage | undefined {
    let result: Usage | undefined;
    for (const t of this.tasks.values()) {
      if (t.view.status !== "closed" || t.usageReported || !t.usage) continue;
      const u = t.usage;
      t.usageReported = true;
      if (!result) {
        result = structuredClone(u);
        continue;
      }
      for (const key of [
        "input",
        "output",
        "cacheRead",
        "cacheWrite",
        "totalTokens",
        "cacheWrite1h",
        "reasoning",
      ] as const) {
        if (u[key] !== undefined) result[key] = (result[key] ?? 0) + u[key];
      }
      for (const key of [
        "input",
        "output",
        "cacheRead",
        "cacheWrite",
        "total",
      ] as const)
        result.cost[key] += u.cost[key];
      result.cost.totalFromProvider =
        !!result.cost.totalFromProvider && !!u.cost.totalFromProvider;
    }
    return result;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    // Shutdown is not result collection: close immediately, interrupting any pending RPC.
    await Promise.all(
      [...this.tasks.values()].map(async (t) => {
        t.closing = true;
        try {
          await t.worker?.close();
        } catch (error) {
          t.view.error = errorText(error);
        }
        t.worker = undefined;
        this.status(t, "closed");
      }),
    );
  }
}
