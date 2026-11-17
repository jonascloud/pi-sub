import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { contentText, type Usage } from "@earendil-works/pi-ai";
import {
  getPackageDir,
  parseSessionEntries,
  type JsonAgentSessionEvent,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { addUsage } from "./usage.ts";

export interface WorkerOptions {
  cwd: string;
  provider: string;
  model: string;
  thinking: ThinkingLevel;
  name: string;
  sessionDir: string;
  cliPath?: string;
  args?: string[];
  env?: Record<string, string>;
}
export type WorkerEvent = JsonAgentSessionEvent;
export interface WorkerReport {
  /** The last assistant text this execution saved. */
  text: string;
  /** Cumulative usage of the whole session, never a per-process increment. */
  usage?: Usage;
  error?: string;
  interrupted: boolean;
  /** The session gained a user message, so the input need not be sent again. */
  inputPersisted: boolean;
  /** A session file exists: the next execution continues it. */
  saved: boolean;
  /** A session that existed is gone: nothing can continue it. */
  sessionLost: boolean;
}
export interface Worker {
  /** Resolves once the process has exited, or without spawning if stopped first. Never rejects. */
  run(prompt: string): Promise<WorkerReport>;
  /** Resolves once the execution has ended. */
  stop(): Promise<void>;
  onEvent(listener: (event: WorkerEvent) => void): () => void;
}

const excludedTools = "sub_task,sub_message,sub_result,sub_control";
const stderrLimit = 16 * 1024;
const killGrace = 1000;
const drainGrace = 1000;

/**
 * One execution is one `pi --mode json --print` process on the task's session.
 * Its output is progress; the saved session is the result.
 */
export function createWorker(
  options: WorkerOptions,
  sessionFile: string,
  continues = false,
): Worker {
  const listeners = new Set<(event: WorkerEvent) => void>();
  let execution: Promise<WorkerReport> | undefined;
  let stopRequested = false;
  let exited = false;
  let terminate = () => {};

  async function execute(prompt: string): Promise<WorkerReport> {
    let error: string | undefined;
    let stderr = "";
    const fail = (message: string) => {
      error ??= message;
    };
    const report = (
      entries: SessionEntry[] | undefined,
      known: ReadonlySet<string> = new Set(),
      sessionLost = false,
    ): WorkerReport => {
      const fresh = (entries ?? []).flatMap((entry) =>
        entry.type === "message" && !known.has(entry.id) ? [entry.message] : [],
      );
      const reply = fresh.findLast((message) => message.role === "assistant");
      // Exit is not success: only a new saved reply that ended normally is.
      if (!stopRequested && !error) {
        const diagnostics = stderr.trim() ? `: ${stderr.trim()}` : "";
        if (!reply) fail(`No new assistant response${diagnostics}`);
        else if (reply.stopReason !== "stop")
          fail(
            (reply.errorMessage ||
              `Native response ended with ${reply.stopReason}`) + diagnostics,
          );
      }
      return {
        text: contentText(reply?.content ?? []),
        usage: entries && sessionUsage(entries),
        ...(error ? { error } : {}),
        interrupted: stopRequested,
        inputPersisted: fresh.some((message) => message.role === "user"),
        saved: entries !== undefined,
        sessionLost,
      };
    };

    try {
      const before = await readSession(sessionFile);
      if (continues && !before) {
        fail("Native session file is missing");
        return report(before, undefined, true);
      }
      const known = new Set(before?.map((entry) => entry.id));
      if (stopRequested) return report(before, known);

      // The parent's runtime, not whichever node happens to be first on PATH.
      const child = spawn(
        process.execPath,
        [
          options.cliPath
            ? resolve(options.cliPath)
            : resolve(getPackageDir(), "dist/cli.js"),
          ...(options.args ?? []),
          "--mode",
          "json",
          "--print",
          "--provider",
          options.provider,
          "--model",
          options.model,
          "--thinking",
          options.thinking,
          "--name",
          options.name,
          "--session-dir",
          options.sessionDir,
          "--session",
          sessionFile,
          "--exclude-tools",
          excludedTools,
          "-e",
          fileURLToPath(new URL("./child.ts", import.meta.url)),
        ],
        {
          cwd: options.cwd,
          env: {
            ...process.env,
            ...options.env,
            PI_SUB_CHILD: "1",
            PI_SUB_EXPECTED_PROVIDER: options.provider,
            PI_SUB_EXPECTED_MODEL: options.model,
            PI_SUB_EXPECTED_THINKING: options.thinking,
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const outcome = await new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((closed) => {
        let kill: ReturnType<typeof setTimeout> | undefined;
        let drain: ReturnType<typeof setTimeout> | undefined;
        terminate = () => {
          child.kill("SIGTERM");
          kill ??= setTimeout(() => child.kill("SIGKILL"), killGrace);
        };
        // Frames end at LF only: model text may contain other line separators.
        let pending = "";
        child.stdout.setEncoding("utf8").on("data", (text: string) => {
          const lines = (pending + text).split("\n");
          pending = lines.pop()!;
          for (const line of lines) {
            let event: WorkerEvent | { type: "session" };
            try {
              event = JSON.parse(line);
            } catch {
              continue; // Progress only: a damaged frame is no failure.
            }
            if (typeof event?.type !== "string" || event.type === "session")
              continue;
            for (const listener of listeners) {
              try {
                listener(event);
              } catch {
                /* Observers cannot end an execution. */
              }
            }
          }
        });
        child.stderr.setEncoding("utf8").on("data", (text: string) => {
          stderr = (stderr + text).slice(-stderrLimit);
        });
        for (const stream of [child.stdin, child.stdout, child.stderr])
          stream.on("error", () => {});
        child.on("error", (cause) => fail(`Native process: ${cause.message}`));
        // The session is final once the process is gone. A descendant holding
        // an inherited pipe gets a bounded wait, not the execution.
        child.once("exit", () => {
          exited = true;
          drain = setTimeout(() => {
            child.stdout.destroy();
            child.stderr.destroy();
          }, drainGrace);
        });
        child.once("close", (code, signal) => {
          clearTimeout(kill);
          clearTimeout(drain);
          exited = true;
          terminate = () => {};
          closed({ code, signal });
        });
        child.stdin.end(prompt);
      });
      if (!stopRequested && (outcome.code !== 0 || outcome.signal))
        fail(
          `Native process exited ${outcome.signal ?? outcome.code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
        );

      const after = await readSession(sessionFile);
      // An interrupted first start may not have saved anything yet.
      if (!after && (before || !stopRequested))
        fail("Native session file is missing");
      return report(after, known, !!before && !after);
    } catch (cause) {
      fail(cause instanceof Error ? cause.message : String(cause));
      return report(undefined);
    }
  }

  return {
    run(prompt) {
      execution ??= execute(prompt);
      return execution;
    },
    async stop() {
      // A process that already exited on its own finished its execution.
      if (!exited) stopRequested = true;
      terminate();
      await execution;
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Read-only, and as tolerant as the native loader: malformed lines are skipped. */
async function readSession(file: string): Promise<SessionEntry[] | undefined> {
  let contents: string;
  try {
    contents = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return parseSessionEntries(contents).filter(
    (entry): entry is SessionEntry =>
      entry.type !== "session" && typeof entry.id === "string",
  );
}

function sessionUsage(entries: readonly SessionEntry[]): Usage | undefined {
  let total: Usage | undefined;
  for (const entry of entries) {
    const usage =
      entry.type === "usage" ||
      entry.type === "compaction" ||
      entry.type === "branch_summary"
        ? entry.usage
        : entry.type === "message" &&
            (entry.message.role === "assistant" ||
              entry.message.role === "toolResult")
          ? entry.message.usage
          : undefined;
    if (usage) total = addUsage(total, usage);
  }
  return total;
}
