import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { TaskView } from "./coordinator.ts";
import { ReportStore, type ReportRef } from "./report-store.ts";

/** Storage and context have separate budgets. Limits include the serialized envelope. */
export const INLINE_BYTES = 2 * 1024;
export const PREVIEW_BYTES = 512;
export const ENVELOPE_BYTES = 8 * 1024;

/** A UTF-8 prefix including its omission marker, without splitting a character. */
export function excerpt(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const buffer = Buffer.from(text.slice(0, maxBytes));
  let end = maxBytes - Buffer.byteLength("…");
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8") + "…";
}

/** Terminal commands and control characters never reach the screen. */
export const sanitize = (text: string) =>
  stripTerminalSequences(text)
    .replace(/\r\n/g, "\n")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
/** A bounded single line; rows cut it to their actual width. */
export function oneLine(text: string, length = 160): string {
  const line = sanitize(text.slice(0, 4096)).replace(/\s+/g, " ").trim();
  return line.length > length ? `${line.slice(0, length - 1)}…` : line;
}

/** The authoritative snapshot and the model-facing preview share one format. */
function snapshot(task: TaskView) {
  return {
    id: task.id,
    description: oneLine(task.description),
    status: task.status,
    response: task.response,
    error: task.error,
    unsent: task.unsent || undefined,
  };
}

export function captureReport(task: TaskView, store: ReportStore) {
  const report = store.put(JSON.stringify(snapshot(task), null, 2));
  const { response, error } = task;
  if (report.bytes <= INLINE_BYTES) return { response, error, report };
  return {
    response: excerpt(response, PREVIEW_BYTES),
    error: error === undefined ? undefined : excerpt(error, 240),
    report,
  };
}

function taskReport(task: TaskView) {
  if (task.status === "accepted" && task.delivered)
    return {
      id: task.id,
      status: task.status,
      report: task.report && { id: task.report.id },
    };
  return { ...snapshot(task), report: task.report };
}

/** Transcript diagnostics contain only previews, never another full report. */
function taskDetails(task: TaskView) {
  return {
    id: task.id,
    description: oneLine(task.description),
    level: task.level,
    execution: `${task.execution.provider}/${task.execution.model}:${task.execution.thinking}`,
    sessionFile: task.sessionFile,
    status: task.status,
    turns: task.turns,
    toolUses: task.toolUses,
    tokens: task.tokens,
    elapsedMs: task.elapsedMs,
    preview: oneLine(task.response),
    error: task.error === undefined ? undefined : oneLine(task.error, 240),
    unsent: task.unsent,
    report: task.report,
  };
}
export type TaskDetails = ReturnType<typeof taskDetails>;

/** Bound the whole handoff. Keep any report this envelope refers to readable on delivery. */
function envelope(
  text: string,
  store: ReportStore,
  summary: string,
  tasks: readonly TaskView[] = [],
) {
  if (Buffer.byteLength(text) <= ENVELOPE_BYTES) return { content: text };
  const references = new Set(
    tasks.flatMap((task) => (task.report ? [task.report.id] : [])),
  );
  const report = store.put(text, references);
  return { content: JSON.stringify({ summary, report }), report };
}

function taskHandoff(
  text: string,
  tasks: readonly TaskView[],
  store: ReportStore,
  label: string,
) {
  const failures = tasks.filter((task) => task.error !== undefined).length;
  const { content, report } = envelope(
    text,
    store,
    `${tasks.length} ${label}; ${failures} with errors.`,
    tasks,
  );
  return {
    content,
    details: {
      tasks: (report ? tasks.slice(0, 8) : tasks).map(taskDetails),
      ...(report ? { report, count: tasks.length } : {}),
    },
  };
}

export function toolResult(value: TaskView | TaskView[], store: ReportStore) {
  const tasks = Array.isArray(value) ? value : [value];
  const text = JSON.stringify(
    Array.isArray(value) ? tasks.map(taskReport) : taskReport(value),
  );
  const { content, details } = taskHandoff(
    text,
    tasks,
    store,
    "subagent task results",
  );
  return { content: [{ type: "text" as const, text: content }], details };
}

export function reportLink(report: ReportRef): string {
  return `Report: ${report.id} (${report.bytes} bytes)${report.file ? ` · ${report.file}` : ""}`;
}

function replyText(task: TaskView) {
  const header = `Subagent ${task.id} (${oneLine(task.description)})`;
  const body =
    task.error === undefined
      ? `${header}\n${task.response}`
      : `${header} failed\n${task.error}${task.response ? `\n\nLast response:\n${task.response}` : ""}`;
  return (
    body +
    (task.report && task.report.bytes > INLINE_BYTES
      ? `\n\n${reportLink(task.report)}`
      : "")
  );
}

export function replyBatch(tasks: readonly TaskView[], store: ReportStore) {
  return {
    customType: "pi-sub:response",
    display: true,
    ...taskHandoff(
      tasks.map(replyText).join("\n\n"),
      tasks,
      store,
      "subagent replies",
    ),
  };
}

export function stoppedNotice(tasks: readonly TaskView[], store: ReportStore) {
  const labels = tasks.map(
    (task) =>
      `${task.id} (${oneLine(task.description)})${task.report ? ` · report: ${task.report.id}` : ""}`,
  );
  const { content, report } = envelope(
    `The user stopped: ${labels.join("; ")}`,
    store,
    `The user stopped ${tasks.length} tasks.`,
    tasks,
  );
  return {
    customType: "pi-sub:stopped",
    display: true,
    content,
    details: report ? { report } : {},
  };
}

export function errorResult(message: string, store: ReportStore) {
  try {
    const { content, report } = envelope(message, store, oneLine(message, 240));
    return {
      content: [{ type: "text" as const, text: content }],
      details: report ? { report } : {},
      isError: true,
    };
  } catch {
    // A failed spill cannot prevent the tool from reporting its failure.
    return {
      content: [
        {
          type: "text" as const,
          text: `${excerpt(message, PREVIEW_BYTES)}\nFull error report could not be retained.`,
        },
      ],
      details: {},
      isError: true,
    };
  }
}

/** Raw text avoids JSON escaping multiplying a page's context cost. */
export function readReport(
  store: ReportStore,
  id: string,
  offset?: number,
  limit?: number,
) {
  const { text, ...page } = store.read(id, offset, limit);
  const next =
    page.next === undefined
      ? "End of report."
      : `Next: sub_result({ report: "${id}", offset: ${page.next} })`;
  return {
    content: [
      {
        type: "text" as const,
        text: `Report ${id} · byte ${page.offset} of ${page.bytes}\n${next}\n\n${text}`,
      },
    ],
    details: { report: page },
  };
}
