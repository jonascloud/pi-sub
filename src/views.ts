import type {
  MessageRenderer,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { oneLine, reportLink, sanitize, type TaskDetails } from "./reports.ts";
import type { ReportRef } from "./report-store.ts";

type Tool = "sub_task" | "sub_message" | "sub_result" | "sub_control";
type Args = {
  id?: string;
  report?: string;
  offset?: number;
  description?: string;
  prompt?: string;
  message?: string;
  level?: number;
  action?: string;
  wait?: boolean;
  finish?: boolean;
};
type Line = { text: string; style?: "title" | "error" | "muted" };
type Theme = Parameters<MessageRenderer>[2];

const labels: Record<string, string> = {
  queued: "Queued",
  active: "Active",
  paused: "Paused",
  ready: "Response",
  failed: "Failed",
  accepted: "Accepted",
  stopped: "Stopped",
};

function tasksOf(details: unknown): TaskDetails[] {
  const tasks = (details as { tasks?: unknown } | undefined)?.tasks;
  return Array.isArray(tasks)
    ? tasks.filter(
        (task): task is TaskDetails =>
          !!task &&
          typeof task.id === "string" &&
          typeof task.description === "string",
      )
    : [];
}

/** Collapsed rows are single truncated lines; expanded text wraps. */
function rows(lines: () => Line[], theme: Theme, pad: number): Component {
  return {
    render(width) {
      const padding = " ".repeat(
        Math.max(0, Math.min(pad, Math.floor((width - 1) / 2))),
      );
      const room = Math.floor(width) - padding.length * 2;
      if (room < 1) return [];
      return lines().map(({ text, style }) => {
        const line = truncateToWidth(text, room);
        return (
          padding +
          (style === "title"
            ? theme.bold(line)
            : style
              ? theme.fg(style, line)
              : line) +
          padding
        );
      });
    },
    invalidate() {},
  };
}
function wrapped(text: string, pad: number): Component {
  const component = new Text(sanitize(text), pad, 0);
  return {
    render: (width) =>
      width < 1
        ? []
        : component.render(width).map((line) => truncateToWidth(line, width)),
    invalidate: () => component.invalidate(),
  };
}

/** A task's state and what the parent needs to see of it: the cause first, then the reply. */
function summary(task: TaskDetails, replied: boolean): Line[] {
  const working = ["queued", "active", "paused"].includes(task.status);
  return [
    {
      text: `${labels[task.status] ?? "Task"} · ${task.description || task.id.slice(0, 8)}`,
      style: "title",
    },
    ...(task.error ? [{ text: task.error, style: "error" as const }] : []),
    // A task at work may still hold its previous execution's text.
    ...(replied && !working && task.preview
      ? [{ text: task.preview, style: "muted" as const }]
      : []),
    ...(task.unsent && task.status !== "queued" && task.status !== "active"
      ? [{ text: "Unsent instructions are kept.", style: "muted" as const }]
      : []),
  ];
}
function details(task: TaskDetails): string {
  return [
    `Task: ${task.description}`,
    `ID: ${task.id}`,
    `Level ${task.level} · ${task.execution}`,
    `Session: ${task.sessionFile}`,
    ...(task.report ? [reportLink(task.report)] : []),
    `${task.elapsedMs} ms · ${task.turns} turns · ${task.toolUses} tools · ${task.tokens} tokens`,
  ].join("\n");
}

/** Requests name the action; results name the confirmed state. */
export function taskToolRenderers(tool: Tool): ToolRenderers {
  return {
    renderCall(input, theme, context) {
      const args = (input ?? {}) as Args;
      const action = {
        sub_task: "Delegate",
        sub_message: "Message",
        sub_result: args.report
          ? "Read report"
          : args.finish
            ? "Accept"
            : args.wait
              ? "Wait for"
              : "Read",
        sub_control:
          { pause: "Pause", continue: "Continue", stop: "Stop" }[
            args.action ?? ""
          ] ?? "Control",
      }[tool];
      const name = oneLine(
        args.description ||
          args.report ||
          args.id?.slice(0, 8) ||
          args.prompt ||
          "all tasks",
        80,
      );
      const head = `${action} · ${name}${tool === "sub_task" && args.level ? ` · lvl ${args.level}` : ""}`;
      const body = args.report
        ? `Byte offset: ${args.offset ?? 0}`
        : (args.prompt ?? args.message);
      return context.expanded && body
        ? wrapped(`${head}\n\n${body}`, context.outputPad)
        : rows(
            () => [{ text: head, style: "title" }],
            theme,
            context.outputPad,
          );
    },
    renderResult(result, { expanded }, theme, context) {
      const text = result.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n");
      const tasks = tasksOf(result.details);
      const report = (result.details as { report?: ReportRef } | undefined)
        ?.report;
      if (report && !context.isError)
        return expanded
          ? wrapped(text, context.outputPad)
          : rows(
              () => [
                {
                  text: `${tasks.length ? "Task results" : "Report"} · ${report.id} · ${report.bytes} bytes`,
                  style: "title",
                },
              ],
              theme,
              context.outputPad,
            );
      if (context.isError || !tasks.length)
        return expanded
          ? wrapped(text, context.outputPad)
          : rows(
              () => [
                {
                  text: context.isError ? oneLine(text) : "No tasks",
                  style: context.isError ? "error" : "muted",
                },
              ],
              theme,
              context.outputPad,
            );
      if (!expanded)
        return rows(
          () => tasks.flatMap((task) => summary(task, tasks.length === 1)),
          theme,
          context.outputPad,
        );
      // The reply itself is stored once, in the content the model read.
      let reports: { id?: string; response?: string; error?: string }[] = [];
      try {
        reports = [JSON.parse(text)].flat();
      } catch {
        /* Details alone still describe the tasks. */
      }
      return wrapped(
        tasks
          .map((task) => {
            const report = reports.find((item) => item?.id === task.id);
            return [
              `${labels[task.status] ?? "Task"} · ${details(task)}`,
              ...(report?.error ? [`Error:\n${report.error}`] : []),
              ...(report?.response ? [`Response:\n${report.response}`] : []),
            ].join("\n\n");
          })
          .join("\n\n"),
        context.outputPad,
      );
    },
  };
}

/** Replies and failures that reached the parent on their own. */
export const renderReplies: MessageRenderer = (message, options, theme) => {
  const tasks = tasksOf(message.details);
  if (!options.expanded && tasks.length)
    return rows(
      () => tasks.flatMap((task) => summary(task, true)),
      theme,
      options.outputPad,
    );
  const content =
    typeof message.content === "string"
      ? message.content
      : message.content
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n");
  return wrapped(
    [content, ...tasks.map(details)].join("\n\n"),
    options.outputPad,
  );
};
