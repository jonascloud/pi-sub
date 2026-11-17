import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { addUsage, usageDelta } from "./usage.ts";
import { ReportStore, type ReportRef } from "./report-store.ts";
import { captureReport, excerpt, oneLine, PREVIEW_BYTES } from "./reports.ts";
import {
  createWorker,
  type Worker,
  type WorkerEvent,
  type WorkerOptions,
  type WorkerReport,
} from "./worker.ts";

/** Ready and failed tasks hold a reply or an error and no process; a message continues either. */
export type TaskStatus = "queued" | "active" | "paused" | "ready" | "failed";
export interface TaskView {
  id: string;
  description: string;
  level: number;
  execution: Pick<WorkerOptions, "provider" | "model" | "thinking">;
  sessionFile: string;
  /** Accepted and stopped describe a task at its removal. */
  status: TaskStatus | "accepted" | "stopped";
  activity: string;
  turns: number;
  toolUses: number;
  tokens: number;
  elapsedMs: number;
  response: string;
  error?: string;
  report?: ReportRef;
  /** Instructions its session has not received yet; the next execution sends them. */
  unsent: number;
  /** Its current reply or failure was handed to the parent. */
  delivered: boolean;
}
export interface Summary {
  inputTokens: number;
  outputTokens: number;
}
type Intent = "pause" | "redirect" | "stop";
type Execution = {
  worker: Worker;
  input: string;
  intent?: Intent;
  done: Promise<void>;
};
type Task = Omit<TaskView, "status" | "elapsedMs" | "unsent" | "execution"> & {
  status: TaskStatus;
  options: WorkerOptions;
  pending: string[];
  run?: Execution;
  stopping?: boolean;
  usage?: Usage;
  inputTokens: number;
  outputTokens: number;
  /** A lost session cannot be continued. */
  session: "new" | "saved" | "lost";
  elapsed: number;
  activeSince?: number;
};
export function isSettled(status: TaskView["status"]): boolean {
  return status === "ready" || status === "failed";
}

/** A task owns a native session; each admitted execution owns a fresh process. */
export class Coordinator {
  readonly reports = new ReportStore();
  private tasks = new Map<string, Task>();
  private usage?: Usage;
  private totals: Summary = { inputTokens: 0, outputTokens: 0 };
  private listeners = new Set<() => void>();
  private disposed = false;
  private admitting = false;
  private max: number;
  private factory: typeof createWorker;
  private onSettled?: () => void;

