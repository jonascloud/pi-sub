import { expect, test } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TaskView } from "../src/coordinator.ts";
import {
  replyBatch,
  pendingReplyBatch,
  announcedReplies,
  deliveredReplies,
} from "../src/replies.ts";

const task: TaskView = {
  id: "task-1",
  level: 3,
  description: "Review changes",
  execution: { provider: "p", model: "m", thinking: "off" },
  sessionFile: "native.jsonl",
  turns: 1,
  toolUses: 0,
  tokens: 1,
  elapsedMs: 1,
  response: "Question?\nImportant detail.",
  status: "ready",
  outcome: "reply",
  activity: "",
};

test("replies carry identity and new information, not repeated operating instructions", () => {
  const reply = replyBatch([task])!;
  expect(reply.content).toBe(
    "Subagent task-1 (Review changes)\nQuestion?\nImportant detail.",
  );
  expect(reply.content).not.toContain("sub_message");
  expect(reply.content).not.toContain("sub_result");
  expect(reply.content).not.toContain("This may be a question");
  expect(reply.details.replies[0]).toMatchObject({
    ...task,
    preview: "Question?",
  });
  const long = replyBatch([{ ...task, response: "x".repeat(20000) }])!;
  expect(long.details.replies[0]!.preview.length).toBeLessThan(200);
  expect(long.content.length).toBeLessThan(8100);
});

test("only complete native reply notifications acknowledge their exact reply", () => {
  const ready = { ...task, reply: { id: "reply-1", delivered: false } };
  const message = {
    ...replyBatch([ready])!,
    role: "custom" as const,
    timestamp: 0,
  };
  expect(deliveredReplies(message)).toEqual([
    { id: task.id, replyId: "reply-1" },
  ]);
  expect(deliveredReplies({ ...message, content: "Only a preview" })).toEqual(
    [],
  );
  expect(deliveredReplies({ ...message, customType: "unrelated" })).toEqual([]);
  expect(
    deliveredReplies({
      ...message,
      details: { replies: [{ ...ready, reply: undefined }] },
    }),
  ).toEqual([]);
  expect(
    deliveredReplies({
      ...message,
      details: { replies: [{ ...ready, outcome: "error" }] },
    }),
  ).toEqual([]);
  for (const response of ["x".repeat(20000), "line\n".repeat(110)]) {
    const clipped = replyBatch([{ ...ready, response }])!;
    expect(clipped.content).toContain("[Truncated; use sub_result");
    expect(deliveredReplies({ ...message, ...clipped })).toEqual([]);
  }
});

test("batches acknowledge each complete answer, not clipped neighbours", () => {
  const a = { ...task, reply: { id: "reply-a", delivered: false } };
  const b = {
    ...a,
    id: "task-b",
    response: "line\n".repeat(110),
    reply: { id: "reply-b", delivered: false },
  };
  const c = { ...a, id: "task-c", reply: { id: "reply-c", delivered: false } };
  const batch = replyBatch([a, b, c])!;
  const message = { ...batch, role: "custom" as const, timestamp: 0 };
  expect(batch.details.replies).toHaveLength(3);
  expect(announcedReplies(batch)).toEqual([
    { id: a.id, replyId: "reply-a" },
    { id: b.id, replyId: "reply-b" },
    { id: c.id, replyId: "reply-c" },
  ]);
  expect(deliveredReplies(message)).toEqual([
    { id: a.id, replyId: "reply-a" },
    { id: c.id, replyId: "reply-c" },
  ]);
  expect(
    deliveredReplies({ ...message, content: replyBatch([a])!.content }),
  ).toEqual([{ id: a.id, replyId: "reply-a" }]);
  expect(deliveredReplies({ ...message, content: "Only a preview" })).toEqual(
    [],
  );
  expect(announcedReplies({ ...batch, customType: "unrelated" })).toEqual([]);
  expect(announcedReplies(replyBatch([a])!)).toEqual([
    { id: a.id, replyId: "reply-a" },
  ]);
});

