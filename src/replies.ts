import {
  truncateHead,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TaskResult, TaskView } from "./coordinator.ts";

/** Model-facing handoff; execution diagnostics stay in native result details. */
export function taskReport(task: TaskView | TaskResult) {
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
  messages?: readonly AgentMessage[],
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
  return replyBatch(replies.filter((task) => !covered.has(task.reply!.id)));
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

function notificationText(task: Parameters<typeof replyText>[0]) {
  const clipped = truncateHead(replyText(task), {
    maxBytes: 8000,
    maxLines: 100,
  });
  return {
    content:
      clipped.content +
      (clipped.truncated
        ? "\n[Truncated; use sub_result for the full response.]"
        : ""),
    complete: !clipped.truncated,
  };
}

/** One bounded native message; remaining replies stay eligible for the next turn. */
export function replyBatch(tasks: readonly TaskView[]) {
  const replies: (TaskView & { preview: string })[] = [];
  let content = "";
  for (const task of tasks) {
    const text = notificationText(task).content;
    const next = content ? `${content}\n\n${text}` : text;
    if (
      Buffer.byteLength(next, "utf8") > 24000 ||
      next.split("\n").length > 300
    )
      break;
    const response = stripTerminalSequences(task.error ?? task.response);
    replies.push({
      ...structuredClone(task),
      preview: truncateToWidth(
        response.split(/\r?\n/).find((line) => line.trim()) ?? "",
        160,
      ),
    });
    content = next;
  }
  return replies.length
    ? {
        customType: "pi-sub:response",
        display: true,
        content,
        details: { replies },
      }
    : undefined;
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

/** An announcement is durable even when its answer was only a truncated preview. */
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
    // Compare at exact segment positions, not substring matches: an answer may
    // itself quote another report. Truncation never acknowledges the whole batch.
    let offset = 0;
    return replyReports(message.details).flatMap((data, index) => {
      const part = notificationText(data);
      const segment = (index ? "\n\n" : "") + part.content;
      const complete = part.complete && text.startsWith(segment, offset);
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
