import { expect, test } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { TaskView, TaskResult } from "../src/coordinator.ts";
import {
  SUBAGENT_GUIDANCE,
  failureSummary,
  replyNotification,
  renderReply,
  renderFailures,
  renderStopped,
  renderModels,
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
  expect(reply.details).toMatchObject({ ...task, preview: "Question?" });
  const long = replyNotification({ ...task, response: "x".repeat(20000) });
  expect(long.details.preview.length).toBeLessThan(200);
  expect(long.content.length).toBeLessThan(8100);
});

test("TUI notifications are two-line previews with expandable complete delivery", () => {
  const collapsed = render(false);
  expect(collapsed).toHaveLength(2);
  expect(collapsed.join("\n")).toContain("Review changes · response");
  expect(collapsed.join("\n")).not.toContain("task-1");
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
  const content = failureSummary(failures);
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
  // Old textual reports need no metadata migration and still expose their cause.
  expect(draw(renderFailures, content).join("\n")).toContain(
    "Permission denied",
  );
  expect(draw(renderFailures, "failure", [{ id: "x" }]).join("\n")).toContain(
    "Execution failed",
  );
});

test("stop acknowledgements summarize task identities, including legacy JSON-only messages", () => {
  const { error: _error, ...data } = failure;
  const stopped = [
    { ...data, outcome: "stopped" },
    { ...data, id: "task-2", description: "Verify", outcome: "stopped" },
  ];
  const content = JSON.stringify(stopped, null, 2);
  for (const details of [stopped, undefined]) {
    const collapsed = draw(renderStopped, content, details).join("\n");
    expect(collapsed).toContain("Stopped · 2 tasks");
    expect(collapsed).not.toContain("task-1");
    expect(collapsed).not.toContain("task-2");
    expect(collapsed.trim()).toBe("Stopped · 2 tasks");
    expect(collapsed).not.toContain("response");
    expect(collapsed).not.toContain("{");
    expect(draw(renderStopped, content, details, true).join("\n")).toContain(
      "Partial investigation",
    );
  }
  expect(draw(renderStopped, "[]", []).join("\n")).not.toContain("[]");
  expect(draw(renderStopped, "[broken JSON").join("\n")).toContain(
    "Stopped tasks",
  );
});

test("model proposals preview rationale and unsaved state, retaining full research on expansion", () => {
  const comparison =
    "# Comparison\nUse the smaller model for checks; keep the stronger rung for design.\n\nSources:\nhttps://example.test/models";
  const proposal = {
    ladder: { "6": { model: "p/m:off", cost: 0.1 } },
    comparison,
  };
  const details = {
    task: { ...task, response: JSON.stringify(proposal) },
    proposal,
  };
  const content = `${comparison}\n\nDRAFT (not saved):\n${JSON.stringify(proposal.ladder, null, 2)}`;
  for (const metadata of [details, undefined]) {
    const collapsed = draw(renderModels, content, metadata).join("\n");
    expect(collapsed).toContain("DRAFT — not saved");
    expect(collapsed).toContain("Use the smaller model for checks");
    expect(collapsed).not.toContain('"6"');
    expect(collapsed).not.toContain("p/m:off");
    const expanded = draw(renderModels, content, metadata, true, 180).join(
      "\n",
    );
    expect(expanded).toContain("AA reference USD/task");
    expect(expanded).toContain("https://example.test/models");
    expect(expanded).toContain('"6"');
    expect(expanded).toContain("p/m:off");
  }
  expect(draw(renderModels, content, details).join("\n")).toContain(
    "Review changes",
  );
  const expanded = draw(renderModels, content, details, true).join("\n");
  expect(expanded).toContain("native.jsonl");
  expect(expanded).toContain('"task"');
  expect(expanded.match(/https:\/\/example.test\/models/g)).toHaveLength(1); // Do not repeat the proposal inside task metadata.
});