test("quoted reports cannot acknowledge a reply at the wrong segment position", () => {
  const b = { ...task, id: "b", reply: { id: "reply-b", delivered: false } };
  const quoted = replyBatch([b])!.content;
  const a = {
    ...task,
    id: "a",
    response: `Quoted:\n${quoted}`,
    reply: { id: "reply-a", delivered: false },
  };
  const batch = replyBatch([a, b])!;
  const message = { ...batch, role: "custom" as const, timestamp: 0 };
  expect(deliveredReplies(message)).toEqual([
    { id: "a", replyId: "reply-a" },
    { id: "b", replyId: "reply-b" },
  ]);
  expect(
    deliveredReplies({ ...message, content: replyBatch([a])!.content }),
  ).toEqual([{ id: "a", replyId: "reply-a" }]);
});

test("batches are bounded without losing the full reports or silently dropping later replies", () => {
  const tasks = Array.from({ length: 10 }, (_, n) => ({
    ...task,
    id: `task-${n}`,
    response: "line of results\n".repeat(200),
    reply: { id: `reply-${n}`, delivered: false },
  }));
  const batch = replyBatch(tasks)!;
  expect(batch.details.replies.length).toBeGreaterThan(1);
  expect(batch.details.replies.length).toBeLessThan(tasks.length);
  expect(Buffer.byteLength(batch.content, "utf8")).toBeLessThanOrEqual(24000);
  expect(batch.content.split("\n").length).toBeLessThanOrEqual(300);
  expect(batch.details.replies[0]!.response).toBe(tasks[0]!.response);
  const remaining = tasks.slice(batch.details.replies.length);
  expect(replyBatch(remaining)!.details.replies[0]!.id).toBe(remaining[0]!.id);
  expect(replyBatch([])).toBeUndefined();
});

test("complete tool returns acknowledge replies without accepting tasks", () => {
  const ready = { ...task, reply: { id: "reply-1", delivered: false } };
  const message = {
    role: "toolResult" as const,
    toolCallId: "call-1",
    toolName: "sub_result",
    content: [{ type: "text" as const, text: JSON.stringify(ready, null, 2) }],
    details: ready,
    isError: false,
    timestamp: 0,
  };
  expect(deliveredReplies(message)).toEqual([
    { id: task.id, replyId: "reply-1" },
  ]);
  expect(
    deliveredReplies({
      ...message,
      details: { ...ready, extra: "diagnostics" },
      content: [{ type: "text", text: JSON.stringify(ready) }],
    }),
  ).toEqual([{ id: task.id, replyId: "reply-1" }]);
  expect(
    deliveredReplies({
      ...message,
      content: [
        {
          type: "text",
          text: JSON.stringify({ ...ready, response: "shortened" }),
        },
      ],
    }),
  ).toEqual([]);
  expect(deliveredReplies({ ...message, isError: true })).toEqual([]);
  expect(deliveredReplies({ ...message, toolName: "unrelated" })).toEqual([]);
  expect(
    deliveredReplies({
      ...message,
      content: [{ type: "text", text: "[Truncated]" }],
    }),
  ).toEqual([]);
  const values = [
    ready,
    { ...ready, id: "second", reply: { id: "reply-2", delivered: false } },
  ];
  expect(
    deliveredReplies({
      ...message,
      toolName: "sub_control",
      details: values,
      content: [{ type: "text", text: JSON.stringify(values, null, 2) }],
    }),
  ).toEqual([
    { id: task.id, replyId: "reply-1" },
    { id: "second", replyId: "reply-2" },
  ]);
});

type NativeSession = Parameters<typeof pendingReplyBatch>[1];
function session(messages: AgentMessage[] = []): NativeSession {
  return {
    getBranch: () => [],
    buildSessionProjection: () => ({ messages }),
  } as unknown as NativeSession;
}
const ready = (id: string): TaskView => ({
  ...task,
  id,
  level: 3,
  reply: { id: `reply-${id}`, delivered: false },
});
const customMessage = (
  value: NonNullable<ReturnType<typeof replyBatch>>,
): AgentMessage => ({
  ...value,
  role: "custom",
  timestamp: 0,
});

