import { afterEach, beforeEach, expect, test } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { TaskView } from "../src/coordinator.ts";
import {
  replyBatch as batch,
  toolResult as resultOf,
  readReport,
} from "../src/reports.ts";
import { ReportStore } from "../src/report-store.ts";
let store = new ReportStore();
afterEach(() => {
  store.dispose();
  store = new ReportStore();
});
const replyBatch = (tasks: TaskView[]) => batch(tasks, store);
const toolResult = (value: TaskView | TaskView[]) => resultOf(value, store);
import { renderReplies, taskToolRenderers } from "../src/views.ts";

const task: TaskView = {
  id: "0123456789abcdef",
  level: 3,
  description: "Review changes",
  execution: { provider: "p", model: "m", thinking: "off" },
  sessionFile: "native.jsonl",
  status: "ready",
  activity: "",
  turns: 2,
  toolUses: 5,
  tokens: 300,
  elapsedMs: 1200,
  response: "Question?\nImportant detail.",
  unsent: 0,
  delivered: false,
};
const failed: TaskView = {
  ...task,
  id: "fedcba9876543210",
  description: "Deploy",
  status: "failed",
  error: "Worker exited before delivery",
  response: "Partial investigation",
  unsent: 1,
};
let errorMark = "!";
beforeEach(() => {
  errorMark = "!";
});
const theme = {
  bold: (text: string) => text,
  fg: (color: string, text: string) =>
    color === "error" ? errorMark + text : text,
} as never;
type Tool = Parameters<typeof taskToolRenderers>[0];
const call = (tool: Tool, args: object, expanded = false, width = 80) =>
  taskToolRenderers(tool).renderCall!(args as never, theme, {
    expanded,
    outputPad: 1,
  } as never).render(width);
const result = (
  value: ReturnType<typeof toolResult> | string,
  { expanded = false, isError = false, width = 80, outputPad = 1 } = {},
) =>
  taskToolRenderers("sub_result").renderResult!(
    (typeof value === "string"
      ? { content: [{ type: "text", text: value }], details: {} }
      : value) as never,
    { expanded, isPartial: false },
    theme,
    { isError, outputPad } as never,
  ).render(width);
const reply = (
  batch: { content: unknown; details?: unknown },
  expanded = false,
  width = 80,
  outputPad = 1,
) =>
  renderReplies(
    {
      role: "custom",
      customType: "pi-sub:response",
      timestamp: 0,
      ...batch,
    } as never,
    { expanded, outputPad } as never,
    theme,
  )!.render(width);

test("a request row names the action and the task; expanding it shows the instruction", () => {
  const rows: [Tool, object, string][] = [
    [
      "sub_task",
      { level: 3, prompt: "Inspect\nauth", description: "Review auth" },
      "Delegate · Review auth · lvl 3",
    ],
    [
      "sub_task",
      { level: 2, prompt: "Inspect\nauth" },
      "Delegate · Inspect auth · lvl 2",
    ],
    [
      "sub_message",
      { id: task.id, message: "Use production." },
      "Message · 01234567",
    ],
    ["sub_result", { id: task.id }, "Read · 01234567"],
    [
      "sub_result",
      { report: "report-abc", offset: 100 },
      "Read report · report-abc",
    ],
    ["sub_result", { id: task.id, wait: true }, "Wait for · 01234567"],
    [
      "sub_result",
      { id: task.id, wait: true, finish: true },
      "Accept · 01234567",
    ],
    ["sub_control", { action: "pause" }, "Pause · all tasks"],
    ["sub_control", { action: "stop", id: task.id }, "Stop · 01234567"],
  ];
  for (const [tool, args, row] of rows)
    expect(call(tool, args)).toEqual([` ${row} `]);
  expect(
    call("sub_message", { id: task.id, message: "Use production." }, true).join(
      "\n",
    ),
  ).toContain("Use production.");
});

