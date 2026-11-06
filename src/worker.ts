import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type {
  JsonAgentSessionEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

export interface WorkerOptions {
  cwd: string;
  provider: string;
  model: string;
  thinking: ThinkingLevel;
  name: string;
  sessionDir?: string;
  cliPath?: string;
  args?: string[];
  env?: Record<string, string>;
}
export type WorkerEvent =
  | JsonAgentSessionEvent
  | { type: "worker_error"; error: string }
  | { type: "worker_state"; idle: boolean }
  | { type: "worker_queue_cleared"; steering: string[]; followUp: string[] };
export interface WorkerReport {
  text: string;
  sessionFile?: string;
  usage?: Usage;
}
export interface Worker {
  start(): Promise<void>;
  send(message: string): Promise<"started" | "queued">;
  pause(): Promise<{ steering: string[]; followUp: string[] }>;
  report(): Promise<WorkerReport>;
  close(): Promise<void>;
  onEvent(listener: (event: WorkerEvent) => void): () => void;
}

import {
  RpcClient,
  SessionManager,
  getPackageDir,
} from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

const defaultCli = resolve(getPackageDir(), "dist/cli.js");
const excludedTools =
  "subagent,get_subagent_result,steer_subagent,sub_task,sub_message,sub_result,sub_control";

export function createWorker(options: WorkerOptions): Worker {
  const explicitFile = options.sessionDir
    ? resolve(options.cwd, options.sessionDir, `${randomUUID()}.jsonl`)
    : undefined;
  let sessionFile = explicitFile;
  const client = new RpcClient({
    cwd: options.cwd,
    cliPath: options.cliPath ? resolve(options.cliPath) : defaultCli,
    provider: options.provider,
    model: options.model,
    env: { ...options.env, PI_SUB_CHILD: "1" },
    args: [
      ...(options.args ?? []),
      "--thinking",
      options.thinking,
      "--name",
      options.name,
      ...(options.sessionDir ? ["--session-dir", options.sessionDir] : []),
      ...(explicitFile ? ["--session", explicitFile] : []),
      "--exclude-tools",
      excludedTools,
    ],
  });
  const listeners = new Set<(event: WorkerEvent) => void>();
  let failure: Error | undefined;
  let closed = false;
  let started = false;
  let starting: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let heartbeat: ReturnType<typeof setTimeout> | undefined;
  let active = false;
  let stateVersion = 0;
  let settled = false;
  let checking = Promise.resolve();
  let rejectInterrupted!: (error: Error) => void;
  const interrupted = new Promise<never>((_, reject) => {
    rejectInterrupted = reject;
  });
  void interrupted.catch(() => {});
  const check = () => {
    if (failure) throw failure;
    if (closed) throw new Error("Worker is closed");
    if (!started) throw new Error("Worker has not started");
  };
  const guarded = <T>(p: Promise<T>): Promise<T> =>
    Promise.race([p, interrupted]);
  const emit = (event: WorkerEvent) => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        /* A consumer must not break RPC dispatch. */
      }
    }
  };
  const stopHeartbeat = () => {
    active = false;
    clearTimeout(heartbeat);
    heartbeat = undefined;
  };
  const fail = (error: unknown) => {
    if (failure || closed) return;
    failure = error instanceof Error ? error : new Error(String(error));
    stopHeartbeat();
    emit({ type: "worker_error", error: failure.message });
    rejectInterrupted(failure);
    void close().catch(() => {
      /* The owner retries closure and retains the process slot on failure. */
    });
  };
  const beat = () => {
    if (!active || closed || failure) return;
    heartbeat = setTimeout(async () => {
      try {
        await guarded(client.getState());
      } catch (error) {
        fail(error);
        return;
      }
      beat();
    }, 2000);
  };
  const unsubscribe = client.onEvent((event) => {
    const raw = event as unknown as { type: string; method?: string };
    if (raw.type === "extension_ui_request") {
      if (["select", "confirm", "input", "editor"].includes(raw.method ?? "")) {
        fail(new Error(`Unsupported extension UI dialog: ${raw.method}`));
      }
      return;
    }
    if (event.type === "agent_start") {
      stateVersion++;
      settled = false;
      if (!active) {
        active = true;
        beat();
      }
    }
    if (event.type === "agent_settled") {
      stateVersion++;
      settled = true;
      void verifyState().catch(fail);
    }
    emit(event);
  });
  // Awaited extension hooks can reorder run events. Verify actual session state
  // instead of treating a settlement hint as proof of quiescence.
  function verifyState(): Promise<void> {
    const verified = checking.then(async () => {
      for (;;) {
        const version = stateVersion;
        const state = await guarded(client.getState());
        if (closed || failure) throw failure ?? new Error("Worker is closed");
        if (version !== stateVersion) continue;
        sessionFile = state.sessionFile ?? sessionFile;
        const idle =
          settled &&
          !state.isStreaming &&
          !state.isCompacting &&
          !state.pendingMessageCount;
        if (idle) stopHeartbeat();
        else if (!active) {
          active = true;
          beat();
        }
        emit({ type: "worker_state", idle });
        return;
      }
    });
    checking = verified.catch(() => {});
    return verified;
  }
  function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    stopHeartbeat();
    rejectInterrupted(failure ?? new Error("Worker is closed"));
    unsubscribe();
    listeners.clear();
    // start() installs the child synchronously, but its initialization timer must finish
    // before stop(), which otherwise invalidates the client's start check.
    closing = (async () => {
      if (starting) await starting.catch(() => {});
      await client.stop();
    })().catch((error) => {
      closing = undefined;
      throw error;
    });
    return closing;
  }
  async function savedReport(): Promise<WorkerReport> {
    await close();
    if (!sessionFile || !existsSync(sessionFile))
      throw (
        failure ?? new Error("Worker is closed; no persisted report available")
      );
    const session = SessionManager.open(sessionFile);
    const usage = aggregateUsage(session.getEntries());
    const message = session
      .buildSessionProjection()
      .messages.findLast((message) => message.role === "assistant");
    const text =
      message?.role === "assistant"
        ? message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n")
        : "";
    return { text, sessionFile, usage };
  }
  return {
    start() {
      if (failure) return Promise.reject(failure);
      if (closed) return Promise.reject(new Error("Worker is closed"));
      if (starting || started)
        return Promise.reject(new Error("Worker already started"));
      // Keep the native start separate from the handshake: close may interrupt the latter.
      starting = client.start();
      return (async () => {
        try {
          await guarded(starting!);
          const state = await guarded(client.getState());
          sessionFile = state.sessionFile ?? sessionFile;
          if (
            state.model?.provider !== options.provider ||
            state.model.id !== options.model ||
            state.thinkingLevel !== options.thinking
          ) {
            throw new Error(
              `Worker model mismatch: expected ${options.provider}/${options.model} thinking=${options.thinking}, got ${state.model?.provider}/${state.model?.id} thinking=${state.thinkingLevel}`,
            );
          }
          if (closed || failure) throw failure ?? new Error("Worker is closed");
          started = true;
        } catch (error) {
          if (!closed) fail(error);
          await close();
          throw failure ?? error;
        }
      })();
    },
    async send(message) {
      check();
      // Pi atomically starts idle sessions or queues input in an existing run.
      const disposition = await guarded(
        client.prompt(message, undefined, "steer"),
      );
      check();
      if (disposition === "handled")
        throw new Error(
          "Worker input was handled without starting or queuing a run",
        );
      // A start before ACK can belong to an older retry. Always obtain a fresh
      // post-ACK snapshot, even when another verification is already in flight.
      await verifyState();
      check();
      return disposition;
    },
    async pause() {
      check();
      try {
        const cleared = await guarded(client.clearQueue());
        emit({ type: "worker_queue_cleared", ...cleared });
        await guarded(client.abort());
        const state = await guarded(client.getState());
        sessionFile = state.sessionFile ?? sessionFile;
        check();
        if (
          state.isStreaming ||
          state.isCompacting ||
          state.pendingMessageCount
        )
          throw new Error("Worker did not become idle after abort");
        return cleared;
      } catch (error) {
        fail(error);
        throw error;
      }
    },
    async report() {
      if (failure || closed) return savedReport();
      check();
      let snapshot;
      try {
        snapshot = await guarded(
          Promise.all([
            client.getLastAssistantText(),
            client.getState(),
            client.getEntries(),
          ]),
        );
      } catch (error) {
        if (!closed) fail(error);
        if (failure) return savedReport();
        throw error;
      }
      if (failure) return savedReport();
      check();
      const [text, state, { entries }] = snapshot;
      if (state.isStreaming || state.isCompacting)
        throw new Error("Cannot report while worker is active");
      sessionFile = state.sessionFile ?? sessionFile;
      const usage = aggregateUsage(entries);
      return { text: text ?? "", sessionFile: state.sessionFile, usage };
    },
    close,
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function aggregateUsage(entries: SessionEntry[]): Usage | undefined {
  let usage: Usage | undefined;
  for (const entry of entries) {
    const value =
      entry.type === "usage" ||
      entry.type === "compaction" ||
      entry.type === "branch_summary"
        ? entry.usage
        : entry.type === "message" &&
            (entry.message.role === "assistant" ||
              entry.message.role === "toolResult")
          ? entry.message.usage
          : undefined;
    if (!value) continue;
    if (!usage) {
      usage = { ...value, cost: { ...value.cost } };
      continue;
    }
    for (const key of [
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
      "totalTokens",
    ] as const)
      usage[key] += value[key];
    for (const key of ["reasoning", "cacheWrite1h"] as const) {
      if (value[key] !== undefined) usage[key] = (usage[key] ?? 0) + value[key];
    }
    for (const key of [
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
      "total",
    ] as const)
      usage.cost[key] += value.cost[key];
    // A combined total is provider-reported only when every component is.
    if (
      usage.cost.totalFromProvider !== undefined ||
      value.cost.totalFromProvider !== undefined
    ) {
      usage.cost.totalFromProvider =
        usage.cost.totalFromProvider === true &&
        value.cost.totalFromProvider === true;
    }
  }
  return usage;
}
