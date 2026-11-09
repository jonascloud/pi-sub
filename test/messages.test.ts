import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { TaskView, TaskResult } from "../src/coordinator.ts";
import {
  SUBAGENT_GUIDANCE,
  renderReply,
  renderFailures,
  renderStopped,
} from "../src/messages.ts";
import { replyBatch as buildBatch } from "../src/replies.ts";

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pi-sub-messages-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});
const replyBatch = (tasks: TaskView[]) => buildBatch(tasks, cwd);
import { STRENGTH_GUIDANCE } from "../src/models.ts";

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
const theme = {
  bold: (s: string) => s,
  fg: (_color: string, s: string) => s,
} as unknown as Parameters<typeof renderReply>[2];
function render(expanded: boolean, width = 80) {
  const reply = replyBatch([task])!;
  return renderReply(
    {
      ...reply,
      role: "custom",
      timestamp: 0,
    },
    { expanded, outputPad: 1 } as Parameters<typeof renderReply>[1],
    theme,
  )!.render(width);
}

test("batch previews and expansions render every reply without duplicating answer JSON", () => {
  const batch = replyBatch([
    task,
    {
      ...task,
      id: "second",
      description: "Other review",
      response: "Other answer",
    },
  ])!;
  const message = { ...batch, role: "custom" as const, timestamp: 0 };
  for (const expanded of [false, true]) {
    const component = renderReply(
      message,
      { expanded, outputPad: 1 } as Parameters<typeof renderReply>[1],
      theme,
    )!;
    const rendered = component.render(120).join("\n");
    expect(rendered).toContain("Review changes");
    expect(rendered).toContain("Other review");
    expect(rendered).toContain("Other answer");
    expect(rendered).not.toContain('"response":');
    if (expanded) expect(rendered).toContain("Important detail.");
    else expect(component.render(120)).toHaveLength(4);
    for (const width of [0, 1, 20, 80])
      for (const line of component.render(width))
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  }
});

test("TUI notifications are two-line previews with expandable complete delivery", () => {
  const collapsed = render(false);
  expect(collapsed).toHaveLength(2);
  expect(collapsed.join("\n")).toContain("Review changes · response");
  expect(collapsed.join("\n")).not.toContain("task-1");
  expect(collapsed.join("\n")).toContain("Question?");
  expect(collapsed.join("\n")).not.toContain("Important detail");
  expect(render(true).join("\n")).toContain("Important detail.");
  for (const width of [0, 1, 2, 20, 80])
    for (const line of render(false, width))
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
});

test("operating guidance avoids routine acknowledgements and duplicate workload anchors", () => {
  expect(SUBAGENT_GUIDANCE).toContain("Reports need no acknowledgement");
  expect(SUBAGENT_GUIDANCE.split(STRENGTH_GUIDANCE)).toHaveLength(2);
});

function draw(
  renderer: typeof renderReply,
  content: unknown,
  details?: unknown,
  expanded = false,
  width = 120,
  outputPad = 1,
) {
  return renderer(
    {
      role: "custom",
      customType: "test",
      content,
      details,
      timestamp: 0,
    } as Parameters<typeof renderReply>[0],
    { expanded, outputPad } as Parameters<typeof renderReply>[1],
    theme,
  )!.render(width);
}

const failure: TaskResult = {
  ...task,
  outcome: "error",
  error: "Worker exited before delivery",
  response: "Partial investigation\nSource: https://example.test/report",
  pendingInput: ["Unsent correction"],
};

test("failed tasks expose every cause without expanding partial work or metadata", () => {
  const failures = [
    failure,
    {
      ...failure,
      id: "task-2",
      description: "Verify",
      error: "Permission denied",
    },
  ];
  const content = JSON.stringify(failures);
  const collapsed = draw(renderFailures, content, failures).join("\n");
  expect(collapsed).toContain("Failed · Review changes");
  expect(collapsed).not.toContain("task-1");
  expect(collapsed).toContain("Worker exited before delivery");
  expect(collapsed).toContain("Failed · Verify");
  expect(collapsed).toContain("Permission denied");
  expect(collapsed).not.toContain("Partial investigation");
  expect(collapsed).not.toContain("pendingInput");
  const expanded = draw(renderFailures, content, failures, true).join("\n");
  for (const text of [
    "Partial investigation",
    "https://example.test/report",
    "Unsent correction",
    "native.jsonl",
    '"outcome": "error"',
  ])
    expect(expanded).toContain(text);
  expect(draw(renderFailures, "failure", [{ id: "x" }]).join("\n")).toContain(
    "Execution failed",
  );
});

test("failure notices expose both execution and report-storage errors", () => {
  const details = { report: [failure], reportError: "ENOSPC: no space left" };
  const text = draw(renderFailures, "Report unavailable", details).join("\n");
  expect(text).toContain("Worker exited before delivery");
  expect(text).toContain("Report unavailable: ENOSPC");
  expect(
    draw(renderFailures, "Report unavailable", details, true).join("\n"),
  ).toContain("Unsent correction");
});

test("stop acknowledgements summarize task identities", () => {
  const { error: _error, ...data } = failure;
  const stopped = [
    { ...data, outcome: "stopped" },
    { ...data, id: "task-2", description: "Verify", outcome: "stopped" },
  ];
  const content = JSON.stringify(stopped, null, 2);
  expect(draw(renderStopped, content, stopped).join("\n").trim()).toBe(
    "Stopped · 2 tasks",
  );
  expect(draw(renderStopped, content, stopped, true).join("\n")).toContain(
    "Partial investigation",
  );
  expect(draw(renderStopped, "[]", []).join("\n")).not.toContain("[]");
});