test("live replies are selected oldest-first without a second queue or mutations", () => {
  const a = ready("a"),
    b = ready("b"),
    delivered = ready("delivered");
  delivered.reply!.delivered = true;
  const tasks: TaskView[] = [
    { ...ready("paused"), status: "paused" },
    { ...ready("queued"), status: "queued" },
    { ...ready("active"), status: "active" },
    { ...ready("failed"), outcome: "error" },
    { ...ready("stopped"), outcome: "stopped" },
    delivered,
    b,
    a,
  ];
  const before = structuredClone(tasks);
  const batch = pendingReplyBatch(tasks, session())!;
  expect(batch.details.replies.map(({ id }) => id)).toEqual(["a", "b"]);
  expect(tasks).toEqual(before);
  expect(pendingReplyBatch([], session())).toBeUndefined();
});

test("native branch announcements suppress even compacted truncated reports", () => {
  const a = { ...ready("a"), response: "line\n".repeat(110) },
    b = ready("b");
  const announcement = replyBatch([a])!;
  const history = session();
  history.getBranch = () => [
    {
      ...announcement,
      type: "custom_message",
      id: "entry",
      parentId: null,
      timestamp: new Date(0).toISOString(),
    },
  ];
  expect(deliveredReplies(customMessage(announcement))).toEqual([]);
  expect(
    pendingReplyBatch([b, a], history)!.details.replies.map(({ id }) => id),
  ).toEqual(["b"]);
  expect(a.reply!.delivered).toBe(false);
});

test("current boundary messages replace a stale projection without becoming delivery state", () => {
  const a = ready("a");
  const announcement = customMessage(replyBatch([a])!);
  const history = session([announcement]);
  expect(pendingReplyBatch([a], history)).toBeUndefined();
  // A preview boundary may project another branch/compaction than the saved one.
  expect(pendingReplyBatch([a], history, [])!.details.replies[0]!.id).toBe("a");
  expect(pendingReplyBatch([a], session(), [announcement])).toBeUndefined();
  expect(a.reply!.delivered).toBe(false);
  // An uncommitted proposal is not a second delivery ledger.
  expect(pendingReplyBatch([a], session())).toBeDefined();
});

test("complete tool returns suppress announcements; previews and old replies do not", () => {
  const a = ready("a");
  const result: Extract<AgentMessage, { role: "toolResult" }> = {
    role: "toolResult",
    toolName: "sub_result",
    toolCallId: "call",
    content: [{ type: "text", text: JSON.stringify(a) }],
    details: JSON.parse(JSON.stringify(a)),
    isError: false,
    timestamp: 0,
  };
  expect(pendingReplyBatch([a], session([result]))).toBeUndefined();
  expect(a.reply!.delivered).toBe(false);
  expect(
    pendingReplyBatch(
      [a],
      session([
        {
          ...result,
          content: [{ type: "text", text: "[Truncated]" }],
        },
      ]),
    ),
  ).toBeDefined();
  const successor = { ...a, reply: { id: "next-reply", delivered: false } };
  expect(
    pendingReplyBatch(
      [successor],
      session([result, customMessage(replyBatch([a])!)]),
    )!.details.replies[0]!.reply!.id,
  ).toBe("next-reply");
});

test("overflow is recovered from current tasks after native commit, not a retained batch", () => {
  const tasks = Array.from({ length: 10 }, (_, i) => ({
    ...ready(String(i)),
    response: "line of results\n".repeat(200),
  })).reverse();
  const first = pendingReplyBatch(tasks, session())!;
  const saved: AgentMessage = { ...first, role: "custom", timestamp: 0 };
  const second = pendingReplyBatch(tasks, session([saved]))!;
  const announced = new Set(first.details.replies.map(({ id }) => id));
  expect(second.details.replies.length).toBeGreaterThan(0);
  expect(second.details.replies.every(({ id }) => !announced.has(id))).toBe(
    true,
  );
  // Accepted tasks need no tombstone; they simply stop being inbox candidates.
  expect(pendingReplyBatch([], session([saved]))).toBeUndefined();
});
