import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TaskView } from "./coordinator.ts";
import { deliveredFile, handoff, reportDetails } from "./reports.ts";

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Live tasks (newest-first, as Coordinator.list) are the inbox; native history
 * records announcements. Recompute at every boundary, never retain a second queue.
 */
export function pendingReplyBatch(
  tasks: readonly TaskView[],
  session: Pick<
    ExtensionContext["sessionManager"],
    "getBranch" | "buildSessionProjection"
  >,
  messages: readonly AgentMessage[] | undefined,
  cwd: string,
) {
  const replies = [...tasks]
    .reverse()
    .filter(
      (task) =>
        task.status === "ready" &&
        task.outcome === "reply" &&
        task.reply &&
        !task.reply.delivered,
    );
  if (!replies.length) return;
  const covered = new Set<string>();
  for (const entry of session.getBranch())
    if (entry.type === "custom_message")
      for (const reply of announcedReplies(entry)) covered.add(reply.replyId);
  for (const message of messages ?? session.buildSessionProjection().messages) {
    if (message.role === "custom")
      for (const reply of announcedReplies(message)) covered.add(reply.replyId);
    for (const reply of deliveredReplies(message)) covered.add(reply.replyId);
  }
  return replyBatch(
    replies.filter((task) => !covered.has(task.reply!.id)),
    cwd,
  );
}

export function replyText(
  task: Pick<TaskView, "id" | "description" | "response" | "error">,
): string {
  const response = stripTerminalSequences(task.error ?? task.response);
  const description = truncateToWidth(
    stripTerminalSequences(task.description).replace(/\s+/g, " ").trim(),
    160,
  );
  return `Subagent ${task.id} (${description})\n${response}`;
}

/** One bounded message: complete text or one immutable file for the entire batch. */
export function replyBatch(tasks: readonly TaskView[], cwd: string) {
  if (!tasks.length) return;
  const delivery = handoff(tasks.map(replyText).join("\n\n"), [...tasks], cwd, {
    maxBytes: 24000,
    maxLines: 300,
  });
  const replies = tasks.map((task) => ({
    ...structuredClone(task),
    preview: truncateToWidth(
      stripTerminalSequences(task.error ?? task.response)
        .split(/\r?\n/)
        .find((line) => line.trim()) ?? "",
      160,
    ),
  }));
  return {
    customType: "pi-sub:response",
    display: true,
    content: delivery.content,
    details: { replies, ...(delivery.file ? { handoff: delivery } : {}) },
  };
}

type ReplyReference = { id: string; replyId: string };
function replyReference(value: unknown): ReplyReference | undefined {
  const data = record(value);
  const reply = record(data?.reply);
  return data?.status === "ready" &&
    data.outcome === "reply" &&
    typeof data.id === "string" &&
    typeof reply?.id === "string"
    ? { id: data.id, replyId: reply.id }
    : undefined;
}
export function replyReports(details: unknown) {
  const data = record(details);
  return (Array.isArray(data?.replies) ? data.replies : [])
    .map(record)
    .filter(
      (
        item,
      ): item is Record<string, unknown> &
        Pick<TaskView, "id" | "description" | "response" | "error"> =>
        typeof item?.id === "string" &&
        typeof item.description === "string" &&
        typeof item.response === "string" &&
        (item.error === undefined || typeof item.error === "string"),
    );
}

/** Native history suppresses repeated announcements, including older previews. */
export function announcedReplies(message: {
  customType: string;
  details?: unknown;
}): ReplyReference[] {
  return message.customType === "pi-sub:response"
    ? replyReports(message.details).flatMap((data) => {
        const ref = replyReference(data);
        return ref ? [ref] : [];
      })
    : [];
}

/** Exact reply identities carried by complete, model-visible parent messages. */
export function deliveredReplies(message: AgentMessage): ReplyReference[] {
  const content = "content" in message ? message.content : undefined;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content) && content.every((part) => part.type === "text")
        ? content.map((part) => part.text).join("")
        : undefined;
  if (text === undefined) return [];
  if (message.role === "custom" && message.customType === "pi-sub:response") {
    if (deliveredFile(message.details, text)) return announcedReplies(message);
    // Compare exact segments: an answer may itself quote another report.
    let offset = 0;
    return replyReports(message.details).flatMap((data, index) => {
      const segment = (index ? "\n\n" : "") + replyText(data);
      const complete = text.startsWith(segment, offset);
      offset += segment.length;
      const ref = replyReference(data);
      return complete && ref ? [ref] : [];
    });
  }
  if (
    message.role === "toolResult" &&
    !message.isError &&
    ["sub_task", "sub_message", "sub_result", "sub_control"].includes(
      message.toolName,
    )
  ) {
    const details = reportDetails(message.details);
    const originals = Array.isArray(details) ? details : [details];
    if (deliveredFile(message.details, text))
      return originals.flatMap((value) => {
        const ref = replyReference(value);
        return ref ? [ref] : [];
      });
    let visible: unknown;
    try {
      visible = JSON.parse(text);
    } catch {
      return []; // Truncated tool returns are not complete deliveries.
    }
    const values = Array.isArray(visible) ? visible : [visible];
    return values.flatMap((value) => {
      const ref = replyReference(value);
      if (!ref) return [];
      const original = record(
        originals.find((candidate) => {
          const other = replyReference(candidate);
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