test("a result row names the confirmed state, the cause before the reply, and kept instructions", () => {
  const states: [Partial<TaskView>, string[]][] = [
    [{ status: "active", response: "" }, ["Active · Review changes"]],
    [{ status: "queued", unsent: 1 }, ["Queued · Review changes"]],
    [
      { status: "paused", unsent: 1, response: "" },
      ["Paused · Review changes", "Unsent instructions are kept."],
    ],
    [{}, ["Response · Review changes", "Question? Important detail."]],
    [
      { status: "accepted" },
      ["Accepted · Review changes", "Question? Important detail."],
    ],
    [
      { status: "stopped", error: "exited 1", unsent: 1 },
      [
        "Stopped · Review changes",
        "!exited 1",
        "Question? Important detail.",
        "Unsent instructions are kept.",
      ],
    ],
  ];
  for (const [fields, rows] of states)
    expect(
      result(toolResult({ ...task, ...fields })).map((row) => row.trim()),
    ).toEqual(rows);
  // Several tasks: one state each, causes included, replies left to expansion.
  expect(result(toolResult([task, failed])).map((row) => row.trim())).toEqual([
    "Response · Review changes",
    "Failed · Deploy",
    "!Worker exited before delivery",
    "Unsent instructions are kept.",
  ]);
  expect(result(toolResult([]))).toEqual([" No tasks "]);
  expect(result("Unknown task: x", { isError: true })).toEqual([
    " !Unknown task: x ",
  ]);
});

test("expanding a result shows the whole reply and where the task ran", () => {
  const text = result(toolResult([task, failed]), { expanded: true }).join(
    "\n",
  );
  for (const part of [
    "Response · Task: Review changes",
    `ID: ${task.id}`,
    "Level 3 · p/m:off",
    "Session: native.jsonl",
    "1200 ms · 2 turns · 5 tools · 300 tokens",
    "Question?",
    "Important detail.",
    "Failed · Task: Deploy",
    "Worker exited before delivery",
    "Partial investigation",
  ])
    expect(text).toContain(part);
});

test("replies that arrived on their own render like results and expand to what the model read", () => {
  const batch = replyBatch([task, failed]);
  expect(reply(batch).map((row) => row.trim())).toEqual([
    "Response · Review changes",
    "Question? Important detail.",
    "Failed · Deploy",
    "!Worker exited before delivery",
    "Partial investigation",
    "Unsent instructions are kept.",
  ]);
  const expanded = reply(batch, true).join("\n");
  expect(expanded).toContain(`Subagent ${failed.id} (Deploy) failed`);
  expect(expanded).toContain("Last response:");
  expect(expanded).toContain("Session: native.jsonl");
});

test("a page displays its content without claiming the task is empty", () => {
  const ref = store.put(
    "Finding: terminal control sequences must be sanitized",
  );
  const page = readReport(store, ref.id, 0, 18);
  for (const expanded of [false, true]) {
    const text = taskToolRenderers("sub_result").renderResult!(
      page as never,
      { expanded, isPartial: false },
      theme,
      { outputPad: 1 } as never,
    )
      .render(100)
      .join("\n");
    expect(text).toContain(ref.id);
    expect(text).not.toContain("No tasks");
    if (expanded) expect(text).toContain("Finding:");
  }
});

test("rows fit any width, sanitize what children wrote and survive malformed history", () => {
  const unsafe =
    "\x1b[31mVisible\x1b[0m\x1b]8;;https://evil.test\x07link\x1b]8;;\x07\x07\b";
  const hostile = {
    ...failed,
    description: unsafe,
    response: unsafe,
    error: unsafe,
  };
  errorMark = ""; // Widths are measured without the test's marker.
  for (const expanded of [false, true])
    for (const outputPad of [0, 1, 4])
      for (const width of [0, 1, 2, 8, 20, 80]) {
        const lines = [
          ...result(toolResult([task, hostile]), {
            expanded,
            width,
            outputPad,
          }),
          ...reply(replyBatch([task, hostile]), expanded, width, outputPad),
          ...call("sub_task", { level: 3, prompt: unsafe }, expanded, width),
        ];
        for (const line of lines) {
          expect(visibleWidth(line)).toBeLessThanOrEqual(width);
          for (const hostile of ["\x1b[31m", "\x1b]8", "\x07", "\b"])
            expect(line).not.toContain(hostile);
          expect(line).not.toContain("evil.test");
        }
      }
  for (const details of [undefined, null, 42, [], { tasks: [null, 42, {}] }])
    for (const expanded of [false, true])
      expect(
        reply(
          { content: [{ type: "text", text: "Kept text" }], details },
          expanded,
        ).join("\n"),
      ).toContain("Kept text");
});
