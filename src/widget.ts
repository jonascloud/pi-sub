import type {
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Coordinator, Summary, TaskView } from "./coordinator.ts";
import { oneLine } from "./reports.ts";

const maxRows = 8;
const code = (task: TaskView) =>
  ({
    failed: "err",
    ready: "rdy",
    paused: "pse",
    queued: "que",
    active: task.activity || "thk",
  })[task.status as string] ?? "";
const time = (ms: number) => {
  const s = Math.floor(Math.max(0, ms) / 1000);
  const minutes = `${Math.floor(s / 60) % 60}:${String(s % 60).padStart(2, "0")}`;
  return s < 3600
    ? minutes
    : `${Math.floor(s / 3600)}:${minutes.padStart(5, "0")}`;
};
// Pi's footer format, without depending on its private component module.
const tokens = (n: number) =>
  n < 1_000
    ? String(n)
    : n < 10_000
      ? `${(n / 1_000).toFixed(1)}k`
      : n < 1_000_000
        ? `${Math.round(n / 1_000)}k`
        : `${(n / 1_000_000).toFixed(1)}M`;
// What needs the user first when rows are scarce.
const urgency = (task: TaskView) =>
  ["failed", "paused"].indexOf(task.status) + 1 || 3;

/**
 * Outstanding work: tasks still running, paused, or holding a reply or failure
 * the parent has not been handed. Delivered ones fold into a count.
 */
export function renderWidget(
  tasks: readonly TaskView[],
  width: number,
  theme: Pick<Theme, "fg" | "bold">,
  summary: Summary,
): string[] {
  width = Math.floor(width);
  if (width < 1 || (!tasks.length && !summary.inputTokens)) return [];
  const open = tasks.filter((task) => !task.delivered);
  const shown =
    open.length > maxRows
      ? open
          .map((task, index) => ({ task, index }))
          .sort(
            (a, b) => urgency(a.task) - urgency(b.task) || a.index - b.index,
          )
          .slice(0, maxRows - 1)
          .sort((a, b) => a.index - b.index)
          .map((item) => item.task)
      : open;
  const lines = shown.map((task) => {
    const detail = oneLine(task.error ?? task.response, width);
    const head = `  ${code(task).padEnd(3)} ${time(task.elapsedMs).padStart(5)} `;
    return truncateToWidth(
      theme.fg(task.status === "failed" ? "error" : "muted", head) +
        theme.bold(oneLine(task.description, 60)) +
        (detail ? theme.fg("muted", ` · ${detail}`) : ""),
      width,
    );
  });
  if (open.length > shown.length)
    lines.push(
      truncateToWidth(
        theme.fg("muted", `  +${open.length - shown.length} more`),
        width,
      ),
    );
  const delivered = tasks.length - open.length;
  lines.push(
    truncateToWidth(
      theme.fg(
        "accent",
        [
          "pi-sub",
          ...(delivered ? [`${delivered} delivered`] : []),
          `↑${tokens(summary.inputTokens)} ↓${tokens(summary.outputTokens)}`,
        ].join(" · "),
      ),
      width,
    ),
  );
  return lines;
}

export function mountWidget(
  ui: ExtensionUIContext,
  coordinator: Pick<Coordinator, "list" | "summary" | "subscribe">,
): () => void {
  let unmount = () => {};
  ui.setWidget(
    "pi-sub",
    (tui) => {
      // Elapsed time moves only while something runs.
      let clock: ReturnType<typeof setInterval> | undefined;
      const update = () => {
        const running = coordinator
          .list()
          .some((task) => task.status === "active");
        if (running) clock ??= setInterval(() => tui.requestRender(), 1000);
        else {
          clearInterval(clock);
          clock = undefined;
        }
        tui.requestRender();
      };
      const unsubscribe = coordinator.subscribe(update);
      unmount = () => {
        unsubscribe();
        clearInterval(clock);
      };
      return {
        render: (width) =>
          renderWidget(
            coordinator.list(),
            width,
            ui.theme,
            coordinator.summary(),
          ),
        invalidate() {},
        dispose: unmount,
      };
    },
    { placement: "aboveEditor" },
  );
  return () => {
    unmount();
    ui.setWidget("pi-sub", undefined);
  };
}
