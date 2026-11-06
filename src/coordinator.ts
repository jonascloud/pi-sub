import { randomUUID } from "node:crypto";
import type { Usage } from "@earendil-works/pi-ai";
import {
  createWorker,
  type Worker,
  type WorkerEvent,
  type WorkerOptions,
  type WorkerReport,
} from "./worker.ts";

export type TaskStatus = "queued" | "active" | "paused" | "ready";
export type Outcome = "reply" | "error" | "stopped";
type Operation = "starting" | "sending" | "pausing" | "closing";
interface TaskData {
  id: string;
  description: string;
  level?: number;
  execution: Pick<WorkerOptions, "provider" | "model" | "thinking">;
  turns: number;
  toolUses: number;
  tokens: number;
  elapsedMs: number;
  response: string;
  error?: string;
  sessionFile?: string;
}
export interface TaskView extends TaskData {
  status: TaskStatus;
  outcome?: Outcome;
  operation?: Operation;
  activity: string;
  pendingInput?: string[];
}
export interface TaskResult extends TaskData {
  outcome: Outcome;
  pendingInput?: string[];
}
export interface Summary {
  completed: number;
  tokens: number;
}
type Task = {
  data: TaskData;
  status: TaskStatus;
  outcome?: Outcome;
  operation?: Operation;
  activity: string;
  options: WorkerOptions;
  pending: string[];
  worker?: Worker;
  unsubscribe?: () => void;
  chain: Promise<void>;
  pause?: Promise<void>;
  release?: Promise<void>;
  take?: Promise<TaskResult>;
  usage?: Usage;
  elapsed: number;
  activeSince?: number;
  idle: boolean;
  requestError?: string;
};
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** One live registry. Receipts retain results, never workers, queues, promises or listeners. */
export class Coordinator {
  private tasks = new Map<string, Task>();
  private receipts = new Map<string, TaskResult>();
  private usage: Usage[] = [];
  private totals: Summary = { completed: 0, tokens: 0 };
  private listeners = new Set<() => void>();
  private disposed = false;
  private suspended = false;
  private preparing = 0;
  private epoch = 0;
  private interruption?: Promise<void>;
  private max: number;
  private factory: (options: WorkerOptions) => Worker;
  private beforeStart?: (task: TaskView) => void;
  private onReady?: (task: TaskView) => void;

