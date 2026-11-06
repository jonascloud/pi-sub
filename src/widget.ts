import type {
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import type { Coordinator, Summary, TaskView } from "./coordinator.ts";

type WidgetTheme = Pick<Theme, "fg" | "bold">;
const active = (task: TaskView) => task.status === "active";
const delivered = (task: TaskView) =>
  task.status === "ready" &&
  task.outcome === "reply" &&
  task.reply?.delivered === true;
const clean = (text: string) =>
  stripTerminalSequences(text)
    .replace(/[\r\n\t\x00-\x1f\x7f-\x9f]+/g, " ")
    .trim();
// Research proposals have their own panel; do not leak its JSON into the task row.
const detail = (task: TaskView) =>
  clean(task.error || (task.level === undefined ? "" : task.response));
const code = (task: TaskView) => {
  if (task.outcome === "error") return "err";
  if (task.operation === "pausing") return "psg";
  if (task.operation === "closing") return "cls";
  if (task.outcome === "stopped") return "stp";
  if (task.status === "active")
    return clean(task.activity).slice(0, 3) || "thk";
  return { queued: "que", ready: "rdy", paused: "pse" }[task.status];
};
const time = (ms: number) => {
  const s = Math.floor(Math.max(0, ms) / 1000);
  return s < 3600
    ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
    : `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
// Match Pi's footer formatting without depending on its private component module.
const tokenCount = (n: number) =>
  n < 1_000
    ? String(n)
    : n < 10_000
      ? `${(n / 1_000).toFixed(1)}k`
      : n < 1_000_000
        ? `${Math.round(n / 1_000)}k`
        : n < 10_000_000
          ? `${(n / 1_000_000).toFixed(1)}M`
          : `${Math.round(n / 1_000_000)}M`;
const pad = (s: string, n: number) =>
  " ".repeat(Math.max(0, n - visibleWidth(s))) + s;

const priority = (t: TaskView) =>
  t.outcome === "error"
    ? 0
    : t.status === "paused"
      ? 1
      : t.operation === "pausing"
        ? 2
        : 3;
function select(tasks: readonly TaskView[], height: number) {
  const rows = tasks.filter((task) => !delivered(task));
  const room = Math.max(0, Math.min(12, height) - 1);
  const capacity = rows.length > room && room > 1 ? room - 1 : room;
  const selected = new Set(
    rows
      .map((task, index) => ({ task, index }))
      .sort((a, b) => priority(a.task) - priority(b.task) || a.index - b.index)
      .slice(0, capacity)
      .map((item) => item.index),
  );
  return {
    shown: rows.filter((_, i) => selected.has(i)),
    hidden: rows.filter((_, i) => !selected.has(i)),
    room,
  };
}
function counts(items: readonly TaskView[]): string[] {
  const statuses: [string, (t: TaskView) => boolean][] = [
    ["err", (t) => code(t) === "err"],
    ["pse", (t) => code(t) === "pse"],
    ["psg", (t) => code(t) === "psg"],
    ["cls", (t) => code(t) === "cls"],
    ["rdy", (t) => code(t) === "rdy"],
    [
      "run",
      (t) => active(t) && !["err", "psg", "cls", "stp"].includes(code(t)),
    ],
    ["que", (t) => code(t) === "que"],
    ["stp", (t) => code(t) === "stp"],
  ];
  return statuses.flatMap(([label, matches]) => {
    const n = items.filter(matches).length;
    return n ? [`${label} ${n}`] : [];
  });
}

export function renderWidget(
  tasks: readonly TaskView[],
  width: number,
  height: number,
  theme: WidgetTheme,
  summary: Summary,
): string[] {
  width = Math.max(0, Math.floor(width));
  height = Math.max(0, Math.min(12, Math.floor(height)));
  if (
    !width ||
    !height ||
    (!tasks.length &&
      !summary.completed &&
      !summary.inputTokens &&
      !summary.outputTokens)
  )
    return [];
  // Reserve six columns on roomy terminals, reclaiming them below 46 columns.
  width -= Math.min(6, Math.max(0, width - 40));
  const { shown, hidden, room } = select(tasks, height);
  const columns = [
    {
      min: 5,
      values: shown.map((t) => (t.level == null ? "" : `lvl ${t.level}`)),
    },
    { min: 3, values: shown.map((t) => code(t)) },
    { min: 4, values: shown.map((t) => `${t.turns}↻`) },
    { min: 4, values: shown.map((t) => `${t.toolUses}⚒`) },
    { min: 4, values: shown.map((t) => time(t.elapsedMs)) },
  ].map((c) => ({
    ...c,
    size: Math.max(c.min, ...c.values.map(visibleWidth)),
  }));
  const enabled = [true, true, true, true, true];
  let chrome = true;
  const used = () =>
    (chrome ? 5 : 0) +
    columns.reduce((n, c, i) => n + (enabled[i] ? c.size + 1 : 0), 0);
  const target = shown.some((t) => detail(t)) && width >= 35 ? 23 : 12;
  for (const i of [4, 3, 2, 0]) if (used() + target > width) enabled[i] = false;
  if (used() + (target === 23 ? 28 : 12) > width) chrome = false;
  const lines = shown.map((task, row) => {
    const status = code(task);
    if (width <= 3) return truncateToWidth(status, width, "");
    const prefix = chrome ? (row === 0 ? "  ┌─ " : "  ├─ ") : "";
    const metadata = columns
      .map((c, i) => {
        if (!enabled[i]) return "";
        const value = pad(c.values[row]!, c.size);
        return `${i === 4 && !active(task) ? theme.fg("dim", value) : value} `;
      })
      .join("");
    const remaining = Math.max(0, width - visibleWidth(prefix + metadata));
    const description = clean(task.description);
    const currentDetail = detail(task);
    // Share space when both texts are long; give unused space to the other.
    const detailShare =
      currentDetail && remaining >= 23
        ? Math.min(
            visibleWidth(currentDetail),
            Math.floor((remaining - 4) / 2),
            remaining - 18,
          )
        : 0;
    const descRoom = detailShare ? remaining - detailShare - 3 : remaining;
    const title = truncateToWidth(description, descRoom, "…");
    const detailRoom = detailShare ? remaining - visibleWidth(title) - 3 : 0;
    const tail =
      theme.bold(title) +
      (detailRoom
        ? ` · ${truncateToWidth(currentDetail, detailRoom, "…")}`
        : "");
    return truncateToWidth(prefix + metadata + tail, width);
  });
  if (hidden.length && room > shown.length) {
    const prefix = chrome ? "  ├─ " : "";
    lines.push(
      truncateToWidth(
        theme.fg(
          "muted",
          `${prefix}+${hidden.length} ${counts(hidden).join(" · ")}`,
        ),
        width,
      ),
    );
  }
  const returned = tasks.filter(delivered).length;
  const totals = [
    ...(returned ? [`${returned} delivered`] : []),
    ...(summary.completed ? [`${summary.completed} done`] : []),
  ];
  const tokens = `↑${tokenCount(summary.inputTokens)} ↓${tokenCount(summary.outputTokens)}`;
  const rootOnly = room === 0;
  const parts = rootOnly
    ? [...counts(hidden), ...totals, tokens, "pi-sub"]
    : [
        shown.length || hidden.length ? "──┴─ pi-sub" : "pi-sub",
        ...totals,
        tokens,
      ];
  let root = parts[0] ?? "pi-sub";
  for (const part of parts.slice(1)) {
    const next = `${root} · ${part}`;
    if (visibleWidth(next) <= width) root = next;
  }
  lines.push(
    theme.fg(
      "accent",
      truncateToWidth(root, width, width <= 3 ? "" : undefined),
    ),
  );
  return lines;
}

// Count only components after our identity path; earlier siblings are transcript.
export function availableWidgetHeight(
  tui: TUI,
  component: Component,
  width: number,
): number {
  function following(children: Component[]): number | undefined {
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i]!;
      const nested =
        child === component
          ? 0
          : Array.isArray((child as { children?: unknown }).children)
            ? following(
                (child as unknown as { children: Component[] }).children,
              )
            : undefined;
      if (nested !== undefined)
        return (
          nested +
          children
            .slice(i + 1)
            .reduce((n, sibling) => n + sibling.render(width).length, 0)
        );
    }
    return undefined;
  }
  const below = following(tui.children);
  return Math.max(
    0,
    Math.min(12, tui.terminal.rows - (below === undefined ? 6 : below + 1)),
  );
}

export function mountWidget(
  ui: ExtensionUIContext,
  coordinator: Pick<Coordinator, "list" | "summary" | "subscribe">,
): () => void {
  let disposed = false;
  let stop = () => {};
  ui.setWidget(
    "pi-sub",
    (tui) => {
      let timer: ReturnType<typeof setInterval> | undefined;
      let visible = false;
      let height = 0;
      const updateTimer = (tasks: readonly TaskView[]) => {
        const { shown } = select(tasks, height);
        const needsTimer = visible && shown.some(active);
        if (needsTimer && !timer)
          timer = setInterval(() => tui.requestRender(), 1000);
        if (!needsTimer && timer) {
          clearInterval(timer);
          timer = undefined;
        }
      };
      const unsubscribe = coordinator.subscribe(() => {
        if (disposed) return;
        updateTimer(coordinator.list());
        tui.requestRender();
      });
      let unmounted = false;
      const component: Component & { dispose(): void } = {
        render(width) {
          height = availableWidgetHeight(tui, component, width);
          visible = height > 0 && width > 0;
          const tasks = coordinator.list();
          updateTimer(tasks);
          return renderWidget(
            tasks,
            width,
            height,
            ui.theme,
            coordinator.summary(),
          );
        },
        invalidate() {},
        dispose() {
          if (unmounted) return;
          unmounted = true;
          unsubscribe();
          if (timer) clearInterval(timer);
          timer = undefined;
        },
      };
      stop = component.dispose;
      return component;
    },
    { placement: "aboveEditor" },
  );
  return () => {
    if (disposed) return;
    disposed = true;
    stop();
    ui.setWidget("pi-sub", undefined);
  };
}
