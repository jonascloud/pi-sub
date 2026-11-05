import { afterEach, describe, expect, it, vi } from "vitest";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type {
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { TaskView } from "../src/coordinator.ts";
import { mountWidget, renderWidget } from "../src/widget.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Pick<Theme, "fg" | "bold">;
const task = (overrides: Partial<TaskView> = {}): TaskView => ({
  id: "a",
  description: "Investigate",
  level: 7,
  execution: { provider: "p", model: "m", thinking: "off" },
  status: "running",
  turns: 7,
  toolUses: 3,
  tokens: 21,
  elapsedMs: 65000,
  response: "",
  activity: "thk",
  collected: false,
  ...overrides,
});
const render = (tasks: TaskView[], width = 80, height = 12) =>
  renderWidget(tasks, width, height, theme);

describe("widget rendering", () => {
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
  it("prioritizes attention while retaining input order and never hides collected errors", () => {
    const tasks = [
      task({ description: "new run" }),
      task({ description: "paused", status: "paused" }),
      task({
        description: "failed",
        status: "closed",
        collected: true,
        error: "failed badly",
      }),
      task({ description: "old run" }),
      task({ status: "closed", collected: true, tokens: 100 }),
    ];
    const rows = render(tasks, 80, 4);
    expect(rows[0]).toContain("paused");
    expect(rows[1]).toContain("failed");
    expect(rows[1]).toContain("err");
    expect(rows[2]).toContain("+2 run 2");
    expect(rows[3]).toContain("1 done");
    expect(rows[3]).toContain("184 token");
    expect(rows[3]).not.toContain("run");
  });
  it("puts root-only urgent state before brand and tokens", () => {
    const tasks = [task(), task({ status: "error", error: "oops" })];
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
  cleanup();
  expect(vi.getTimerCount()).toBe(0);
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(ui.setWidget).toHaveBeenLastCalledWith("pi-sub", undefined);
});
