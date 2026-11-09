import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import {
  getPackageDir,
  parseSessionEntries,
  type JsonAgentSessionEvent,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
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
  text: string;
  sessionFile: string;
  /** Cumulative native session usage, never a per-process increment. */
  usage?: Usage;
  error?: string;
  interrupted: boolean;
  // Exact prompt evidence only. Native input transformations may make this
  // unprovable; interrupted/failed executions then conservatively replay input.
  inputPersisted: boolean;
  /** Native journal identity retained across fresh execution processes. */
  sessionId?: string;
}
export interface Worker {
  /** Resolves after drained process close, or without spawning on preflight failure. */
  run(prompt: string): Promise<WorkerReport>;
  stop(): Promise<void>;
  onEvent(listener: (event: WorkerEvent) => void): () => void;
}

const excludedTools = "sub_task,sub_message,sub_result,sub_control";
const stderrLimit = 16 * 1024;
const recordLimit = 16 * 1024 * 1024;
const terminateGrace = 1000;
const killGrace = 2000;

/** One execution owns one child; only the native session survives continuations. */
export function createWorker(
  options: WorkerOptions,
  sessionFile: string,
  expectedSessionId?: string,
): Worker {
  const listeners = new Set<(event: WorkerEvent) => void>();
  let execution: Promise<WorkerReport> | undefined;
  let child: ChildProcessWithoutNullStreams | undefined;
  let stopRequested = false;
  let processClosed = false;
  let terminate: (() => Promise<void>) | undefined;
  let stopping: Promise<void> | undefined;

  async function execute(prompt: string): Promise<WorkerReport> {
    let lastAssistant: AssistantMessage | undefined;
    let inputPersisted = false;
    let failure: string | undefined;
    let stderr = "";
    const fail = (message: string) => {
      failure ??= message;
    };
    const before = await readSession(sessionFile);
    let sessionId = before.id;
    const entries = new Map(before.entries.map((entry) => [entry.id, entry]));
    const report = (usage?: Usage): WorkerReport => ({
      text:
        lastAssistant?.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n") ?? "",
      sessionFile,
      usage,
      ...(failure ? { error: failure } : {}),
      interrupted: stopRequested,
      inputPersisted,
      ...(sessionId ? { sessionId } : {}),
    });
    // Only a genuinely new task may start without a journal. Never let the
    // native loader silently replace lost, substituted or damaged history.
    if (
      before.error ||
      (expectedSessionId && before.id !== expectedSessionId)
    ) {
      fail(
        before.error ??
          (before.missing
            ? "Native session file is missing"
            : "Native session identity changed"),
      );
      // A damaged preflight ledger is not a replacement cumulative snapshot.
      // The coordinator keeps its last confirmed snapshot; no new work ran.
      return report();
    }
    if (stopRequested) return report(aggregateUsage(before.entries));

    try {
      child = spawn(
        "node",
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
            PI_SUB_EXPECTED_SESSION_FILE: resolve(options.cwd, sessionFile),
            PI_SUB_EXPECTED_SESSION_ID: sessionId ?? "",
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const stdout = new StringDecoder("utf8");
      const diagnostics = new StringDecoder("utf8");
      let pending = "";
      let discarding = false;
      let protocolFailed = false;
      const protocolFailure = (message: string) => {
        fail(message);
        if (protocolFailed || processClosed) return;
        protocolFailed = true;
        // This is failure cleanup, not a caller-requested interruption. Keep
        // draining and leave run pending if this bounded attempt fails.
        void terminate?.().catch((error: unknown) => fail(String(error)));
      };
      const line = (value: string) => {
        if (!value.trim()) return;
        try {
          const event = JSON.parse(value) as WorkerEvent | { type: "session" };
          if (
            !event ||
            typeof event !== "object" ||
            typeof event.type !== "string"
          )
            throw new Error("Expected JSON event object");
          if (event.type === "session") return;
          if (event.type === "message_end") {
            // Native message events precede journal writes: progress is not
            // persistence evidence, even for an exact copy of the input.
            if (event.message.role === "assistant") {
              if (!validAssistant(event.message))
                throw new Error("Invalid assistant message");
              lastAssistant = event.message;
            }
          }
          for (const listener of listeners) {
            try {
              listener(event);
            } catch {
              /* Consumers cannot interrupt draining. */
            }
          }
        } catch {
          protocolFailure("Invalid native JSON output");
        }
      };
      const consume = (value: string) => {
        pending += value;
        let index: number;
        while ((index = pending.indexOf("\n")) !== -1) {
          const record = pending.slice(0, index);
          if (!discarding && record.length <= recordLimit)
            line(record.replace(/\r$/, ""));
          else protocolFailure("Native JSON record exceeds size limit");
          pending = pending.slice(index + 1);
          discarding = false;
        }
        if (pending.length > recordLimit) {
          protocolFailure("Native JSON record exceeds size limit");
          pending = "";
          discarding = true;
        }
      };
      let stdoutEnded = false;
      const finishStdout = () => {
        if (stdoutEnded) return;
        stdoutEnded = true;
        consume(stdout.end());
        // Killing a writer can truncate its last progress frame. The saved
        // journal still must validate; genuine protocol failures remain errors.
        if (!stopRequested && (pending || discarding))
          protocolFailure("Incomplete native JSON output at EOF");
      };
      const outcome = await new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolveClose) => {
        let notifyClosed!: () => void;
        const closed = new Promise<void>((resolve) => {
          notifyClosed = resolve;
        });
        child!.stdout.on("data", (data: Buffer) => consume(stdout.write(data)));
        child!.stdout.once("end", finishStdout);
        child!.stdout.on("error", (error: Error) =>
          protocolFailure(`Native stdout: ${error.message}`),
        );
        child!.stderr.on("error", (error: Error) =>
          fail(`Native stderr: ${error.message}`),
        );
        child!.stderr.on("data", (data: Buffer) => {
          stderr = (stderr + diagnostics.write(data)).slice(-stderrLimit);
        });
        child!.stdin.on("error", (error: Error) => {
          if (!stopRequested) fail(`Native stdin: ${error.message}`);
        });
        child!.on("error", (error: Error) =>
          fail(`Native process: ${error.message}`),
        );
        child!.once("close", (code, signal) => {
          processClosed = true;
          notifyClosed();
          finishStdout();
          stderr = (stderr + diagnostics.end()).slice(-stderrLimit);
          resolveClose({ code, signal });
        });
        terminate = () => {
          if (processClosed) return Promise.resolve();
          if (stopping) return stopping;
          let killTimer: ReturnType<typeof setTimeout> | undefined;
          let deadline: ReturnType<typeof setTimeout> | undefined;
          stopping = new Promise<void>((resolveStop, rejectStop) => {
            void closed.then(resolveStop);
            deadline = setTimeout(() => {
              rejectStop(
                new Error(
                  "Native process did not close after SIGKILL; stop may be retried",
                ),
              );
            }, terminateGrace + killGrace);
            child!.kill("SIGTERM");
            killTimer = setTimeout(() => {
              if (processClosed) return;
              try {
                child!.kill("SIGKILL");
              } catch (error) {
                rejectStop(error);
              }
            }, terminateGrace);
          }).finally(() => {
            clearTimeout(killTimer);
            clearTimeout(deadline);
            stopping = undefined;
          });
          // A failed bounded stop attempt never settles the execution promise.
          // Only the ChildProcess close callback above owns that boundary.
          return stopping;
        };
        try {
          child!.stdin.end(prompt);
        } catch (error) {
          fail(`Native stdin: ${String(error)}`);
          child!.stdin.destroy();
        }
      });
      // close, not exit/agent_settled, is the boundary: both pipes are drained.
      if (!stopRequested && (outcome.code !== 0 || outcome.signal)) {
        fail(
          `Native process exited ${outcome.signal ?? outcome.code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
        );
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
      if (child && !processClosed) {
        child.stdin.destroy();
        child.stdout.resume();
        child.stderr.resume();
        await new Promise<void>((resolve) => {
          child!.once("close", () => {
            processClosed = true;
            resolve();
          });
        });
      }
    }

    const saved = await readSession(sessionFile);
    if (saved.error) fail(saved.error);
    if (saved.missing && (sessionId || !stopRequested))
      fail("Native session file is missing");
    if (sessionId && saved.id && saved.id !== sessionId)
      fail("Native session identity changed");
    sessionId ??= saved.id;
    // A damaged or foreign snapshot is not evidence for any of its records.
    // Even a valid snapshot must not replace an already confirmed entry.
    const changed = saved.entries.some((entry) => {
      const previous = entries.get(entry.id);
      return previous && JSON.stringify(previous) !== JSON.stringify(entry);
    });
    if (changed && !saved.error && saved.id === sessionId)
      fail("Native session entry changed");
    const trusted =
      !saved.error && !saved.missing && saved.id === sessionId && !changed;
    for (const entry of trusted ? saved.entries : []) {
      if (entries.has(entry.id) || entry.type !== "message") continue;
      if (matchesInput(entry.message, prompt)) inputPersisted = true;
      if (entry.message.role === "assistant") lastAssistant = entry.message;
    }
    if (!stopRequested) {
      if (!lastAssistant)
        fail(
          `No new assistant response${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
        );
      else if (lastAssistant.stopReason !== "stop")
        fail(
          `${lastAssistant.errorMessage || `Native response ended with ${lastAssistant.stopReason}`}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
        );
    }
    // Retain confirmed records even if the final read is unusable. No partial
    // records from a corrupt snapshot can establish their own provenance.
    if (trusted)
      for (const entry of saved.entries)
        if (!entries.has(entry.id)) entries.set(entry.id, entry);
    return report(aggregateUsage(entries.values()));
  }

  return {
    run(prompt) {
      if (execution)
        return Promise.reject(new Error("Worker can only run once"));
      if (typeof prompt !== "string" || !prompt.trim())
        return Promise.reject(new Error("Worker prompt must not be empty"));
      execution = execute(prompt);
      return execution;
    },
    async stop() {
      if (!processClosed) {
        stopRequested = true; // Must precede signal delivery, even during startup.
        await terminate?.();
      }
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

/** Read-only inspection; unlike SessionManager.open this cannot repair/rewrite files. */
async function readSession(file: string): Promise<{
  entries: SessionEntry[];
  id?: string;
  missing?: boolean;
  error?: string;
}> {
  let contents: string;
  try {
    contents = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { entries: [], missing: true };
    return {
      entries: [],
      error: `Cannot read native session: ${String(error)}`,
    };
  }
  const entries: SessionEntry[] = [];
  const ids = new Set<string>();
  let header: string | undefined;
  const parsed = parseSessionEntries(contents);
  // The native parser deliberately skips malformed JSON. Detect that loss
  // separately, without repairing the file or reconstructing native entries.
  let corrupt =
    parsed.length !== contents.split("\n").filter((line) => line.trim()).length;
  for (const value of parsed) {
    try {
      if (!header) {
        if (value?.type !== "session" || typeof value.id !== "string")
          throw new Error("Missing session header");
        header = value.id;
      } else {
        if (
          !value ||
          typeof value.id !== "string" ||
          typeof value.type !== "string" ||
          (value.type === "message" &&
            (!value.message || typeof value.message.role !== "string"))
        )
          throw new Error("Invalid session entry");
        if (
          value.type === "message" &&
          value.message.role === "assistant" &&
          !validAssistant(value.message)
        )
          throw new Error("Invalid assistant message");
        const entry = value as SessionEntry;
        if (ids.has(entry.id)) throw new Error("Duplicate session entry");
        ids.add(entry.id);
        const usage = entryUsage(entry);
        if (usage !== undefined && !validUsage(usage))
          throw new Error("Invalid usage");
        entries.push(entry);
      }
    } catch {
      corrupt = true;
    }
  }
  return {
    entries,
    id: header,
    ...(!header || corrupt ? { error: "Corrupt native session file" } : {}),
  };
}

function matchesInput(
  message: { role: string; content?: unknown },
  prompt: string,
): boolean {
  if (message.role !== "user") return false;
  const content = message.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter(
              (part) => part?.type === "text" && typeof part.text === "string",
            )
            .map((part) => part.text)
            .join("")
        : undefined;
  // CLI stdin trims boundary whitespace. Do not acknowledge unrelated extension
  // startup/follow-up messages, or guess how native input transforms rewrote ours.
  return text !== undefined && text.trim() === prompt.trim();
}

function validAssistant(value: AssistantMessage): boolean {
  return (
    Array.isArray(value.content) &&
    value.content.every(
      (part) =>
        part &&
        typeof part.type === "string" &&
        (part.type !== "text" || typeof part.text === "string"),
    ) &&
    typeof value.stopReason === "string" &&
    (value.errorMessage === undefined || typeof value.errorMessage === "string")
  );
}

function entryUsage(entry: SessionEntry): Usage | undefined {
  return entry.type === "usage" ||
    entry.type === "compaction" ||
    entry.type === "branch_summary"
    ? entry.usage
    : entry.type === "message" &&
        (entry.message.role === "assistant" ||
          entry.message.role === "toolResult")
      ? entry.message.usage
      : undefined;
}

function validUsage(value: Usage): boolean {
  if (!value || !value.cost) return false;
  const finite = (number: unknown) =>
    typeof number === "number" && Number.isFinite(number);
  return (
    ["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every((key) =>
      finite(value[key as keyof Usage]),
    ) &&
    ["input", "output", "cacheRead", "cacheWrite", "total"].every((key) =>
      finite(value.cost[key as keyof Usage["cost"]]),
    ) &&
    (value.reasoning === undefined || finite(value.reasoning)) &&
    (value.cacheWrite1h === undefined || finite(value.cacheWrite1h)) &&
    (value.cost.totalFromProvider === undefined ||
      typeof value.cost.totalFromProvider === "boolean")
  );
}

function aggregateUsage(entries: Iterable<SessionEntry>): Usage | undefined {
  let usage: Usage | undefined;
  for (const entry of entries) {
    const value = entryUsage(entry);
    if (!value) continue;
    usage = addUsage(usage, value);
  }
  return usage;
}
