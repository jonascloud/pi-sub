import {
  truncateHead,
  type MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  Text,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TaskView, TaskResult } from "./coordinator.ts";
import {
  describeLevels,
  type AvailableModel,
  type Ladder,
  type Execution,
} from "./models.ts";

/** One stable instruction section; notifications carry observations, not a manual. */
export const SUBAGENT_GUIDANCE = `Delegate bounded, self-contained work when briefing, research, verification and integration overhead are worthwhile. Choose the minimum sufficient level; the confirmed ladder determines execution. Children do not inherit your conversation or interactive UI.
Tasks are asynchronous; a reply may be a question rather than a final result. Delivered replies remain available for follow-up; finish:true closes a task, it is not needed to acknowledge a report or clear its widget row. User interruption pauses children; a new prompt resumes only you. Failed work is closed and reported automatically.
Use reports internally; surface only material results, blockers or user decisions. Ignore reports for already collected or stopped tasks rather than acknowledging or collecting them again.`;

export function routingSummary(
  ladder: Ladder,
  available: readonly AvailableModel[],
): string {
  const groups: { from: number; to: number; execution?: Execution }[] = [];
  for (const row of describeLevels(ladder, available)) {
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

function replyText(
  task: Pick<TaskView, "id" | "description" | "response" | "error">,
): string {
  const response = stripTerminalSequences(task.error ?? task.response);
  const description = truncateToWidth(
    stripTerminalSequences(task.description).replace(/\s+/g, " ").trim(),
    160,
  );
  return `Subagent ${task.id} (${description})\n${response}`;
}

export function replyNotification(task: TaskView) {
  const response = stripTerminalSequences(task.error ?? task.response);
  const clipped = truncateHead(replyText(task), {
    maxBytes: 8000,
    maxLines: 100,
  });
  return {
    customType: "pi-sub:response",
    display: true,
    content:
      clipped.content +
      (clipped.truncated
        ? "\n[Truncated; use sub_result for the full response.]"
        : ""),
    details: {
      ...structuredClone(task),
      preview: truncateToWidth(
        response.split(/\r?\n/).find((line) => line.trim()) ?? "",
        160,
      ),
    },
  };
}

/** Exact reply identities carried by complete, model-visible parent messages. */
export function deliveredReplies(
  message: AgentMessage,
): { id: string; replyId: string }[] {
  const reference = (value: unknown) => {
    const data = record(value);
    const reply = record(data?.reply);
    return data?.status === "ready" &&
      data.outcome === "reply" &&
      typeof data.id === "string" &&
      typeof reply?.id === "string"
      ? { id: data.id, replyId: reply.id }
      : undefined;
  };
  const content = "content" in message ? message.content : undefined;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content) && content.every((part) => part.type === "text")
        ? content.map((part) => part.text).join("")
        : undefined;
  if (text === undefined) return [];
  if (message.role === "custom" && message.customType === "pi-sub:response") {
    const data = record(message.details);
    const ref = reference(data);
    if (
      !ref ||
      typeof data?.description !== "string" ||
      typeof data.response !== "string" ||
      (data.error !== undefined && typeof data.error !== "string")
    )
      return [];
    const expected = replyText({
      id: ref.id,
      description: data.description,
      response: data.response,
      error: data.error,
    });
    return text === expected ? [ref] : [];
  }
  if (
    message.role === "toolResult" &&
    !message.isError &&
    ["sub_task", "sub_message", "sub_result", "sub_control"].includes(
      message.toolName,
    )
  ) {
    let visible: unknown;
    try {
      visible = JSON.parse(text);
    } catch {
      return []; // Truncated tool returns are not complete deliveries.
    }
    const originals = Array.isArray(message.details)
      ? message.details
      : [message.details];
    const values = Array.isArray(visible) ? visible : [visible];
    return values.flatMap((value) => {
      const ref = reference(value);
      if (!ref) return [];
      const original = record(
        originals.find((candidate) => {
          const other = reference(candidate);
          return other?.id === ref.id && other.replyId === ref.replyId;
        }),
      );
      const data = record(value);
      // Match the actual answer, not serialization whitespace or extra metadata.
      return typeof data?.response === "string" &&
        data.response === original?.response &&
        data.error === original?.error
        ? [ref]
        : [];
    });
  }
  return [];
}

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
  if (options.expanded && typeof details?.response === "string") {
    const { response, ...metadata } = details;
    const body = typeof metadata.error === "string" ? metadata.error : response;
    return fullDelivery(
      {
        ...message,
        content: `Subagent ${preview(metadata.id, 64)} (${identity(metadata)})\n${body}`,
        details: metadata,
      },
      options,
    );
  }
  if (options.expanded) return fullDelivery(message, options);
  const lines = messageText(message).split("\n");
  const oldHeader = /^Subagent (\S+) \((.*)\)(?: has a response:)?$/.exec(
    lines[0] ?? "",
  );
  const title =
    (details && identity(details)) ||
    (oldHeader
      ? preview(oldHeader[2]) || preview(oldHeader[1], 8)
      : preview(lines[0])) ||
    "Subagent";
  const answer =
    preview(details?.preview) ||
    preview(lines.slice(1).find((line) => line.trim()));
  return compact(
    [
      { text: `${title} · response`, style: "title" },
      { text: answer, style: "dim" },
    ],
    options,
    theme,
  );
};

