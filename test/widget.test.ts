import { afterEach, expect, test, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
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
const task = (fields: Partial<TaskView> = {}): TaskView => ({
  id: "a",
  description: "Investigate",
  sessionFile: "native.jsonl",
  level: 7,
  execution: { provider: "p", model: "m", thinking: "off" },
  status: "active",
  activity: "cmd",
  turns: 7,
  toolUses: 3,
  tokens: 21,
  elapsedMs: 65000,
  response: "",
  unsent: 0,
  delivered: false,
  ...fields,
});
const render = (tasks: TaskView[], width = 80, inputTokens = 12345) =>
  renderWidget(tasks, width, theme, { inputTokens, outputTokens: 678 });

test("shows outstanding work and folds what the parent was handed into a count", () => {
  expect(render([], 80, 0)).toEqual([]);
  expect(render([], 80)).toEqual(["pi-sub · ↑12k ↓678"]); // Usage of removed tasks.
  expect(
    render([
      task(),
      task({ status: "active", activity: "", elapsedMs: 3723000 }),
      task({ status: "queued", elapsedMs: 0 }),
      task({ status: "paused", description: "Halted\nwork" }),
      task({ status: "ready", response: "The answer\nis 42." }),
      task({ status: "failed", error: "exited 1", response: "partial" }),
      task({ status: "ready", delivered: true }),
      task({ status: "failed", error: "known", delivered: true }),
    ]),
  ).toEqual([
    "  cmd  1:05 Investigate",
    "  thk 1:02:03 Investigate",
    "  que  0:00 Investigate",
    "  pse  1:05 Halted work",
    "  rdy  1:05 Investigate · The answer is 42.",
    "  err  1:05 Investigate · exited 1",
    "pi-sub · 2 delivered · ↑12k ↓678",
  ]);
});

test("keeps failures and pauses visible when there are more tasks than rows", () => {
  const many = [
    ...Array.from({ length: 9 }, (_, i) =>
      task({ description: `Running ${i}` }),
    ),
    task({ status: "paused", description: "Paused" }),
    task({ status: "failed", description: "Broken", error: "exited 1" }),
  ];
  const lines = render(many);
  expect(lines).toHaveLength(9);
  expect(lines.slice(0, 5).join()).toMatch(/Running 0.*Running 4/);
  expect(lines[5]).toContain("Paused");
  expect(lines[6]).toContain("Broken · exited 1");
  expect(lines[7]).toBe("  +4 more");
  for (const width of [0, 1, 3, 10, 40])
    for (const line of render(many, width))
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  expect(
    render([
      task({ description: "\x1b[31mRed\x07", response: "a\x1b]8;;x\x07b" }),
    ])[0],
  ).toBe("  cmd  1:05 Red · ab");
});

afterEach(() => vi.useRealTimers());
test("redraws on changes, ticks only while something runs, and cleans up", () => {
  vi.useFakeTimers();
  let tasks = [task({ status: "paused" })];
  let changed = () => {};
  const unsubscribe = vi.fn();
  let factory: ((tui: TUI, theme: Theme) => Component) | undefined;
  const ui = {
    theme,
    setWidget: vi.fn((_key: string, value: typeof factory) => {
      factory = value;
    }),
  } as unknown as ExtensionUIContext;
  const requestRender = vi.fn();
  const unmount = mountWidget(ui, {
    list: () => tasks,
    summary: () => ({ inputTokens: 21, outputTokens: 0 }),
    subscribe: (listener: () => void) => {
      changed = listener;
      return unsubscribe;
    },
  });
  const component = factory!(
    { requestRender } as unknown as TUI,
    theme as Theme,
  );
  expect(component.render(80)).toEqual([
    "  pse  1:05 Investigate",
    "pi-sub · ↑21 ↓0",
  ]);
  changed();
  expect(requestRender).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  tasks = [task()];
  changed();
  changed();
  expect(vi.getTimerCount()).toBe(1);
  requestRender.mockClear();
  vi.advanceTimersByTime(2000);
  expect(requestRender).toHaveBeenCalledTimes(2);
  tasks = [task({ status: "ready" })];
  changed();
  expect(vi.getTimerCount()).toBe(0);
  tasks = [task()];
  changed();
  unmount();
  expect(vi.getTimerCount()).toBe(0);
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(ui.setWidget).toHaveBeenLastCalledWith("pi-sub", undefined);
});