  constructor(
    options: {
      maxWorkers?: number;
      createWorker?: typeof createWorker;
      /** A task became ready or failed on its own. */
      onSettled?: () => void;
    } = {},
  ) {
    this.max = options.maxWorkers ?? 4;
    this.factory = options.createWorker ?? createWorker;
    this.onSettled = options.onSettled;
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
    if (!task) throw new Error(`Unknown task: ${id}`);
    return task;
  }
  private view(t: Task, status: TaskView["status"] = t.status): TaskView {
    return {
      id: t.id,
      description: t.description,
      level: t.level,
      execution: {
        provider: t.options.provider,
        model: t.options.model,
        thinking: t.options.thinking,
      },
      sessionFile: t.sessionFile,
      status,
      activity: t.activity,
      turns: t.turns,
      toolUses: t.toolUses,
      tokens: t.tokens,
      elapsedMs:
        t.elapsed +
        (t.activeSince === undefined ? 0 : Date.now() - t.activeSince),
      response: t.response,
      ...(t.error === undefined ? {} : { error: t.error }),
      ...(t.report === undefined ? {} : { report: { ...t.report } }),
      unsent: t.pending.length,
      delivered: t.delivered,
    };
  }
  private status(t: Task, status: TaskStatus) {
    if (status !== "active" && t.activeSince !== undefined) {
      t.elapsed += Date.now() - t.activeSince;
      t.activeSince = undefined;
    }
    if (status === "active") t.activeSince ??= Date.now();
    t.status = status;
    this.emit();
  }
  /** Tasks in creation order. */
  list(): TaskView[] {
    return [...this.tasks.values()].map((t) => this.view(t));
  }
  get(id: string): TaskView {
    return this.view(this.task(id));
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
    this.tasks.set(id, {
      id,
      description: oneLine(request.description),
      level: request.level,
      sessionFile: resolve(
        request.worker.cwd,
        request.worker.sessionDir,
        `${id}.jsonl`,
      ),
      status: "queued",
      activity: "",
      turns: 0,
      toolUses: 0,
      tokens: 0,
      response: "",
      delivered: false,
      options: request.worker,
      pending: [request.prompt],
      inputTokens: 0,
      outputTokens: 0,
      session: "new",
      elapsed: 0,
    });
    this.emit();
    this.admit();
    return id;
  }
  private admit() {
    if (this.disposed || this.admitting) return;
    this.admitting = true;
    try {
      while (!this.disposed) {
        const tasks = [...this.tasks.values()];
        if (tasks.filter((t) => t.run).length >= this.max) return;
        const t = tasks.find(
          (task) => task.status === "queued" && !task.stopping,
        );
        if (!t) return;
        const worker = this.factory(
          t.options,
          t.sessionFile,
          t.session === "saved",
        );
        const unsubscribe = worker.onEvent((event) =>
          this.event(t, run, event),
        );
        const input = t.pending.join("\n\n");
        const run: Execution = {
          worker,
          input,
          done: worker.run(input).then((report) => {
            unsubscribe();
            this.ended(t, run, report);
          }),
        };
        t.pending = [];
        t.run = run;
        t.activity = "";
        t.response = "";
        t.error = undefined;
        t.report = undefined;
        t.delivered = false;
        this.status(t, "active");
      }
    } finally {
      this.admitting = false;
    }
  }
  private event(t: Task, run: Execution, event: WorkerEvent) {
    if (this.disposed || t.run !== run) return;
    if (event.type === "turn_end") t.turns++;
    else if (event.type === "tool_execution_end") t.toolUses++;
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
      const text = event.message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      if (text) t.response = excerpt(text, PREVIEW_BYTES);
      t.tokens += event.message.usage?.totalTokens ?? 0;
      t.inputTokens += event.message.usage?.input ?? 0;
      t.outputTokens += event.message.usage?.output ?? 0;
    }
    this.emit();
  }
  private ended(t: Task, run: Execution, report: WorkerReport) {
    t.run = undefined;
    t.activity = "";
    // The journal's final report, not the bounded streamed preview, is authoritative.
    t.response = report.text;
    if (report.sessionLost) t.session = "lost";
    else if (report.saved && t.session !== "lost") t.session = "saved";
    if (report.usage) {
      // Whole-session snapshots replace the streamed counts; only their growth
      // is charged, as soon as it is confirmed.
      this.usage = addUsage(this.usage, usageDelta(report.usage, t.usage));
      t.usage = report.usage;
      t.tokens = report.usage.totalTokens;
      t.inputTokens = report.usage.input;
      t.outputTokens = report.usage.output;
    }
    // An interrupted or failed execution sends again what its session never saved.
    if (!report.inputPersisted && (report.interrupted || report.error))
      t.pending.unshift(run.input);
    if (report.error)
      t.error =
        report.error +
        (t.session === "lost" ? "; the session cannot continue" : "");
    if (this.disposed) return;
    const stopping = run.intent === "stop";
    let finalStatus: TaskStatus = report.error
      ? "failed"
      : report.interrupted || t.pending.length
        ? run.intent === "redirect"
          ? "queued"
          : "paused"
        : "ready";
    try {
      const captured = captureReport(
        this.view(t, stopping ? "stopped" : finalStatus),
        this.reports,
      );
      t.response = captured.response;
      t.error = captured.error;
      t.report = captured.report;
    } catch (error) {
      t.response = excerpt(t.response, PREVIEW_BYTES);
      t.error = excerpt(
        `Report capture failed: ${String(error)}${t.error ? `; ${t.error}` : ""}`,
        240,
      );
      t.report = undefined;
      if (finalStatus === "ready" || finalStatus === "queued")
        finalStatus = "failed";
    }
    if (stopping) return; // Its stop removes it.
    this.status(t, finalStatus);
    if (isSettled(t.status)) {
      try {
        this.onSettled?.();
      } catch {
        /* observer */
      }
    }
    this.admit();
  }
  /** Ends the exact execution; the intent decides what its task becomes. */
  private async end(t: Task, intent: Intent): Promise<void> {
    const run = t.run;
    if (!run) return;
    if (
      run.intent !== "stop" &&
      (intent !== "redirect" || run.intent !== "pause")
    )
      run.intent = intent;
    await run.worker.stop();
    await run.done;
  }
  /** Answers, corrects or retries: the same session continues with the message. */
  async message(id: string, text: string): Promise<void> {
    if (!text.trim()) throw new Error("Message must not be empty");
    const t = this.task(id);
    if (t.stopping || t.run?.intent === "stop")
      throw new Error("Task is stopping");
    if (t.session === "lost")
      throw new Error(
        "Task cannot continue: its session is lost. Stop it and start a new task if the work is still needed.",
      );
    t.pending.push(text);
    if (t.run) return this.end(t, "redirect");
    this.status(t, "queued");
    this.admit();
  }
  async pause(id: string): Promise<void> {
    const t = this.task(id);
    if (t.status === "queued") this.status(t, "paused");
    else await this.end(t, "pause");
  }
  continue(id: string): void {
    const t = this.task(id);
    if (t.stopping) throw new Error("Task is stopping");
    if (t.status !== "paused") throw new Error("Task is not paused");
    if (!t.pending.length) t.pending.push("Continue the task.");
    this.status(t, "queued");
    this.admit();
  }
  private remove(t: Task) {
    if (!this.tasks.delete(t.id)) return;
    this.totals.inputTokens += t.inputTokens;
    this.totals.outputTokens += t.outputTokens;
    this.emit();
    this.admit();
  }
  /** Removes a task in any state, ending its execution first. */
  async stop(id: string): Promise<TaskView> {
    const t = this.task(id);
    t.stopping = true;
    if (t.run) await this.end(t, "stop");
    this.remove(t);
    return this.view(t, "stopped");
  }
  /** Removes a task whose reply or failure needs no follow-up. */
  accept(id: string): TaskView {
    const t = this.task(id);
    if (!isSettled(t.status))
      throw new Error(`Cannot accept a ${t.status} task; stop it instead`);
    this.remove(t);
    return this.view(t, "accepted");
  }
  markDelivered(id: string): void {
    const t = this.tasks.get(id);
    if (!t || !isSettled(t.status) || t.delivered) return;
    t.delivered = true;
    this.emit();
  }
  /** Observes until the task needs a decision: settled, paused or the timeout. */
  wait(
    id: string,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<TaskView> {
    this.task(id);
    return new Promise((resolve, reject) => {
      const finish = (act: () => void) => {
        unsubscribe();
        signal?.removeEventListener("abort", abort);
        clearTimeout(timer);
        act();
      };
      const check = () => {
        const t = this.tasks.get(id);
        if (!t) finish(() => reject(new Error("Task was stopped")));
        else if (isSettled(t.status) || t.status === "paused")
          finish(() => resolve(this.view(t)));
      };
      const abort = () =>
        finish(() => reject(new DOMException("Wait aborted", "AbortError")));
      const unsubscribe = this.subscribe(check);
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => finish(() => resolve(this.get(id))), timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      else check();
    });
  }
  /** Confirmed usage not yet charged to the parent session. */
  drainUsage(): Usage | undefined {
    const usage = this.usage;
    this.usage = undefined;
    return usage;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.tasks.values()].map((t) => this.end(t, "stop")));
    this.tasks.clear();
    this.reports.dispose();
    this.usage = undefined;
    this.emit();
  }
}