function reports(message: Message): Record<string, unknown>[] {
  let value = message.details;
  if (!Array.isArray(value)) {
    // Old stopped messages stored the reports only as JSON content.
    try {
      value = JSON.parse(messageText(message));
    } catch {
      return [];
    }
  }
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
    // Legacy textual failure summaries already put the causes before partial work.
    return fullDelivery({ ...message, details: undefined }, options);
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
  const content = messageText(message).trim();
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
            text: /^[\[{]/.test(content)
              ? "Stopped tasks · details unavailable"
              : preview(content) || "Stopped tasks",
            style: "title",
          },
        ],
    options,
    theme,
  );
};

function rationale(text: string): string {
  let fenced = false;
  const lines = sanitize(text.slice(0, 4096))
    .split("\n")
    .filter((line) => {
      if (/^\s*```/.test(line)) {
        fenced = !fenced;
        return false;
      }
      return !fenced;
    });
  const prose = lines.find((line) => {
    const value = line.trim();
    return value && !/^(?:#{1,6}\s|[\[\]{}]|".*"\s*:|DRAFT\b)/.test(value);
  });
  const heading = lines.find((line) => /^#{1,6}\s+/.test(line.trim()));
  return (
    preview(prose ?? heading?.trim().replace(/^#{1,6}\s+/, "")) ||
    "Model comparison"
  );
}

/** Proposals stay explicitly unsaved; status messages retain their own wording. */
export const renderModels: MessageRenderer = (message, options, theme) => {
  const details = record(message.details);
  const proposal = record(details?.proposal);
  const draft =
    proposal &&
    record(proposal.ladder) &&
    typeof proposal.comparison === "string" &&
    proposal.comparison.trim().length > 0;
  const content = messageText(message);
  const legacy = content.indexOf("DRAFT (not saved):");
  const isDraft = draft || legacy >= 0;
  if (options.expanded) {
    let delivery = message;
    if (draft) {
      const sourceTask = record(details?.task);
      const taskMetadata = sourceTask
        ? Object.fromEntries(
            Object.entries(sourceTask).filter(([key]) => key !== "response"),
          )
        : undefined;
      delivery = {
        ...message,
        content: `${proposal.comparison}\n\nDRAFT (not saved):\n${JSON.stringify(proposal.ladder, null, 2)}`,
        details: taskMetadata ? { task: taskMetadata } : undefined,
      };
    }
    return fullDelivery(
      delivery,
      options,
      isDraft
        ? "Model ladder · DRAFT — not saved · AA reference USD/task · baseline at open"
        : undefined,
    );
  }
  if (!isDraft)
    return compact(
      [
        {
          text: /^[\[{]/.test(content.trim())
            ? "Model selection · details unavailable"
            : preview(content) || "Model selection",
          style: "title",
        },
      ],
      options,
      theme,
    );
  const task = record(details?.task);
  return compact(
    [
      {
        text: `DRAFT — not saved${task ? ` · ${identity(task)}` : ""}`,
        style: "title",
      },
      {
        text: rationale(
          draft ? (proposal.comparison as string) : content.slice(0, legacy),
        ),
      },
      ...(draft && Object.keys(proposal.ladder as object).length === 0
        ? [
            {
              text: "Empty draft — delegation disabled if accepted.",
              style: "error" as const,
            },
          ]
        : []),
    ],
    options,
    theme,
  );
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
