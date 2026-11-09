import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { addUsage } from "./usage.ts";
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
interface TaskData {
  id: string;
  description: string;
  level: number;
  execution: Pick<WorkerOptions, "provider" | "model" | "thinking">;
  sessionFile: string;
  turns: number;
  toolUses: number;
  tokens: number;
  elapsedMs: number;
  response: string;
  error?: string;
}
export interface TaskView extends TaskData {
  status: TaskStatus;
  outcome?: Outcome;
  operation?: "pausing" | "closing";
  activity: string;
  /** Delivery belongs to this reply, not to the task's eventual acceptance. */
  reply?: { id: string; delivered: boolean };
  pendingInput?: string[];
}
export interface TaskResult extends TaskData {
  outcome: Outcome;
  pendingInput?: string[];
}
export interface Summary {
  completed: number;
  inputTokens: number;
  outputTokens: number;
}
type Intent = "pause" | "redirect" | "stop";
type Execution = {
  worker: Worker;
  input: string;
  intent?: Intent;
  done: Promise<void>;
  recover?: () => void;
  unsubscribe: () => void;
};
type Task = {
  data: TaskData;
  options: WorkerOptions;
  status: TaskStatus;
  outcome?: Outcome;
  activity: string;
  reply?: TaskView["reply"];
  pending: string[];
  run?: Execution;
  take?: Promise<TaskResult>;
  usage?: Usage;
  inputTokens: number;
  outputTokens: number;
  sessionId?: string;
  elapsed: number;
  activeSince?: number;
};
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** A task owns a native session; each admitted execution owns a fresh process. */
export class Coordinator {
  private tasks = new Map<string, Task>();
  private receipts = new Map<string, TaskResult>();
  private usage?: Usage;
  private totals: Summary = {
    completed: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
  private listeners = new Set<() => void>();
  private disposed = false;
  private suspended = false;
  private preparing = 0;
  private epoch = 0;
  private interruption?: Promise<void>;
  private max: number;
  private factory: typeof createWorker;
  private beforeStart?: (task: TaskView) => void;
  private onReady?: (task: TaskView) => void;

  constructor(
    options: {
      maxWorkers?: number;
      createWorker?: typeof createWorker;
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
      activity: t.activity,
      ...(t.reply ? { reply: { ...t.reply } } : {}),
      ...(t.run?.intent
        ? {
            operation:
              t.run.intent === "stop"
                ? ("closing" as const)
                : ("pausing" as const),
          }
        : {}),
      ...(t.pending.length ? { pendingInput: [...t.pending] } : {}),
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
    const receipt = this.receipts.get(id);
    return receipt ? structuredClone(receipt) : this.get(id);
  }
  /** A parent context contains this exact handoff; keep its task resumable. */
  markDelivered(id: string, replyId: string): boolean {
    const t = this.tasks.get(id);
    if (
      !t ||
      t.status !== "ready" ||
      t.outcome !== "reply" ||
      t.run ||
      !t.reply ||
      t.reply.id !== replyId ||
      t.reply.delivered
    )
      return false;
    t.reply.delivered = true;
    this.emit();
    return true;
  }
  summary(): Summary {
    const summary = { ...this.totals };
    for (const t of this.tasks.values()) {
      summary.inputTokens += t.inputTokens;
      summary.outputTokens += t.outputTokens;
    }
    return summary;
  }
  start(request: {
    prompt: string;
    description: string;
    level: number;
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
        sessionFile: resolve(
          request.worker.cwd,
          request.worker.sessionDir ?? ".pi/pi-sub/sessions",
          `${id}.jsonl`,
        ),
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
      inputTokens: 0,
      outputTokens: 0,
      elapsed: 0,
    };
    this.tasks.set(id, t);
    this.emit();
    this.admit();
    return id;
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
    t.outcome = "error";
    if (!t.run) {
      this.status(t, "ready");
      if (!this.disposed && !t.take) this.ready(t);
    } else this.emit();
  }
  private admit() {
    if (!this.runnable) return;
    while ([...this.tasks.values()].filter((t) => t.run).length < this.max) {
      const t = [...this.tasks.values()].find(
        (t) => t.status === "queued" && !t.take,
      );
      if (!t) return;
      try {
        this.beforeStart?.(this.view(t));
        const worker = this.factory(t.options, t.data.sessionFile, t.sessionId);
        const finished = Promise.withResolvers<void>();
        const run: Execution = {
          worker,
          input: t.pending.join("\n\n"),
          done: finished.promise,
          unsubscribe: () => {},
        };
        void run.done.catch(() => {});
        // Subscribe before transferring input or owning an execution. A failed
        // subscription cannot leave a run that was never started occupying a slot.
        run.unsubscribe = worker.onEvent((event) => this.event(t, run, event));
        t.pending = [];
        t.run = run;
        t.outcome = undefined;
        t.reply = undefined;
        t.activity = "";
        t.data.response = "";
        delete t.data.error;
        this.status(t, "active");
        void (async () => {
          let report: WorkerReport;
          try {
            report = await worker.run(run.input);
          } catch (error) {
            // Unexpected API failure cannot release a possibly live process.
            // Keep completion pending if stop fails; a later stop can recover it.
            run.recover = () => {
              this.ended(t, run, {
                text: "",
                sessionFile: t.data.sessionFile,
                error: message(error),
                interrupted: false,
                inputPersisted: false,
              });
              finished.resolve();
            };
            try {
              await worker.stop();
            } catch (stopError) {
              this.fail(
                t,
                `Execution failed: ${message(error)}; stop failed: ${message(stopError)}`,
              );
              return;
            }
            run.recover?.();
            return;
          }
          this.ended(t, run, report);
          finished.resolve();
        })().catch((error) => {
          this.fail(t, error);
          finished.reject(error);
        });
      } catch (error) {
        this.fail(t, error);
      }
    }
  }
  private event(t: Task, run: Execution, event: WorkerEvent) {
    if (this.disposed || t.run !== run) return;
    if (event.type === "turn_end") t.data.turns++;
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
      const text = value.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      if (text) t.data.response = text;
      t.data.tokens += value.usage?.totalTokens ?? 0;
      t.inputTokens += value.usage?.input ?? 0;
      t.outputTokens += value.usage?.output ?? 0;
    }
    // Completion events are progress only. The process's close/report ends execution.
    this.emit();
  }
  private ended(t: Task, run: Execution, report: WorkerReport) {
    try {
      run.unsubscribe();
    } catch {
      /* observer cleanup */
    }
    run.recover = undefined;
    if (t.run !== run) return;
    t.run = undefined;
    t.data.response = report.text || t.data.response;
    t.sessionId ??= report.sessionId;
    if (report.usage) {
      // Whole-session snapshots replace both billing and displayed totals.
      t.usage = report.usage;
      t.data.tokens = report.usage.totalTokens;
      t.inputTokens = report.usage.input;
      t.outputTokens = report.usage.output;
    }
    // A successful native reply may follow an input transformation. On abort or
    // failure, replay conservatively when the original instruction is unproven.
    if (!report.inputPersisted && (report.interrupted || report.error))
      t.pending.unshift(run.input);
    t.activity = "";
    if (this.disposed) return;
    if (t.outcome === "error" || report.error) {
      this.fail(t, t.data.error ?? report.error ?? "Execution failed");
    } else if (run.intent === "stop") {
      t.outcome = "stopped";
      this.status(t, "ready");
    } else if (report.interrupted || t.pending.length) {
      const redirect = run.intent === "redirect" && !this.suspended;
      this.status(t, redirect ? "queued" : "paused");
    } else {
      t.outcome = "reply";
      t.reply = { id: randomUUID(), delivered: false };
      this.status(t, "ready");
      if (!t.take) this.ready(t);
    }
    this.admit();
  }
  /** Stop the exact execution object; no callback may accidentally follow its successor. */
  private async end(t: Task, intent: Intent): Promise<void> {
    const run = t.run;
    if (!run) return;
    if (
      run.intent !== "stop" &&
      (intent !== "redirect" || run.intent !== "pause")
    )
      run.intent = intent;
    this.emit();
    try {
      await run.worker.stop();
      run.recover?.();
      await run.done;
    } catch (error) {
      this.fail(t, `Could not terminate execution: ${message(error)}`);
      throw error;
    }
  }
  async message(id: string, text: string): Promise<void> {
    if (!text.trim()) throw new Error("Message must not be empty");
    const t = this.task(id);
    if (this.suspended)
      throw new Error("Send a user prompt before continuing subagents");
    if (
      t.take ||
      t.outcome === "error" ||
      t.outcome === "stopped" ||
      t.run?.intent === "stop"
    )
      throw new Error("Task cannot accept input");
    t.pending.push(text);
    if (t.run) {
      await this.end(t, "redirect");
      return;
    }
    t.outcome = undefined;
    t.reply = undefined;
    this.status(t, "queued");
    this.admit();
  }
  async pause(id: string): Promise<void> {
    const t = this.task(id);
    if (t.take || t.status === "ready" || t.status === "paused") return;
    if (!t.run) {
      this.status(t, "paused");
      return;
    }
    await this.end(t, "pause");
  }
  interrupt(): Promise<void> {
    this.suspended = true;
    this.epoch++;
    const tasks = [...this.tasks.values()];
    for (const t of tasks) if (t.status === "queued") this.status(t, "paused");
    const current = Promise.all(tasks.map((t) => this.pause(t.data.id))).then(
      () => {},
    );
    this.interruption = Promise.all([
      this.interruption?.catch(() => {}),
      current,
    ]).then(() => {});
    return this.interruption;
  }
  async continue(id: string): Promise<void> {
    const t = this.task(id);
    if (t.status !== "paused" || t.run || t.take)
      throw new Error("Task is not paused and available");
    if (this.suspended)
      throw new Error("Send a user prompt before continuing subagents");
    if (!t.pending.length) t.pending.push("Continue the task.");
    t.outcome = undefined;
    this.status(t, "queued");
    this.admit();
  }
  private result(t: Task): TaskResult {
    return {
      ...this.data(t),
      outcome: t.outcome ?? "reply",
      ...(t.pending.length ? { pendingInput: [...t.pending] } : {}),
    };
  }
  private archive(t: Task): TaskResult {
    if (t.run) throw new Error("Cannot remove a task with a live execution");
    const result = this.result(t);
    if (this.tasks.delete(t.data.id)) {
      this.receipts.set(result.id, structuredClone(result));
      if (t.usage) this.usage = addUsage(this.usage, t.usage);
      this.totals.inputTokens += t.inputTokens;
      this.totals.outputTokens += t.outputTokens;
      if (result.outcome === "reply") this.totals.completed++;
      this.emit();
    }
    return structuredClone(result);
  }
  async collect(id: string): Promise<TaskResult> {
    const receipt = this.receipts.get(id);
    if (receipt) return structuredClone(receipt);
    const t = this.task(id);
    if (t.take) return t.take;
    if (t.status !== "ready" || t.run)
      throw new Error(`Cannot collect ${t.status} task`);
    return this.archive(t);
  }
  async stop(id: string): Promise<TaskResult> {
    const receipt = this.receipts.get(id);
    if (receipt) return structuredClone(receipt);
    const t = this.task(id);
    if (t.take) return t.take;
    const taking = Promise.withResolvers<TaskResult>();
    t.take = taking.promise;
    void (async () => {
      try {
        await this.end(t, "stop");
        if (t.outcome !== "error") t.outcome = "stopped";
        taking.resolve(this.archive(t));
      } catch (error) {
        t.take = undefined;
        taking.reject(error);
      }
    })();
    return taking.promise;
  }
  /** Real user input sweeps failures without a model cleanup roundtrip. */
  async prompt(
    deliver: (failures: TaskResult[]) => void = () => {},
  ): Promise<boolean> {
    const epoch = this.epoch;
    this.preparing++;
    try {
      await this.interruption?.catch(() => {});
      const failed = new Set<Task>();
      for (;;) {
        const next = [...this.tasks.values()].filter(
          (t) => t.outcome === "error" && !failed.has(t),
        );
        if (!next.length) break;
        for (const t of next) failed.add(t);
        await Promise.all(next.map((t) => this.end(t, "stop")));
      }
      if (this.disposed || epoch !== this.epoch) return false;
      const pending = [...failed].filter(
        (t) => this.tasks.has(t.data.id) && !t.take,
      );
      deliver(pending.map((t) => this.result(t)));
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
    const result = this.usage;
    this.usage = undefined;
    return result;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.epoch++;
    await Promise.all([...this.tasks.values()].map((t) => this.end(t, "stop")));
    this.tasks.clear();
    this.emit();
  }
}
