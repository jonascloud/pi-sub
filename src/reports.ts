import { createHash } from "node:crypto";
import {
  stripTerminalSequences,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type { TaskResult, TaskView } from "./coordinator.ts";
import type { Workspace } from "./workspace.ts";

export type Report = TaskView | TaskResult;
export type Reports = string | Report | Report[];
export interface Handoff {
  content: string;
  file?: string;
}
const TOOL_LIMITS = { maxBytes: 50 * 1024, maxLines: 2000 };

/** Model-facing handoff; execution diagnostics stay in native result details. */
export function taskReport(task: Report) {
  return {
    id: task.id,
    description: task.description,
    ...("status" in task
      ? { status: task.status, operation: task.operation }
      : {}),
    outcome: task.outcome,
    ...("reply" in task && task.reply ? { reply: { id: task.reply.id } } : {}),
    response: task.response,
    error: task.error,
    pendingInput: task.pendingInput?.length ? task.pendingInput : undefined,
  };
}

/** Actual text lines, not a report escaped inside one large JSON string. */
function reportText(value: Reports): string {
  if (typeof value === "string") return value;
  return (Array.isArray(value) ? value : [value])
    .map((task) => {
      const { description, response, error, pendingInput, ...identity } =
        taskReport(task);
      return [
        JSON.stringify(identity, null, 2),
        `Task:\n${description}`,
        ...(error === undefined ? [] : [`Error:\n${error}`]),
        `Response:\n${response}`,
        ...(pendingInput ?? []).map((input) => `Pending input:\n${input}`),
      ].join("\n\n");
    })
    .join("\n\n---\n\n");
}

export const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const preview = (text: string) =>
  truncateToWidth(
    stripTerminalSequences(text.slice(0, 4096)).replace(/\s+/g, " ").trim(),
    160,
  );

/** Persist diagnostics, not a second copy of the answer or unsent instructions. */
export function taskMetadata(task: Report) {
  return {
    id: task.id,
    description: preview(task.description),
    level: task.level,
    execution: { ...task.execution },
    sessionFile: task.sessionFile,
    turns: task.turns,
    toolUses: task.toolUses,
    tokens: task.tokens,
    elapsedMs: task.elapsedMs,
    ...("status" in task
      ? {
          status: task.status,
          operation: task.operation,
          reply: task.reply ? { ...task.reply } : undefined,
        }
      : {}),
    outcome: task.outcome,
    preview: preview(task.response),
    responseHash: digest(task.response),
    error: task.error === undefined ? undefined : preview(task.error),
    errorHash: task.error === undefined ? undefined : digest(task.error),
    pendingInputs: task.pendingInput?.length ?? 0,
  };
}
export type TaskMetadata = ReturnType<typeof taskMetadata>;

/** The entire envelope, including the reference, must fit. Never clip serialized JSON. */
export function handoff(
  content: string,
  value: Reports,
  workspace: Workspace,
  limits = TOOL_LIMITS,
): Handoff {
  const fits = (text: string) =>
    Buffer.byteLength(text, "utf8") <= limits.maxBytes &&
    text.split("\n").length <= limits.maxLines;
  if (fits(content)) return { content };
  const file = workspace.saveReport(reportText(value));
  const envelope = JSON.stringify({
    ...reportState(value),
    file,
    note: "Temporary report; read as needed and preserve relevant findings before session switch, reload or shutdown.",
  });
  if (!fits(envelope))
    throw new Error("Report reference exceeds the handoff limit");
  return { content: envelope, file };
}

/** Storage errors must preserve the operation's confirmed task state. */
function reportState(value: Reports) {
  const tasks =
    typeof value === "string" ? [] : Array.isArray(value) ? value : [value];
  const task = tasks.length === 1 ? tasks[0]! : undefined;
  return {
    ...(task
      ? {
          id: task.id,
          ...("status" in task
            ? { status: task.status, operation: task.operation }
            : { archived: true }),
          outcome: task.outcome,
        }
      : tasks.length
        ? {
            count: tasks.length,
            archived: tasks.filter((task) => !("status" in task)).length,
          }
        : {}),
    ...(tasks.length
      ? {
          errors: tasks.filter(
            (task) => task.error !== undefined || task.outcome === "error",
          ).length,
        }
      : {}),
  };
}

export function reportResult(value: Reports, workspace: Workspace) {
  const report =
    typeof value === "string"
      ? undefined
      : Array.isArray(value)
        ? value.map(taskMetadata)
        : taskMetadata(value);
  const raw =
    typeof value === "string"
      ? value
      : JSON.stringify(
          Array.isArray(value) ? value.map(taskReport) : taskReport(value),
        );
  try {
    const result = handoff(raw, value, workspace);
    return {
      content: [{ type: "text" as const, text: result.content }],
      details: {
        report,
        ...(result.file
          ? { handoff: { file: result.file, digest: digest(result.content) } }
          : {}),
      },
    };
  } catch (error) {
    const reportError = error instanceof Error ? error.message : String(error);
    const failure = {
      ...reportState(value),
      reportError,
      note:
        typeof value === "string"
          ? "Report storage failed. Retry after fixing storage."
          : "Task state above is confirmed. The full report is retained only in this active session; retry sub_result after fixing storage.",
    };
    // Keep the fallback bounded even if a diagnostic contains an oversized path.
    if (
      Buffer.byteLength(JSON.stringify(failure), "utf8") > TOOL_LIMITS.maxBytes
    )
      failure.reportError = "Report storage failed.";
    return {
      content: [{ type: "text" as const, text: JSON.stringify(failure) }],
      details: { report, reportError: preview(reportError) },
      isError: true,
    };
  }
}

function artifact(
  details: unknown,
): { file: string; digest: string } | undefined {
  if (!details || typeof details !== "object" || !("handoff" in details))
    return;
  const value = details.handoff;
  if (
    value &&
    typeof value === "object" &&
    "file" in value &&
    typeof value.file === "string" &&
    "digest" in value &&
    typeof value.digest === "string"
  )
    return { file: value.file, digest: value.digest };
}

export function reportFailure(details: unknown): string | undefined {
  return details &&
    typeof details === "object" &&
    "reportError" in details &&
    typeof details.reportError === "string"
    ? details.reportError
    : undefined;
}

/** Inline content is the sole stored copy of the body; renderers may combine it with diagnostics. */
export function reportDetails(details: unknown, content?: string): unknown {
  const report =
    details && typeof details === "object" && "report" in details
      ? details.report
      : details;
  if (!content) return report;
  let visible: unknown;
  try {
    visible = JSON.parse(content);
  } catch {
    return report;
  }
  const values = Array.isArray(visible) ? visible : [visible];
  const merge = (value: unknown, index: number) => {
    const body = values[index];
    if (
      !value ||
      typeof value !== "object" ||
      !("id" in value) ||
      !body ||
      typeof body !== "object" ||
      !("id" in body) ||
      value.id !== body.id ||
      !("response" in body) ||
      typeof body.response !== "string"
    )
      return value;
    return {
      ...value,
      ...("description" in body && typeof body.description === "string"
        ? { description: body.description }
        : {}),
      response: body.response,
      ...("error" in body ? { error: body.error } : {}),
      ...("pendingInput" in body ? { pendingInput: body.pendingInput } : {}),
    };
  };
  return Array.isArray(report) ? report.map(merge) : merge(report, 0);
}

/** Delivery proves the exact saved-file reference was in context, not that its file was read. */
export function deliveredFile(details: unknown, content: string): boolean {
  return artifact(details)?.digest === digest(content);
}