test("model previews prefer rationale over headings and embedded JSON", () => {
  for (const comparison of [
    '# Comparison\n```json\n{"6":{"model":"raw/ladder"}}\n```\nSmaller model is sufficient for checks.',
    '{\n"6": {"model":"raw/ladder"}\n}\nSmaller model is sufficient for checks.',
    "# Smaller model is sufficient for checks.",
  ]) {
    const details = { proposal: { ladder: {}, comparison } };
    const collapsed = draw(renderModels, comparison, details).join("\n");
    expect(collapsed).toContain("Smaller model is sufficient");
    expect(collapsed).not.toContain("raw/ladder");
  }
  const malformed = draw(renderModels, '{"ladder":[]}', {
    proposal: null,
  }).join("\n");
  expect(malformed).not.toContain("{");
  expect(malformed).not.toContain("DRAFT");
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

test("expanded replies and proposals recover complete source payloads without repeating them", () => {
  const response = "x".repeat(20000) + "\nEND_OF_FULL_REPLY";
  const reply = replyNotification({ ...task, response });
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
  const comparison = "x".repeat(30000) + "\nEND_OF_FULL_COMPARISON";
  const metadata = {
    task: { ...task, response: JSON.stringify({ ladder: {}, comparison }) },
    proposal: { ladder: {}, comparison },
  };
  const before = JSON.stringify(metadata);
  const proposal = draw(
    renderModels,
    "clipped delivery",
    metadata,
    true,
    200,
  ).join("\n");
  expect(proposal).toContain("END_OF_FULL_COMPARISON");
  expect(proposal.match(/END_OF_FULL_COMPARISON/g)).toHaveLength(1);
  expect(JSON.stringify(metadata)).toBe(before);
  expect(draw(renderModels, "clipped delivery", metadata).join("\n")).toContain(
    "delegation disabled if accepted",
  );
});

test("model status wording is not promoted to a draft or a saved success", () => {
  for (const status of [
    "Model setup requested",
    "Model setup cancelled",
    "Model setup failed: permission denied",
    "Saved model ladder to /tmp/ladder.json",
  ])
    expect(draw(renderModels, status).map((line) => line.trim())).toEqual([
      status,
    ]);
  expect(
    draw(renderModels, "Model setup failed: bad proposal", {
      proposal: [],
    }).join("\n"),
  ).not.toContain("DRAFT");
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
    { proposal: { ladder: [], comparison: {} } },
  ];
  for (const renderer of [
    renderReply,
    renderFailures,
    renderStopped,
    renderModels,
  ])
    for (const details of malformed) {
      const before = JSON.stringify({ content, details });
      for (const expanded of [false, true])
        expect(() => draw(renderer, content, details, expanded)).not.toThrow();
      expect(JSON.stringify({ content, details })).toBe(before);
    }
  const reply = draw(renderReply, content).join("\n");
  expect(reply).toContain("Review changes");
  expect(reply).not.toContain("task-1");
  expect(reply).toContain("Useful answer");
  expect(reply).not.toContain("not text");
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
      { id: "task-1", description: "Review 漢字", preview: "漢字 answer" },
    ],
    [renderFailures, failureSummary([failure]), [failure]],
    [renderStopped, JSON.stringify([failure]), [failure]],
    [
      renderModels,
      "Rationale",
      { task, proposal: { ladder: {}, comparison: "漢字 rationale" } },
    ],
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
    draw(renderReply, "Header\nAnswer", undefined, false, 20, 2)[0],
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
  for (const renderer of [
    renderReply,
    renderFailures,
    renderStopped,
    renderModels,
  ]) {
    const details =
      renderer === renderFailures || renderer === renderStopped
        ? [{ ...failure, description: unsafe, error: unsafe }]
        : renderer === renderModels
          ? {
              task: { ...task, description: unsafe },
              proposal: { ladder: {}, comparison: unsafe },
            }
          : { id: task.id, description: unsafe, preview: unsafe };
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
  const details = { id: "task-1", description: long, preview: long };
  const before = JSON.stringify(details);
  expect(
    draw(renderReply, "Full delivery", details, false, 10000).join("\n").length,
  ).toBeLessThan(500);
  expect(
    draw(renderReply, "Full delivery", details, true, 1000).join("\n"),
  ).toContain("END_OF_PAYLOAD");
  expect(JSON.stringify(details)).toBe(before);
});
