import { beforeAll, expect, test, vi } from "vitest";
import {
  initTheme,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  visibleWidth,
  type TUI,
} from "@earendil-works/pi-tui";
import type { TaskView, TaskResult } from "../src/coordinator.ts";
import { taskToolRenderers } from "../src/tool-view.ts";
import { digest, reportResult } from "../src/reports.ts";
import { Workspace } from "../src/workspace.ts";

beforeAll(() => initTheme("dark", false));
const task = (overrides: Partial<TaskView> = {}): TaskView => ({
  id: "task-123456789",
  description: "API review",
  level: 1,
  execution: { provider: "test", model: "strong", thinking: "high" },
  sessionFile: "/native/task.jsonl",
  turns: 1,
  toolUses: 0,
  tokens: 2857,
  elapsedMs: 6028,
  response: "",
  status: "active",
  activity: "thk",
  ...overrides,
});
function receipt(overrides: Partial<TaskResult> = {}): TaskResult {
  const {
    status: _status,
    activity: _activity,
    operation: _operation,
    ...data
  } = task();
  return { ...data, outcome: "reply", response: "Full reply.", ...overrides };
}
function row(
  tool: Parameters<typeof taskToolRenderers>[0],
  args: Record<string, unknown>,
  padding = 1,
) {
  const component = new ToolExecutionComponent(
    tool,
    "call",
    args,
    { outputPad: padding },
    taskToolRenderers(tool),
    { requestRender: vi.fn() } as unknown as TUI,
    "/project",
  );
  component.setArgsComplete();
  component.markExecutionStarted();
  return component;
}
function result(
  component: ToolExecutionComponent,
  details: unknown,
  error = false,
  partial = false,
  text?: string,
) {
  const value = {
    content: [{ type: "text", text: text ?? JSON.stringify(details) }],
    details,
    isError: error,
  };
  const before = JSON.stringify(value);
  component.updateResult(value, partial);
  expect(JSON.stringify(value)).toBe(before);
}
const lines = (component: ToolExecutionComponent, width = 100) =>
  component.render(width).map(stripTerminalSequences);
const text = (component: ToolExecutionComponent, width = 100) =>
  lines(component, width).join("\n");

test.each([false, true])(
  "persisted compact details render without a live workspace (file=%s)",
  (large) => {
    const workspace = new Workspace();
    try {
      const value = receipt({
        response: "x".repeat(large ? 60000 : 500) + "\nEND_OF_ANSWER",
        pendingInput: ["Unsent instruction"],
      });
      const saved = JSON.parse(JSON.stringify(reportResult(value, workspace)));
      workspace.dispose();
      expect(JSON.stringify(saved.details)).not.toContain("END_OF_ANSWER");
      expect(JSON.stringify(saved.details)).not.toContain("Unsent instruction");
      const component = row("sub_result", { id: value.id, finish: true });
      result(component, saved.details, false, false, saved.content[0].text);
      expect(text(component)).toContain("Accepted");
      component.setExpanded(true);
      const expanded = text(component, 300);
      expect(expanded).toContain("Execution: test/strong:high");
      if (large) {
        expect(expanded).toContain(saved.details.handoff.file);
        expect(expanded).toContain("Temporary report");
        expect(expanded).not.toContain("END_OF_ANSWER");
      } else {
        expect(expanded).toContain("END_OF_ANSWER");
        expect(expanded).toContain("Unsent instruction");
      }
    } finally {
      workspace.dispose();
    }
  },
);

test("native tool rows replace the pending header with compact delegation/queue outcomes", () => {
  const args = {
    level: 1,
    prompt: "Full confidential briefing",
    description: "API review",
  };
  const component = row("sub_task", args);
  expect(text(component)).toContain("Delegate · API review · lvl 1");
  result(component, task());
  expect(lines(component).filter((line) => line.trim())).toHaveLength(1);
  expect(text(component)).toContain("Delegated · API review · lvl 1");
  expect(text(component)).not.toContain("confidential");
  expect(text(component)).not.toContain("strong");
  component.setExpanded(true);
  expect(text(component)).toContain("Full confidential briefing");
  expect(text(component)).toContain("Required level: 1");
  expect(text(component)).toContain("Execution: test/strong:high");
  expect(text(component)).toContain("ID: task-123456789");
  expect(text(component)).toContain("Session: /native/task.jsonl");
  component.setExpanded(false);
  expect(lines(component).filter((line) => line.trim())).toHaveLength(1);
  result(component, task({ status: "queued" }));
  expect(text(component)).toContain("Queued · API review · lvl 1");
});

test("instruction updates preview the correction, not a previous answer", () => {
  const component = row("sub_message", {
    id: "task-123456789",
    message: "Target API v2.\nKeep the interface.",
  });
  expect(text(component)).toContain("Update instruction");
  result(component, task({ response: "STALE ANSWER" }));
  expect(text(component)).toContain("Instruction updated · API review");
  expect(text(component)).toContain("Target API v2.");
  expect(text(component)).not.toContain("STALE ANSWER");
});

