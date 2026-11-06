import { expect, test } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { TaskView, TaskResult } from "../src/coordinator.ts";
import {
  SUBAGENT_GUIDANCE,
  failureSummary,
  replyNotification,
  renderReply,
  routingSummary,
} from "../src/messages.ts";

const task: TaskView = {
  id: "task-1",
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
const theme = {
  bold: (s: string) => s,
  fg: (_color: string, s: string) => s,
} as unknown as Parameters<typeof renderReply>[2];
function render(expanded: boolean, width = 80, details = true) {
  const reply = replyNotification(task);
  return renderReply(
    {
      ...reply,
      details: details ? reply.details : undefined,
      role: "custom",
      timestamp: 0,
    },
    { expanded, outputPad: 1 } as Parameters<typeof renderReply>[1],
    theme,
  )!.render(width);
}

test("replies carry identity and new information, not repeated operating instructions", () => {
  const reply = replyNotification(task);
  expect(reply.content).toBe(
    "Subagent task-1 (Review changes)\nQuestion?\nImportant detail.",
  );
  expect(reply.content).not.toContain("sub_message");
  expect(reply.content).not.toContain("sub_result");
  expect(reply.content).not.toContain("This may be a question");
  expect(reply.details).toEqual({
    id: "task-1",
    description: "Review changes",
    preview: "Question?",
  });
  const long = replyNotification({ ...task, response: "x".repeat(20000) });
  expect(long.details.preview.length).toBeLessThan(200);
  expect(long.content.length).toBeLessThan(8100);
});

test("TUI notifications are two-line previews with expandable complete delivery", () => {
  const collapsed = render(false);
  expect(collapsed).toHaveLength(2);
  expect(collapsed.join("\n")).toContain("Review changes · response");
  expect(collapsed.join("\n")).toContain("Question?");
  expect(collapsed.join("\n")).not.toContain("Important detail");
  expect(render(true).join("\n")).toContain("Important detail.");
  expect(render(false, 80, false)).toHaveLength(2); // Previously saved messages need no metadata migration.
  for (const width of [0, 1, 2, 20, 80])
    for (const line of render(false, width))
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
});

test("routing context groups identical outcomes instead of repeating every level", () => {
  const ladder = {
    "6": { model: "p/m:off", cost: 0.1 },
    "9": { model: "p/m:high", cost: null },
  };
  const text = routingSummary(ladder, [
    { provider: "p", model: "m", thinking: ["off", "high"] },
  ]);
  expect(text.split("\n")).toEqual([
    "1–6: p/m:off · rung 6 · $0.1",
    "7–9: p/m:high · rung 9 · unknown",
    "10: unavailable",
  ]);
  expect(routingSummary(ladder, [])).toBe("1–10: unavailable");
});

test("failure reports retain partial work and pending input without a cleanup tutorial", () => {
  const { status: _status, activity: _activity, ...data } = task;
  const report: TaskResult = {
    ...data,
    outcome: "error",
    error: "Worker exited",
    pendingInput: ["Unsent correction"],
  };
  const text = failureSummary([report]);
  expect(text).toContain("Collected failures:");
  expect(text).toContain("Review changes (task-1): Worker exited");
  expect(text).toContain("Partial: Question?");
  expect(text).toContain("Pending: Unsent correction");
  expect(text).not.toContain("cleanup tool");
  expect(SUBAGENT_GUIDANCE).toContain(
    "Failed work is closed and reported automatically",
  );
  expect(SUBAGENT_GUIDANCE).toContain("rather than acknowledging");
});
