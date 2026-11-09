import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  Text,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type { TaskResult } from "./coordinator.ts";
import { replyReports, replyText } from "./replies.ts";
import { STRENGTH_GUIDANCE } from "./models.ts";
import { reportDetails } from "./reports.ts";

/** One stable instruction section; notifications carry observations, not a manual. */
export const SUBAGENT_GUIDANCE = `Delegate bounded work when the result justifies briefing and integration overhead. Give the smallest sufficient brief: goal, scope, constraints, success criteria and decisive context. Prefer paths to copied content; do not repeat loaded instructions. Children share files and load native global/project instructions, not your conversation or UI. Follow-ups add new information with enough context to interpret it.
Choose the minimum sufficient level; do not lower it to fit availability. The configured ladder selects the execution.
${STRENGTH_GUIDANCE}
Replies arrive asynchronously and may be questions. A file reference delivers the full report; read it as needed. User interruption pauses children; a new prompt resumes only you.
Use reports internally; surface only material results, blockers or user decisions. Reports need no acknowledgement; stale reports alone are not a reason to revisit accepted/stopped tasks.`;

type Message = Parameters<MessageRenderer>[0];
type RenderOptions = Parameters<MessageRenderer>[1];
type Theme = Parameters<MessageRenderer>[2];

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

// Strip terminal commands as well as remaining control characters, not just colors.
const sanitize = (text: string) =>
  stripTerminalSequences(text)
    .replace(/\r\n/g, "\n")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

// Bound only the derived preview; never rewrite or shorten persisted payloads.
const preview = (value: unknown, width = 160) =>
  typeof value === "string"
    ? truncateToWidth(
        sanitize(value.slice(0, 4096)).replace(/\s+/g, " ").trim(),
        width,
      )
    : "";

function messageText(message: Message): string {
  if (typeof message.content === "string") return sanitize(message.content);
  if (!Array.isArray(message.content)) return "";
  return sanitize(
    message.content
      .flatMap((part) => {
        const block = record(part);
        return block?.type === "text" && typeof block.text === "string"
          ? [block.text]
          : [];
      })
      .join("\n"),
  );
}

function identity(task: Record<string, unknown>): string {
  return preview(task.description) || preview(task.id, 8) || "Task";
}

function compact(
  rows: { text: string; style?: "title" | "error" | "dim" }[],
  { outputPad }: RenderOptions,
  theme: Theme,
) {
  return {
    render(width: number) {
      if (width < 1) return [];
      const padding = Math.min(
        outputPad,
        Math.max(0, Math.floor((width - 1) / 2)),
      );
      const pad = " ".repeat(padding);
      const room = Math.max(0, width - padding * 2);
      return rows.map(({ text, style }) => {
        const line = truncateToWidth(text, room);
        const styled =
          style === "title"
            ? theme.bold(line)
            : style
              ? theme.fg(style, line)
              : line;
        return pad + styled + pad;
      });
    },
    invalidate() {},
  };
}

function fullDelivery(
  message: Message,
  options: RenderOptions,
  heading?: string,
) {
  let content = messageText(message);
  if (heading) content = `${heading}\n\n${content}`;
  if (message.details !== undefined) {
    // Sanitize string values before JSON encoding so escape sequences cannot hide
    // in the expanded metadata either. Persisted details are left untouched.
    let json: string | undefined;
    try {
      json = JSON.stringify(
        message.details,
        (_key, value) => (typeof value === "string" ? sanitize(value) : value),
        2,
      );
    } catch {
      json = "Metadata cannot be displayed as JSON.";
    }
    if (json) content += `\n\nDetails (JSON):\n${sanitize(json)}`;
  }
  const text = new Text(content, options.outputPad, 0);
  return {
    render(width: number) {
      // Text's minimum content width is one column, even at width zero.
      return width < 1
        ? []
        : text.render(width).map((line) => truncateToWidth(line, width));
    },
    invalidate() {
      text.invalidate();
    },
  };
}

/** Neutral delivery preview: a question and a final answer use the same view. */
export const renderReply: MessageRenderer = (message, options, theme) => {
  const details = record(message.details);
  if (Array.isArray(details?.replies)) {
    const replies = replyReports(details);
    if (options.expanded)
      return fullDelivery(
        {
          ...message,
          content: replies.map(replyText).join("\n\n"),
          details: {
            replies: replies.map(
              ({ response: _response, preview: _preview, ...metadata }) =>
                metadata,
            ),
          },
        },
        options,
      );
    return compact(
      replies.flatMap((reply) => [
        { text: `${identity(reply)} · response`, style: "title" as const },
        {
          text: preview(reply.preview) || preview(reply.response),
          style: "dim" as const,
        },
      ]),
      options,
      theme,
    );
  }
  if (options.expanded) return fullDelivery(message, options);
  return compact(
    [{ text: "Subagent response · details unavailable", style: "title" }],
    options,
    theme,
  );
};

function reports(message: Message): Record<string, unknown>[] {
  const value = reportDetails(message.details);
  return Array.isArray(value)
    ? value.filter((item) => {
        const task = record(item);
        return (
          task &&
          (typeof task.id === "string" || typeof task.description === "string")
        );
      })
    : [];
}

/** Every failed task gets a cause line, never hidden behind partial work. */
export const renderFailures: MessageRenderer = (message, options, theme) => {
  if (options.expanded) return fullDelivery(message, options);
  const tasks = reports(message);
  if (!tasks.length) {
    return compact(
      [{ text: "Failed · details unavailable", style: "error" }],
      options,
      theme,
    );
  }
  return compact(
    tasks.flatMap((task) => [
      { text: `Failed · ${identity(task)}`, style: "title" as const },
      {
        text: preview(task.error, 240) || "Execution failed",
        style: "error" as const,
      },
    ]),
    options,
    theme,
  );
};

/** Stop acknowledgements identify work, rather than dumping report JSON. */
export const renderStopped: MessageRenderer = (message, options, theme) => {
  if (options.expanded) return fullDelivery(message, options);
  const tasks = reports(message);
  const label = (task: Record<string, unknown>) =>
    task.outcome === "error"
      ? "Failed"
      : task.outcome === "reply"
        ? "Already accepted"
        : task.outcome === "stopped"
          ? "Stopped"
          : "Result";
  const allStopped = tasks.every((task) => task.outcome === "stopped");
  return compact(
    tasks.length
      ? [
          {
            text:
              tasks.length === 1
                ? `${label(tasks[0]!)} · ${identity(tasks[0]!)}`
                : `${allStopped ? "Stopped" : "Stop results"} · ${tasks.length} tasks`,
            style: "title",
          },
          ...tasks.flatMap((task) => [
            ...((!allStopped ||
              (typeof task.error === "string" && task.error)) &&
            tasks.length > 1
              ? [{ text: `${label(task)} · ${identity(task)}` }]
              : []),
            ...(typeof task.error === "string" && task.error
              ? [{ text: preview(task.error, 240), style: "error" as const }]
              : []),
          ]),
        ]
      : [
          {
            text: "Stopped tasks · details unavailable",
            style: "title",
          },
        ],
    options,
    theme,
  );
};

export function failureSummary(failures: readonly TaskResult[]): string {
  const lines = failures.map((report) => {
    const identity = `${report.description} (${report.id}): ${report.error ?? "execution failed"}`;
    const partial = report.response ? `\nPartial: ${report.response}` : "";
    const pending = report.pendingInput?.length
      ? `\nPending: ${report.pendingInput.join("\n")}`
      : "";
    return stripTerminalSequences(identity + partial + pending);
  });
  return `Collected failures:\n${lines.join("\n")}`;
}