test("reading is distinct from acceptance and active snapshots do not advertise stale responses", () => {
  const component = row("sub_result", { id: "task-123456789" });
  result(
    component,
    task({ status: "ready", outcome: "reply", response: "Which API version?" }),
  );
  expect(text(component)).toContain("Response · API review");
  expect(text(component)).toContain("Which API version?");
  expect(text(component)).not.toContain("Done");
  result(component, task({ response: "STALE ANSWER" }));
  expect(text(component)).toContain("Active · API review");
  expect(text(component)).not.toContain("STALE ANSWER");
  result(component, task({ status: "paused", response: "STALE ANSWER" }));
  expect(text(component)).toContain("Paused · API review");
  expect(text(component)).not.toContain("STALE ANSWER");
});

test.each([false, true])(
  "the native wait timeout is ordinary feedback (finish=%s)",
  (finish) => {
    const workspace = new Workspace();
    try {
      const component = row("sub_result", {
        id: "task-123456789",
        wait: true,
        timeout: 0,
        finish,
      });
      expect(text(component)).toContain("Wait for response");
      component.updateResult(
        { ...reportResult("Wait timed out", workspace), isError: true },
        false,
      );
      expect(text(component)).toContain("Wait ended");
      expect(text(component)).toContain("No response yet.");
      expect(text(component)).not.toContain("Could not");
      component.setExpanded(true);
      expect(text(component)).toContain("Wait ended");
      expect(text(component)).toContain("Wait timed out");
      expect(text(component)).not.toContain("Could not");
    } finally {
      workspace.dispose();
    }
  },
);

test("child response text is not classified as a wait timeout", () => {
  const workspace = new Workspace();
  try {
    const component = row("sub_result", { id: "task-123456789", wait: true });
    component.updateResult(
      {
        ...reportResult(
          task({
            status: "ready",
            outcome: "reply",
            response: "Wait timed out",
          }),
          workspace,
        ),
        isError: false,
      },
      false,
    );
    expect(text(component)).toContain("Response · API review");
    expect(text(component)).not.toContain("Wait ended");
  } finally {
    workspace.dispose();
  }
});

test("acceptance is compact but complete data remains expandable, including stopped receipts", () => {
  const component = row("sub_result", { id: "task-123456789", finish: true });
  expect(text(component)).toContain("Accept response");
  result(
    component,
    receipt({ response: "Full reply.\nFinal verification details." }),
  );
  expect(text(component)).toContain("Accepted · API review");
  expect(text(component)).not.toContain("Full reply");
  component.setExpanded(true);
  expect(text(component)).toContain("Full reply.");
  expect(text(component)).toContain("Final verification details.");
  expect(text(component)).toContain("2857");
  component.setExpanded(false);
  result(component, receipt({ outcome: "stopped" }));
  expect(text(component)).toContain("Stopped · API review");
  expect(text(component)).not.toContain("Accepted");
});

test("control titles follow confirmed data rather than the requested action", () => {
  const component = row("sub_control", {
    id: "task-123456789",
    action: "pause",
  });
  expect(text(component)).toContain("Pause");
  result(component, task({ operation: "pausing" }));
  expect(text(component)).toContain("Pausing…");
  expect(text(component)).not.toContain("Paused");
  result(component, task({ status: "paused" }));
  expect(text(component)).toContain("Paused · API review");
  expect(text(component)).not.toContain("Stopped");
  result(component, task({ status: "ready", outcome: "reply" }));
  expect(text(component)).toContain("Response ready · API review");
  result(component, task({ operation: "closing" }));
  expect(text(component)).toContain("Stopping…");
  result(component, receipt({ outcome: "stopped" }));
  expect(text(component)).toContain("Stopped · API review");
  const resume = row("sub_control", { action: "continue" });
  result(resume, [task()]);
  expect(text(resume)).toContain("Resumed · API review");
  result(resume, [task({ status: "queued" })]);
  expect(text(resume)).toContain("Queued · API review");
});

test("batch success counts are compact; mixed results, failures and pending input remain visible", () => {
  const component = row("sub_control", { action: "pause" });
  result(component, [
    task({ status: "paused" }),
    task({ id: "second", description: "Second", status: "paused" }),
  ]);
  expect(text(component)).toContain("Paused · 2 tasks");
  expect(lines(component).filter((line) => line.trim())).toHaveLength(1);
  component.setExpanded(true);
  expect(text(component)).toContain("ID: second");
  component.setExpanded(false);
  result(component, [
    task({ status: "paused" }),
    task({
      id: "second",
      description: "Second",
      status: "ready",
      outcome: "error",
      error: "Provider denied",
      pendingInput: ["Unsent correction"],
    }),
  ]);
  expect(text(component)).toContain("Control results · 2 tasks");
  expect(text(component)).toContain("Failed · Second");
  expect(text(component)).toContain("Provider denied");
  expect(text(component)).toContain("Pending input retained.");
  result(component, "Termination unconfirmed", true);
  expect(text(component)).toContain("Could not pause");
  expect(text(component)).toContain("Termination unconfirmed");
  expect(text(component)).toContain("Some tasks may already have changed.");
});