  constructor(
    options: {
      maxWorkers?: number;
      createWorker?: (options: WorkerOptions) => Worker;
      beforeStart?: (task: TaskView) => void;
      onReady?: (task: TaskView) => void;
    } = {},
  ) {
    this.max = options.maxWorkers ?? 4;
    if (!Number.isInteger(this.max) || this.max < 1)
      throw new Error("maxWorkers must be a positive integer");
    this.factory = options.createWorker ?? createWorker;
    this.beforeStart = options.beforeStart;
    this.onReady = options.onReady;
  }
  get interrupted() {
    return this.suspended;
  }
  get runnable() {
    return !this.disposed && !this.suspended && !this.preparing;
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit() {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* observer */
      }
    }
  }
  private task(id: string): Task {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Unknown live task: ${id}`);
    return task;
  }
  private data(t: Task): TaskData {
    return {
      ...t.data,
      execution: { ...t.data.execution },
      elapsedMs:
        t.elapsed +
        (t.activeSince === undefined ? 0 : Date.now() - t.activeSince),
    };
  }
  private view(t: Task): TaskView {
    return {
      ...this.data(t),
      status: t.status,
      outcome: t.outcome,
      operation: t.operation,
      activity: t.activity,
      ...(t.pending.length &&
      (t.status === "paused" || t.pause || t.outcome === "error")
        ? { pendingInput: [...t.pending] }
        : {}),
    };
  }
  private status(t: Task, status: TaskStatus) {
    if (status !== "active" && t.activeSince !== undefined) {
      t.elapsed += Date.now() - t.activeSince;
      t.activeSince = undefined;
    }
    if (status === "active" && t.activeSince === undefined)
      t.activeSince = Date.now();
    t.status = status;
    this.emit();
  }
  list(): TaskView[] {
    return [...this.tasks.values()].reverse().map((t) => this.view(t));
  }
  get(id: string): TaskView {
    return this.view(this.task(id));
  }
  inspect(id: string): TaskView | TaskResult {
    return this.receipts.get(id)
      ? structuredClone(this.receipts.get(id)!)
      : this.get(id);
  }
  summary(): Summary {
    return {
      ...this.totals,
      tokens:
        this.totals.tokens +
        [...this.tasks.values()].reduce((n, t) => n + t.data.tokens, 0),
    };
  }

  private run<T>(
    t: Task,
    operation: Operation,
    action: () => Promise<T>,
  ): Promise<T> {
    const result = t.chain.then(async () => {
      if (this.disposed) throw new Error("Coordinator disposed");
      t.operation = operation;
      this.emit();
      try {
        return await action();
      } finally {
        t.operation = undefined;
        this.reconcile(t);
        this.emit();
      }
    });
    t.chain = result.then(
      () => {},
      () => {},
    );
    return result;
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
      data: {
        id,
        description: request.description,
        level: request.level,
        execution: {
          provider: request.worker.provider,
          model: request.worker.model,
          thinking: request.worker.thinking,
        },
        turns: 0,
        toolUses: 0,
        tokens: 0,
        elapsedMs: 0,
        response: "",
      },
      status: this.suspended ? "paused" : "queued",
      activity: "",
      options: request.worker,
      pending: [request.prompt],
      chain: Promise.resolve(),
      elapsed: 0,
      idle: false,
    };
    this.tasks.set(id, t);
    this.emit();
    this.admit();
    return id;
  }
  private admit() {
    if (!this.runnable) return;
    while ([...this.tasks.values()].filter((t) => t.worker).length < this.max) {
      const t = [...this.tasks.values()].find(
        (t) => t.status === "queued" && !t.take && !t.release,
      );
      if (!t) return;
      try {
        this.beforeStart?.(this.view(t));
        t.worker = this.factory(t.options);
        t.unsubscribe = t.worker.onEvent((event) => this.event(t, event));
      } catch (error) {
        this.fail(t, error);
        continue;
      }
      this.status(t, "active");
      void this.run(t, "starting", async () => {
        await t.worker!.start();
        if (!this.disposed && !t.pause && !t.take && !t.release)
          await this.flush(t);
      }).catch((error) => {
        if (!this.disposed) this.fail(t, error);
      });
    }
  }
  private async flush(t: Task) {
    while (t.pending.length && !t.pause && !t.take && !t.release) {
      const text = t.pending.join("\n\n");
      t.pending = [];
      try {
        await t.worker!.send(text);
      } catch (error) {
        t.pending.unshift(text);
        throw error;
      }
    }
  }
  private event(t: Task, event: WorkerEvent) {
    if (this.disposed || !this.tasks.has(t.data.id)) return;
    if (event.type === "worker_queue_cleared") {
      t.pending.push(...event.steering, ...event.followUp);
    } else if (event.type === "worker_error") {
      this.fail(t, event.error);
    } else if (event.type === "agent_start") {
      t.idle = false;
      if (!t.pause && !t.release && !t.take) this.status(t, "active");
    } else if (event.type === "worker_state") {
      t.idle = event.idle;
      if (!event.idle && !t.pause && !t.release && !t.take)
        this.status(t, "active");
      this.reconcile(t);
    } else if (event.type === "turn_end") t.data.turns++;
    else if (event.type === "tool_execution_end") t.data.toolUses++;
    else if (event.type === "tool_execution_start") {
      const names: Record<string, string> = {
        read: "rd",
        bash: "cmd",
        edit: "edt",
        write: "wrt",
        find: "fnd",
        ls: "lst",
        grep: "fnd",
      };
      t.activity = names[event.toolName] ?? "wrk";
    } else if (event.type === "message_update") {
      t.activity = event.assistantMessageEvent.type.startsWith("thinking")
        ? "thk"
        : "txt";
    } else if (
      event.type === "message_end" &&
      event.message.role === "assistant"
    ) {
      const value = event.message;
      t.data.response = value.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      t.data.tokens += value.usage?.totalTokens ?? 0;
      if (value.stopReason === "error")
        t.requestError = value.errorMessage ?? "Worker response failed";
      else if (value.stopReason === "aborted" && !t.pause && !t.take)
        t.requestError = value.errorMessage ?? "Worker response aborted";
      else delete t.requestError;
    }
    this.emit();
  }
  private reconcile(t: Task) {
    if (
      this.disposed ||
      !this.tasks.has(t.data.id) ||
      t.operation ||
      t.pause ||
      t.release ||
      t.take ||
      !t.idle ||
      t.pending.length ||
      t.status !== "active"
    )
      return;
    if (t.requestError) {
      this.fail(t, t.requestError);
      return;
    }
    t.outcome = "reply";
    t.activity = "";
    this.status(t, "ready");
    this.ready(t);
  }
  private ready(t: Task) {
    try {
      this.onReady?.(this.view(t));
    } catch {
      /* observer */
    }
  }
  private fail(t: Task, error: unknown) {
    t.data.error = message(error);
    if (t.outcome !== "stopped") t.outcome = "error";
    if (this.disposed || t.release) {
      this.emit();
      return;
    }
    void this.release(t, false)
      .then(() => {
        if (!this.disposed && !t.take && this.tasks.has(t.data.id)) {
          this.status(t, "ready");
          this.ready(t);
        }
      })
      .catch(() => {});
  }
  async message(id: string, text: string): Promise<void> {
    if (!text.trim()) throw new Error("Message must not be empty");
    const t = this.task(id);
    if (t.pause || t.release || t.take || (t.outcome && t.outcome !== "reply"))
      throw new Error("Task cannot accept input");
    if (t.operation && t.operation !== "starting")
      throw new Error("Task has an operation in progress");
    t.pending.push(text);
    if (t.status === "paused") {
      await this.continue(id);
      return;
    }
    if (t.status === "queued" || t.operation === "starting") return;
    t.outcome = undefined;
    delete t.requestError;
    this.status(t, "active");
    try {
      await this.run(t, "sending", () => this.flush(t));
    } catch (error) {
      this.fail(t, error);
      throw error;
    }
  }
  async pause(id: string): Promise<void> {
    const t = this.task(id);
    if (t.pause) return t.pause;
    if (t.take || t.release || t.status === "ready" || t.status === "paused")
      return;
    if (t.status === "queued") {
      this.status(t, "paused");
      return;
    }
    t.pause = this.run(t, "pausing", async () => {
      try {
        await t.worker!.pause();
        if (t.outcome !== "error") {
          t.idle = true;
          delete t.requestError;
          this.status(t, "paused");
        }
      } catch (error) {
        this.fail(t, error);
        throw error;
      }
    });
    this.emit();
    try {
      await t.pause;
    } finally {
      t.pause = undefined;
      this.emit();
    }
  }
  /** User interrupt is an admission barrier, not just a snapshot of current workers. */
  interrupt(): Promise<void> {
    this.suspended = true;
    this.epoch++;
    const tasks = [...this.tasks.values()];
    for (const t of tasks) if (t.status === "queued") this.status(t, "paused");
    const current = Promise.all(tasks.map((t) => this.pause(t.data.id))).then(
      () => {},
    );
    const previous = this.interruption;
    this.interruption = Promise.all([previous?.catch(() => {}), current]).then(
      () => {},
    );
    return this.interruption;
  }
  async continue(id: string): Promise<void> {
    const t = this.task(id);
    if (t.status !== "paused" || t.operation || t.pause || t.take || t.release)
      throw new Error("Task is not paused and available");
    if (this.suspended)
      throw new Error("Send a user prompt before continuing subagents");
    if (!t.pending.length) t.pending.push("Continue the task.");
    if (!t.worker) {
      this.status(t, "queued");
      this.admit();
      return;
    }
    t.outcome = undefined;
    delete t.requestError;
    this.status(t, "active");
    try {
      await this.run(t, "sending", () => this.flush(t));
    } catch (error) {
      this.fail(t, error);
      throw error;
    }
  }
  private release(t: Task, stop: boolean): Promise<void> {
    if (t.release) return t.release;
    t.release = this.run(t, "closing", async () => {
      const worker = t.worker;
      if (!worker) return;
      if (stop && !t.idle) {
        try {
          await worker.pause();
        } catch (error) {
          t.data.error = `Pause before close failed: ${message(error)}`;
        }
      }
      const capture = (report: WorkerReport) => {
        t.data.response = report.text || t.data.response;
        t.data.sessionFile = report.sessionFile ?? t.data.sessionFile;
        if (report.usage) t.usage = report.usage;
      };
      let captured = false;
      let reportError: unknown;
      try {
        capture(await worker.report());
        captured = true;
      } catch (error) {
        reportError = error;
      }
      await worker.close();
      // Native shutdown can persist late usage (for example cache warming).
      // Prefer the final saved session; memory-only workers keep the live snapshot.
      try {
        capture(await worker.report());
        captured = true;
      } catch (error) {
        if (!captured) reportError = error;
      }
      if (!captured)
        t.data.error = [
          t.data.error,
          `Report unavailable: ${message(reportError)}`,
        ]
          .filter(Boolean)
          .join("; ");
      t.unsubscribe?.();
      t.unsubscribe = undefined;
      t.worker = undefined;
      t.idle = true;
    });
    // Failed close retains ownership. Never free a slot for a process we could not close.
    void t.release.then(
      () => this.admit(),
      (error) => {
        t.release = undefined;
        t.outcome = "error";
        t.data.error = [t.data.error, `Close failed: ${message(error)}`]
          .filter(Boolean)
          .join("; ");
        this.emit();
      },
    );
    return t.release;
  }
  private result(t: Task): TaskResult {
    return {
      ...this.data(t),
      outcome: t.outcome ?? "reply",
      ...(t.pending.length ? { pendingInput: [...t.pending] } : {}),
    };
  }
  private archive(t: Task): TaskResult {
    const result = this.result(t);
    if (this.tasks.delete(t.data.id)) {
      this.receipts.set(result.id, structuredClone(result));
      if (t.usage) this.usage.push(t.usage);
      this.totals.tokens += result.tokens;
      if (result.outcome === "reply") this.totals.completed++;
      this.emit();
      this.admit();
    }
    return structuredClone(result);
  }
  async collect(id: string): Promise<TaskResult> {
    const receipt = this.receipts.get(id);
    if (receipt) return structuredClone(receipt);
    const t = this.task(id);
    if (t.take) return t.take;
    if (t.status !== "ready" || t.operation || t.pause)
      throw new Error(`Cannot collect ${t.status} task`);
    return this.take(t, false);
  }
  async stop(id: string): Promise<TaskResult> {
    const receipt = this.receipts.get(id);
    if (receipt) return structuredClone(receipt);
    const t = this.task(id);
    if (t.take) return t.take;
    if (t.outcome !== "error") t.outcome = "stopped";
    return this.take(t, true);
  }
  private take(t: Task, stop: boolean): Promise<TaskResult> {
    t.take = (async () => {
      await this.release(t, stop);
      return this.archive(t);
    })();
    void t.take.catch(() => {
      t.take = undefined;
    });
    this.emit();
    return t.take;
  }
  /** Only real user prompts reopen admission. A later interrupt cancels this handoff. */
  async prompt(
    deliver: (failures: TaskResult[]) => void = () => {},
  ): Promise<boolean> {
    const epoch = this.epoch;
    this.preparing++;
    try {
      await this.interruption?.catch(() => {});
      // Admission is blocked during the sweep; only already resident workers can add failures.
      const failed = new Set<Task>();
      for (;;) {
        const next = [...this.tasks.values()].filter(
          (t) => t.outcome === "error" && !failed.has(t),
        );
        if (!next.length) break;
        for (const t of next) failed.add(t);
        await Promise.all(next.map((t) => this.release(t, false)));
      }
      if (this.disposed || epoch !== this.epoch) return false;
      const pending = [...failed].filter(
        (t) => this.tasks.has(t.data.id) && !t.take,
      );
      const reports = pending.map((t) => this.result(t));
      deliver(reports);
      for (const t of pending) this.archive(t);
      this.suspended = false;
      return true;
    } finally {
      this.preparing--;
      this.admit();
    }
  }
  wait(
    id: string,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<TaskView | TaskResult> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        unsubscribe();
        signal?.removeEventListener("abort", abort);
        if (timer !== undefined) clearTimeout(timer);
      };
      const check = () => {
        if (this.disposed) {
          cleanup();
          reject(new Error("Coordinator disposed"));
          return;
        }
        const value = this.inspect(id);
        if (!("status" in value) || value.status === "ready") {
          cleanup();
          resolve(value);
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
      try {
        check();
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }
  drainUsage(): Usage | undefined {
    const values = this.usage.splice(0);
    let result: Usage | undefined;
    for (const value of values) {
      if (!result) {
        result = structuredClone(value);
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
      ] as const)
        if (value[key] !== undefined)
          result[key] = (result[key] ?? 0) + value[key];
      for (const key of [
        "input",
        "output",
        "cacheRead",
        "cacheWrite",
        "total",
      ] as const)
        result.cost[key] += value.cost[key];
      if (
        result.cost.totalFromProvider !== undefined ||
        value.cost.totalFromProvider !== undefined
      )
        result.cost.totalFromProvider =
          result.cost.totalFromProvider === true &&
          value.cost.totalFromProvider === true;
    }
    return result;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.epoch++;
    await Promise.all(
      [...this.tasks.values()].map(async (t) => {
        await t.worker?.close();
        t.unsubscribe?.();
        t.worker = undefined;
      }),
    );
    this.tasks.clear();
    this.emit();
  }
}
