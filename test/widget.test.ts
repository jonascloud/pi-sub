import { afterEach, describe, expect, it, vi } from "vitest";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type {
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { Summary, TaskView } from "../src/coordinator.ts";
import { mountWidget, renderWidget } from "../src/widget.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Pick<Theme, "fg" | "bold">;
const task = (overrides: Partial<TaskView> = {}): TaskView => ({
  id: "a",
  description: "Investigate",
  sessionFile: "native.jsonl",
  level: 7,
  execution: { provider: "p", model: "m", thinking: "off" },
  status: "active",
  turns: 7,
  toolUses: 3,
  tokens: 21,
  elapsedMs: 65000,
  response: "",
  activity: "thk",
  ...overrides,
});
const render = (
  tasks: TaskView[],
  width = 80,
  height = 12,
  summary: Summary = {
    completed: 0,
    inputTokens: tasks.reduce((n, t) => n + t.tokens, 0),
    outputTokens: 0,
  },
) => renderWidget(tasks, width, height, theme, summary);

describe("widget rendering", () => {
  it.each([
    [0, 0, "↑0 ↓0"],
    [192000, 27000, "↑192k ↓27k"],
    [999, 1234, "↑999 ↓1.2k"],
    [1000000, 10500000, "↑1.0M ↓11M"],
  ])(
    "formats input %i and output %i like Pi's footer",
    (inputTokens, outputTokens, expected) => {
      const rows = render([], 100, 12, {
        completed: 1,
        inputTokens,
        outputTokens,
      });
      expect(rows[0]).toContain(expected);
      expect(rows[0]).not.toContain("token");
    },
  );
  it("shows confirmed process closure in progress rather than apparent thinking", () => {
    const row = render([task({ operation: "closing" })])[0]!;
    expect(row).toContain("cls");
    expect(row).not.toContain("thk");
  });
  it("uses a bottom-rooted tree and aligned, expanding metadata", () => {
    const rows = render([
      task({ turns: 1000000 }),
      task({ id: "b", description: "Second" }),
    ]);
    expect(rows[0]).toContain("  ┌─");
    expect(rows[1]).toContain("  ├─");
    expect(rows[2]).toContain("──┴─ pi-sub");
    expect(rows[0]).toContain("lvl 7");
    expect(rows[0]).toContain("1000000↻");
    expect(rows[0]!.indexOf("Investigate")).toBe(rows[1]!.indexOf("Second"));
    const updated = render([
      task({ turns: 7 }),
      task({ description: "Second" }),
    ]);
    expect(updated[0]!.indexOf("Investigate")).toBe(
      updated[1]!.indexOf("Second"),
    );
  });
  it("uses compact metadata and fills a long response up to a six-column right inset", () => {
    const row = render(
      [
        task({
          description: "Globale Config-Datei",
          status: "ready",
          outcome: "reply",
          turns: 9,
          toolUses: 21,
          elapsedMs: 127000,
          response: "x".repeat(300),
        }),
      ],
      160,
    )[0]!;
    expect(row.indexOf("Globale Config-Datei")).toBe(30);
    expect(row).toContain("lvl 7 rdy   9↻  21⚒ 2:07");
    expect(visibleWidth(row)).toBe(154);
    expect(stripTerminalSequences(row).endsWith("…")).toBe(true);
    expect(
      render([task({ turns: 999, toolUses: 999 })], 160)[0]!.indexOf(
        "Investigate",
      ),
    ).toBe(30);
  });
  it("returns unused detail space to a long task name as well", () => {
    const row = render(
      [task({ description: "Investigate ".repeat(30), response: "OK" })],
      120,
    )[0]!;
    const start = row.indexOf("Investigate");
    const end = row.indexOf(" · OK");
    expect(end - start).toBeGreaterThan(60);
    expect(visibleWidth(row)).toBe(114);
    expect(row.endsWith(" · OK")).toBe(true);
  });
  it("dims only frozen elapsed times while active and terminating clocks stay normal", () => {
    for (const status of ["ready", "paused", "queued", "active"] as const) {
      const fg = vi.fn((_color: string, text: string) => text);
      renderWidget(
        [task({ status })],
        120,
        12,
        { ...theme, fg },
        { completed: 0, inputTokens: 21, outputTokens: 0 },
      );
      const dimmed = fg.mock.calls
        .filter(([color]) => color === "dim")
        .map(([, text]) => text.trim());
      expect(dimmed).toEqual(status === "active" ? [] : ["1:05"]);
    }
    const fg = vi.fn((_color: string, text: string) => text);
    renderWidget(
      [task({ operation: "closing" })],
      120,
      12,
      { ...theme, fg },
      { completed: 0, inputTokens: 21, outputTokens: 0 },
    );
    expect(fg.mock.calls.some(([color]) => color === "dim")).toBe(false);
  });
  it("preserves useful task identity at 40 columns and adds response when there is room", () => {
    const row = render(
      [
        task({
          description: "A substantial task name",
          response: "Current response detail",
        }),
      ],
      40,
    )[0]!;
    expect(row).toContain("lvl 7");
    expect(row).toContain("A substantial");
    expect(row).toContain("Current");
    expect(row).not.toContain("1:05");
  });
  it("fits all widths with wide text and terminal escapes, retaining narrow state", () => {
    for (let width = 1; width <= 80; width++) {
      const lines = render(
        [task({ description: "\x1b[31m東京 🌟 task\x1b[0m" })],
        width,
      );
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(
        lines.every((line) => !stripTerminalSequences(line).includes("\x1b")),
      ).toBe(true);
      if (width <= 3)
        expect(stripTerminalSequences(lines[0]!)).toBe("thk".slice(0, width));
    }
  });
  it("prioritizes errors and paused tasks while retaining newest input order", () => {
    const tasks = [
      task({ description: "new run" }),
      task({ description: "paused", status: "paused" }),
      task({
        description: "failed",
        status: "ready",
        outcome: "error",
        error: "failed badly",
      }),
      task({ description: "old run" }),
      task({ description: "oldest run" }),
    ];
    const rows = render(tasks, 80, 4);
    expect(rows[0]).toContain("paused");
    expect(rows[1]).toContain("failed");
    expect(rows[1]).toContain("err");
    expect(rows[2]).toContain("+3 run 3");
    expect(rows[3]).toContain("↑105 ↓0");
    expect(rows[3]).not.toContain("run");
  });
  it("keeps archive totals after live tasks are removed without retaining failed rows", () => {
    const failed = task({
      status: "ready",
      outcome: "error",
      error: "broken",
      description: "Failed identity",
    });
    expect(render([failed]).join("\n")).toContain("err");
    const summary = {
      completed: 3,
      inputTokens: 10000,
      outputTokens: 2000,
    };
    const rows = render([], 100, 12, summary);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("3 done");
    expect(rows[0]).not.toContain("failed");
    expect(rows[0]).not.toContain("stopped");
    expect(rows[0]).toContain("↑10k ↓2.0k");
    expect(rows[0]).not.toContain("token");
    expect(rows.join("\n")).not.toContain("Failed identity");
    expect(rows.join("\n")).not.toContain("broken");
    expect(render([])).toEqual([]);
  });
  it("selects newest ordinary rows and does not repeat tokens or models in rows", () => {
    const rows = render(
      [
        task({ description: "Newest" }),
        task({ description: "Middle" }),
        task({ description: "Oldest" }),
      ],
      100,
      3,
    );
    expect(rows[0]).toContain("Newest");
    expect(rows[1]).toContain("+2");
    expect(rows[0]).not.toContain("token");
    expect(rows[0]).not.toContain("model");
  });
  it("leaves research JSON in its own panel but retains genuine failure causes", () => {
    const proposal = task({
      level: undefined,
      response: '{"ladder":{"6":{"model":"test/m:off"}}}',
      status: "ready",
      outcome: "reply",
    });
    expect(render([proposal], 120).join("\n")).not.toContain("ladder");
    const failed = render(
      [{ ...proposal, outcome: "error", error: "Invalid proposal" }],
      120,
    ).join("\n");
    expect(failed).toContain("Invalid proposal");
  });
  it("collapses delivered replies without calling them completed", () => {
    const reply = task({
      status: "ready",
      outcome: "reply",
      reply: { id: "reply-1", delivered: true },
    });
    const lines = render([reply], 120);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("1 delivered");
    expect(lines[0]).not.toContain("done");
    expect(lines[0]).not.toContain("rdy");
    expect(lines[0]).not.toContain("──┴─");
    expect(
      render([{ ...reply, reply: { id: "reply-2", delivered: false } }], 120),
    ).toHaveLength(2);
  });
  it("does not spend row capacity on delivered replies or hide failures and pauses", () => {
    const reply = task({
      status: "ready",
      outcome: "reply",
      reply: { id: "reply-1", delivered: true },
    });
    const text = render(
      [
        reply,
        { ...reply, id: "failed", outcome: "error", error: "Provider failed" },
        { ...reply, id: "paused", status: "paused" },
        task({ description: "Still running" }),
      ],
      200,
      5,
    ).join("\n");
    expect(text).toContain("Provider failed");
    expect(text).toContain("pse");
    expect(text).toContain("Still running");
    expect(text).toContain("1 delivered");
    expect(text).not.toContain("+1");
  });
  it("shows paused and reply states", () => {
    expect(render([task({ status: "paused" })])[0]).toContain("pse");
    expect(render([task({ status: "ready", outcome: "reply" })])[0]).toContain(
      "rdy",
    );
  });
  it("puts root-only urgent state before brand and tokens", () => {
    const tasks = [
      task(),
      task({ status: "ready", outcome: "error", error: "oops" }),
    ];
    expect(stripTerminalSequences(render(tasks, 3, 1)[0]!)).toBe("err");
    expect(render(tasks, 40, 1)[0]!.startsWith("err 1")).toBe(true);
  });
});

afterEach(() => vi.useRealTimers());
it("polls only visible active rows, reserves space below, resumes and cleans up", () => {
  vi.useFakeTimers();
  let tasks = [task({ status: "paused" })];
  let listener = () => {};
  const unsubscribe = vi.fn();
  const coordinator = {
    list: () => tasks,
    summary: () => ({
      completed: 0,
      inputTokens: 21,
      outputTokens: 0,
    }),
    subscribe: (fn: () => void) => {
      listener = fn;
      return unsubscribe;
    },
  };
  let factory: ((tui: TUI, theme: Theme) => Component) | undefined;
  const ui = {
    theme,
    setWidget: vi.fn((_key: string, value: typeof factory) => {
      factory = value;
    }),
  } as unknown as ExtensionUIContext;
  const requestRender = vi.fn();
  const transcript = {
    render: vi.fn(() => {
      throw new Error("transcript must not be measured");
    }),
    invalidate() {},
  };
  const below = { render: () => ["editor", "footer"], invalidate() {} };
  const tui = {
    children: [] as Component[],
    terminal: { rows: 20 },
    requestRender,
  } as unknown as TUI;
  const cleanup = mountWidget(ui, coordinator);
  expect(vi.getTimerCount()).toBe(0);
  const component = factory!(tui, theme as Theme);
  tui.children.push(transcript, component, below);
  component.render(80);
  expect(transcript.render).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  tasks = [task()];
  listener();
  expect(requestRender).toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(1);
  (tui.terminal as { rows: number }).rows = 3;
  expect(component.render(80)).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
  (tui.terminal as { rows: number }).rows = 4;
  component.render(80);
  expect(vi.getTimerCount()).toBe(0); // root only
  (tui.terminal as { rows: number }).rows = 20;
  component.render(80);
  expect(vi.getTimerCount()).toBe(1);
  tasks = [task({ operation: "pausing" })];
  listener();
  expect(component.render(80)[0]).toContain("psg");
  expect(vi.getTimerCount()).toBe(1);
  requestRender.mockClear();
  vi.advanceTimersByTime(999);
  expect(requestRender).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(requestRender).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(1000);
  expect(requestRender).toHaveBeenCalledTimes(2);
  tasks = [task({ status: "ready", outcome: "reply" })];
  listener();
  expect(vi.getTimerCount()).toBe(0);
  tasks = [task({ status: "paused" }), task(), task()];
  (tui.terminal as { rows: number }).rows = 6;
  component.render(80); // one task row plus overflow and root; active row is hidden
  listener();
  expect(vi.getTimerCount()).toBe(0);
  tasks = [task()];
  listener();
  component.render(0);
  expect(vi.getTimerCount()).toBe(0);
  cleanup();
  expect(vi.getTimerCount()).toBe(0);
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(ui.setWidget).toHaveBeenLastCalledWith("pi-sub", undefined);
});