test("execution failures and tool errors surface causes even without complete metadata", () => {
  const component = row("sub_result", { id: "task-123456789", finish: true });
  result(
    component,
    receipt({
      outcome: "error",
      error: "Provider authentication expired",
      pendingInput: ["Unsent correction"],
    }),
  );
  expect(text(component)).toContain("Failed · API review");
  expect(text(component)).toContain("Provider authentication expired");
  expect(text(component)).toContain("Pending input retained");
  result(component, undefined, true, false, "Cannot collect active task");
  expect(text(component)).toContain("Could not accept");
  expect(text(component)).toContain("Cannot collect active task");
});

test("termination errors remain visible while a pausing/closing operation owns the process", () => {
  const component = row("sub_control", {
    id: "task-123456789",
    action: "stop",
  });
  for (const operation of ["pausing", "closing"] as const) {
    result(
      component,
      task({
        operation,
        outcome: "error",
        error: "Could not confirm physical close",
      }),
    );
    expect(text(component)).toContain("Could not confirm physical close");
    expect(text(component)).not.toContain("Stopped ·");
  }
});

test("in-flight calls expose the original request on expansion", () => {
  const component = row("sub_task", {
    level: 1,
    description: "API review",
    prompt: "Original full briefing",
  });
  component.setExpanded(true);
  expect(text(component)).toContain("Original full briefing");
  expect(text(component)).toContain("Request:");
  component.setExpanded(false);
  expect(text(component)).not.toContain("Original full briefing");
});

test("file-backed tool rows keep full native diagnostics without reading the artifact", () => {
  const component = row("sub_result", { id: "task-123456789" });
  const report = task({
    status: "ready",
    outcome: "reply",
    response: "Question?\nComplete evidence",
  });
  const content = JSON.stringify({ file: "/not-read/report.txt" });
  result(
    component,
    {
      report,
      handoff: { file: "/not-read/report.txt", digest: digest(content) },
    },
    false,
    false,
    content,
  );
  expect(text(component)).toContain("Question?");
  component.setExpanded(true);
  expect(text(component)).toContain("Complete evidence");
  expect(text(component)).toContain("/native/task.jsonl");
  expect(text(component)).toContain("test/strong:high");
});

test("publication errors show confirmed acceptance separately from unavailable delivery", () => {
  const component = row("sub_result", { id: "task-123456789", finish: true });
  result(
    component,
    { report: receipt(), reportError: "ENOSPC: no space left" },
    true,
  );
  for (const expanded of [false, true]) {
    component.setExpanded(expanded);
    expect(text(component)).toContain("Accepted · API review");
    expect(text(component)).toContain("Report unavailable: ENOSPC");
    expect(text(component)).not.toContain("Could not accept");
    if (expanded) expect(text(component)).toContain("Full reply.");
  }
});

test("publication failures do not hide an original tool error", () => {
  const component = row("sub_result", { id: "unknown", finish: true });
  result(
    component,
    {
      report: "Unknown live task: unknown",
      reportError: "ENOSPC: no space left",
    },
    true,
  );
  for (const expanded of [false, true]) {
    component.setExpanded(expanded);
    expect(text(component)).toContain("Could not accept");
    expect(text(component)).toContain("Unknown live task: unknown");
    expect(text(component)).toContain("Report unavailable: ENOSPC");
  }
});

test("partial results never prematurely announce acceptance or control success", () => {
  const component = row("sub_result", { id: "task-123456789", finish: true });
  result(component, receipt(), false, true);
  expect(text(component)).toContain("Accepting…");
  expect(text(component)).not.toContain("Accepted");
  result(component, receipt());
  expect(text(component)).toContain("Accepted · API review");
});

test("empty batches and historical receipts need no live coordinator or duration evidence", () => {
  const component = row("sub_control", { action: "continue" });
  result(component, []);
  expect(text(component)).toContain("No paused tasks");
  const historical = row("sub_result", { id: "task-123456789" });
  result(historical, receipt());
  expect(text(historical)).toContain("Archived response · API review");
  expect(text(historical)).toContain("Full reply.");
});

test("native composition fits narrow widths, strips terminal controls, expands without data mutation", () => {
  const component = row("sub_result", { id: "task-123456789" });
  result(
    component,
    task({
      description: "\x1b[31m東京 🌟 review\ncontinued\x1b[0m",
      status: "ready",
      response: "\x1b[2JQuestion? 🌟\x07\b\x9f\nNext line",
    }),
  );
  for (const expanded of [false, true]) {
    component.setExpanded(expanded);
    for (let width = 0; width <= 100; width++)
      for (const line of lines(component, width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        expect(line).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
      }
  }
  component.setExpanded(false);
  for (const field of ["response", "preview"]) {
    result(component, { ...task(), [field]: 42 });
    expect(text(component)).toContain("Result");
  }
  result(component, { description: "malformed", pendingInput: 42 });
  expect(text(component)).toContain("Result");
  expect(text(component)).not.toContain("Accepted");
});
