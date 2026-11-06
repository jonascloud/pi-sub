import {
  truncateHead,
  type MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  Text,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type { TaskView, TaskResult } from "./coordinator.ts";
import {
  describeLevels,
  type ApprovedModel,
  type Ladder,
  type Execution,
} from "./models.ts";

/** One stable instruction section; notifications carry observations, not a manual. */
export const SUBAGENT_GUIDANCE = `Delegate bounded, self-contained work when briefing, research, verification and integration overhead are worthwhile. Choose the minimum sufficient level; the confirmed ladder determines execution. Children do not inherit your conversation or interactive UI.
Tasks are asynchronous; a reply may be a question rather than a final result. Decide whether to continue or accept it. User interruption pauses children; a new prompt resumes only you. Failed work is closed and reported automatically.
Use reports internally; surface only material results, blockers or user decisions. Ignore reports for already collected or stopped tasks rather than acknowledging or collecting them again.`;

export function routingSummary(
  ladder: Ladder,
  approved: readonly ApprovedModel[],
): string {
  const groups: { from: number; to: number; execution?: Execution }[] = [];
  for (const row of describeLevels(ladder, approved)) {
    const last = groups.at(-1);
    if (
      last &&
      JSON.stringify(last.execution) === JSON.stringify(row.execution)
    )
      last.to = row.level;
    else
      groups.push({ from: row.level, to: row.level, execution: row.execution });
  }
  return groups
    .map(({ from, to, execution: e }) => {
      const level = from === to ? `${from}` : `${from}–${to}`;
      return e
        ? `${level}: ${e.provider}/${e.model}:${e.thinking} · rung ${e.power} · ${e.cost === null ? "unknown" : `$${e.cost}`}`
        : `${level}: unavailable`;
    })
    .join("\n");
}

export function replyNotification(task: TaskView) {
  const response = stripTerminalSequences(task.error ?? task.response);
  const description = truncateToWidth(
    stripTerminalSequences(task.description).replace(/\s+/g, " ").trim(),
    160,
  );
  return {
    customType: "pi-sub:response",
    display: true,
    content: truncateHead(`Subagent ${task.id} (${description})\n${response}`, {
      maxBytes: 8000,
      maxLines: 100,
    }).content,
    details: {
      id: task.id,
      description,
      preview: truncateToWidth(
        response.split(/\r?\n/).find((line) => line.trim()) ?? "",
        160,
      ),
    },
  };
}

/** The full delivery remains model-visible and expandable; the TUI preview is two lines. */
export const renderReply: MessageRenderer = (
  message,
  { expanded, outputPad },
  theme,
) => {
  const content = stripTerminalSequences(
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
  );
  if (expanded) return new Text(content, outputPad, 0);
  const details = message.details as
    { description?: unknown; preview?: unknown } | undefined;
  const lines = content.split(/\r?\n/);
  const description =
    typeof details?.description === "string"
      ? details.description
      : (lines[0] ?? "Subagent response");
  const preview =
    typeof details?.preview === "string"
      ? details.preview
      : (lines.slice(1).find((line) => line.trim()) ?? "");
  return {
    render(width) {
      const room = Math.max(0, width - outputPad * 2);
      const pad = " ".repeat(Math.min(outputPad, Math.floor(width / 2)));
      return [
        theme.bold(
          truncateToWidth(
            stripTerminalSequences(description).replace(/\s+/g, " ").trim() +
              " · response",
            room,
          ),
        ),
        theme.fg(
          "dim",
          truncateToWidth(
            stripTerminalSequences(preview).replace(/\s+/g, " ").trim(),
            room,
          ),
        ),
      ].map((line) => pad + line + pad);
    },
    invalidate() {},
  };
};

export function failureSummary(failures: readonly TaskResult[]): string {
  const lines = failures.map((report) => {
    const identity = `${report.description} (${report.id}): ${report.error ?? "execution failed"}`;
    const partial = report.response
      ? `\nPartial: ${truncateHead(report.response, { maxBytes: 1600, maxLines: 30 }).content}`
      : "";
    const pending = report.pendingInput?.length
      ? `\nPending: ${report.pendingInput.map((text) => truncateHead(text, { maxBytes: 1600, maxLines: 30 }).content).join("\n")}`
      : "";
    return stripTerminalSequences(identity + partial + pending);
  });
  return truncateHead(`Collected failures:\n${lines.join("\n")}`, {
    maxBytes: 16000,
    maxLines: 160,
  }).content;
}