test("stop acknowledgements distinguish a completed stop from report publication failure", () => {
  const report = [{ ...failure, outcome: "stopped", error: undefined }];
  const details = { report, reportError: "ENOSPC: no space left" };
  const collapsed = draw(renderStopped, "Publication failed", details).join(
    "\n",
  );
  expect(collapsed).toContain("Stopped · Review changes");
  expect(collapsed).toContain("Report unavailable: ENOSPC");
  const expanded = draw(
    renderStopped,
    "Publication failed",
    details,
    true,
  ).join("\n");
  expect(expanded).toContain("Partial investigation");
  expect(expanded).toContain("ENOSPC");
});

test("stopping preserves failed and already accepted outcomes rather than claiming every task stopped", () => {
  const accepted = {
    ...failure,
    outcome: "reply",
    error: undefined,
    description: "Accepted work",
  };
  const mixed = draw(renderStopped, JSON.stringify([accepted, failure]), [
    accepted,
    failure,
  ]).join("\n");
  expect(mixed).toContain("Stop results · 2 tasks");
  expect(mixed).toContain("Already accepted · Accepted work");
  expect(mixed).toContain("Failed · Review changes");
  expect(mixed).toContain("Worker exited before delivery");
  expect(mixed).not.toContain("Stopped · 2 tasks");
});

test("expanded replies recover complete source payloads without repeating them", () => {
  const response = "x".repeat(60000) + "\nEND_OF_FULL_REPLY";
  const reply = replyBatch([{ ...task, response }])!;
  expect(reply.content).not.toContain("END_OF_FULL_REPLY");
  const expanded = draw(
    renderReply,
    reply.content,
    reply.details,
    true,
    200,
  ).join("\n");
  expect(expanded).toContain("END_OF_FULL_REPLY");
  expect(expanded.match(/END_OF_FULL_REPLY/g)).toHaveLength(1);
  expect(expanded).toContain("native.jsonl");
});

test("renderers handle content arrays and malformed metadata without mutating payloads", () => {
  const content = [
    { type: "text", text: "Subagent task-1 (Review changes)" },
    { type: "image", data: "not text", mimeType: "image/png" },
    null,
    { type: "text", text: "Useful answer\nFull detail" },
    { type: "text", text: 42 },
  ];
  const malformed = [
    undefined,
    null,
    42,
    "bad",
    [],
    [null, 42, []],
    { id: [], description: {}, preview: 4 },
  ];
  for (const renderer of [renderReply, renderFailures, renderStopped])
    for (const details of malformed) {
      const before = JSON.stringify({ content, details });
      for (const expanded of [false, true])
        expect(() => draw(renderer, content, details, expanded)).not.toThrow();
      expect(JSON.stringify({ content, details })).toBe(before);
    }
  expect(draw(renderReply, content, undefined, true).join("\n")).toContain(
    "Full detail",
  );
  // A malformed element must not suppress an otherwise usable task report.
  expect(
    draw(renderFailures, "failure", [null, [], failure]).join("\n"),
  ).toContain(failure.error);
});

test("all views respect width and output padding, collapsed and expanded", () => {
  const cases: [typeof renderReply, string, unknown][] = [
    [
      renderReply,
      "Subagent task-1\n漢字 answer\nFull delivery",
      {
        replies: [
          { ...task, description: "Review 漢字", preview: "漢字 answer" },
        ],
      },
    ],
    [renderFailures, JSON.stringify([failure]), [failure]],
    [renderStopped, JSON.stringify([failure]), [failure]],
  ];
  for (const [renderer, content, details] of cases)
    for (const expanded of [false, true])
      for (const outputPad of [0, 1, 4])
        for (const width of [0, 1, 2, 3, 8, 20, 80])
          for (const line of draw(
            renderer,
            content,
            details,
            expanded,
            width,
            outputPad,
          ))
            expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  expect(
    draw(
      renderReply,
      "Header\nAnswer",
      replyBatch([task])!.details,
      false,
      20,
      2,
    )[0],
  ).toMatch(/^ {2}\S.* {2}$/);
  // A long identity cannot consume the separate, immediately visible cause row.
  expect(
    draw(
      renderFailures,
      "failure",
      [{ ...failure, description: "x".repeat(1000), error: "Denied" }],
      false,
      12,
    ).join("\n"),
  ).toContain("Denied");
});

test("terminal commands and controls are sanitized in previews and full delivery", () => {
  const unsafe =
    "\x1b[31mVisible\x1b[0m\x1b]8;;https://evil.test\x07link\x1b]8;;\x07\x1b_Gpayload\x1b\\\x07\b\r";
  for (const renderer of [renderReply, renderFailures, renderStopped]) {
    const details =
      renderer === renderFailures || renderer === renderStopped
        ? [{ ...failure, description: unsafe, error: unsafe }]
        : {
            replies: [
              {
                ...task,
                description: unsafe,
                response: unsafe,
                preview: unsafe,
              },
            ],
          };
    for (const expanded of [false, true]) {
      const text = draw(renderer, unsafe, details, expanded, 200).join("\n");
      expect(text).toContain("Visible");
      expect(text).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
      expect(text).not.toContain("evil.test");
      expect(text).not.toContain("payload");
    }
  }
});

test("preview metadata stays bounded while expansion preserves its full payload", () => {
  const long = "x".repeat(20000) + "END_OF_PAYLOAD";
  const details = { replies: [{ ...task, description: long, preview: long }] };
  const before = JSON.stringify(details);
  expect(
    draw(renderReply, "Full delivery", details, false, 10000).join("\n").length,
  ).toBeLessThan(500);
  expect(
    draw(renderReply, "Full delivery", details, true, 1000).join("\n"),
  ).toContain("END_OF_PAYLOAD");
  expect(JSON.stringify(details)).toBe(before);
});
