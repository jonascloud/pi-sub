import type { ToolRenderers } from "@earendil-works/pi-coding-agent";
import {
  Text,
  stripTerminalSequences,
  truncateToWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { reportDetails, reportFailure, type TaskMetadata } from "./reports.ts";
type DisplayReport = TaskMetadata & {
  response?: string;
  pendingInput?: string[];
  activity?: string;
};

type Tool = "sub_task" | "sub_message" | "sub_result" | "sub_control";
type Args = {
  id?: string;
  description?: string;
  prompt?: string;
  message?: string;
  level?: number;
  action?: string;
  wait?: boolean;
  finish?: boolean;
};
type View = {
  action: string;
  name: string;
  level?: number;
  error?: boolean;
  lines?: string[];
};
type RowState = { view?: View };
const sanitize = (value: string) =>
  stripTerminalSequences(value)
    .replace(/\r\n/g, "\n")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
const clean = (value: string) => sanitize(value).replace(/\s+/g, " ").trim();
const preview = (value: string) =>
  sanitize(value)
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(0, 2)
    .map(clean);
const textContent = (content: { type: string; text?: string }[]) =>
  content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
const isTask = (value: unknown): value is DisplayReport => {
  if (!value || typeof value !== "object") return false;
  const task = value as DisplayReport;
  return (
    ["id", "description", "sessionFile"].every(
      (key) =>
        typeof (task as unknown as Record<string, unknown>)[key] === "string",
    ) &&
    ["elapsedMs", "turns", "toolUses", "tokens"].every(
      (key) =>
        typeof (task as unknown as Record<string, unknown>)[key] === "number",
    ) &&
    !!task.execution &&
    ["provider", "model", "thinking"].every(
      (key) =>
        typeof (task.execution as unknown as Record<string, unknown>)[key] ===
        "string",
    ) &&
    (task.status === undefined ||
      ["queued", "active", "paused", "ready"].includes(task.status)) &&
    (task.outcome === undefined ||
      ["reply", "error", "stopped"].includes(task.outcome)) &&
    (task.level === undefined || level(task.level) !== undefined) &&
    (task.operation === undefined ||
      ["pausing", "closing"].includes(task.operation)) &&
    (task.response === undefined || typeof task.response === "string") &&
    (task.preview === undefined || typeof task.preview === "string") &&
    (task.error === undefined || typeof task.error === "string") &&
    (task.pendingInput === undefined ||
      (Array.isArray(task.pendingInput) &&
        task.pendingInput.every((input) => typeof input === "string")))
  );
};
const identity = (args: Args) =>
  typeof args.description === "string" && args.description.trim()
    ? clean(args.description)
    : typeof args.id === "string"
      ? args.id.slice(0, 8)
      : typeof args.prompt === "string"
        ? clean(args.prompt).slice(0, 80)
        : "Task";
const level = (value: unknown) =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 1 &&
  value <= 10
    ? value
    : undefined;

/** Native text wrapping for expanded details, bounded one-line previews otherwise. */
function block(text: () => string, padding: number, wrap = false): Component {
  return {
    render(width) {
      width = Math.max(0, Math.floor(width));
      if (!width) return [];
      const pad = " ".repeat(
        Math.max(0, Math.min(padding, Math.floor((width - 1) / 2))),
      );
      const room = width - pad.length * 2;
      const content = text();
      if (!content) return [];
      const lines = wrap
        ? new Text(content, 0, 0).render(room)
        : content.split("\n");
      return lines.map((line) => pad + truncateToWidth(line, room) + pad);
    },
    invalidate() {},
  };
}

function pending(tool: Tool, args: Args, started: boolean): View {
  const actions = {
    sub_task: started ? "Delegating…" : "Delegate",
    sub_message: started ? "Redirecting…" : "Update instruction",
    sub_result: args.wait
      ? started
        ? "Waiting"
        : "Wait for response"
      : args.finish
        ? started
          ? "Accepting…"
          : "Accept response"
        : "Read response",
    sub_control:
      args.action === "pause"
        ? started
          ? "Pausing…"
          : "Pause"
        : args.action === "continue"
          ? started
            ? "Resuming…"
            : "Resume"
          : args.action === "stop"
            ? started
              ? "Stopping…"
              : "Stop"
            : "Control",
  };
  return {
    action: actions[tool],
    name: identity(args),
    level: tool === "sub_task" ? level(args.level) : undefined,
  };
}
function taskView(tool: Tool, args: Args, task: DisplayReport): View {
  const view: View = {
    action: "Result",
    name: clean(task.description) || task.id.slice(0, 8),
  };
  const live = task.status !== undefined;
  const lines: string[] = [];
  if (live && task.operation) {
    view.action = task.operation === "closing" ? "Stopping…" : "Pausing…";
  } else if (task.outcome === "error") {
    view.action = "Failed";
    view.error = true;
  } else if (task.outcome === "stopped") {
    // Interruption has a stopped execution, but retains a paused live task.
    view.action = live && task.status === "paused" ? "Paused" : "Stopped";
  } else if (tool === "sub_task") {
    view.action =
      live && task.status === "queued"
        ? "Queued"
        : live && task.status === "paused"
          ? "Paused"
          : "Delegated";
    view.level = level(task.level) ?? level(args.level);
  } else if (tool === "sub_message") {
    view.action = "Instruction updated";
    if (typeof args.message === "string") lines.push(...preview(args.message));
  } else if (tool === "sub_result") {
    if (!live) view.action = args.finish ? "Accepted" : "Archived response";
    else if (task.status === "ready") view.action = "Response";
    else
      view.action =
        { active: "Active", queued: "Queued", paused: "Paused" }[
          task.status!
        ] ?? "Result";
    // An active/paused snapshot can still contain a previous execution's answer.
    if (!args.finish && (!live || task.status === "ready"))
      lines.push(...preview(task.response ?? task.preview ?? ""));
  } else {
    view.action = live
      ? ({
          paused: "Paused",
          queued: "Queued",
          active: args.action === "continue" ? "Resumed" : "Active",
          ready: "Response ready",
        }[task.status!] ?? "Result")
      : "Result";
  }
  const cause =
    task.error || (task.outcome === "error" ? "Execution failed" : undefined);
  if (cause) {
    view.error = true;
    lines.unshift(...preview(cause));
  }
  if (
    (task.pendingInput?.length || task.pendingInputs) &&
    (task.outcome === "error" ||
      task.outcome === "stopped" ||
      (live && task.status === "paused"))
  )
    lines.push("Pending input retained.");
  return { ...view, lines };
}

function summary(
  tool: Tool,
  args: Args,
  details: unknown,
  text: string,
  error: boolean,
  partial: boolean,
): View {
  // This is the coordinator's exact timeout outcome, not a heuristic over child text.
  if (
    error &&
    tool === "sub_result" &&
    args.wait &&
    details === "Wait timed out"
  )
    return {
      action: "Wait ended",
      name: identity(args),
      lines: ["No response yet."],
    };
  if (error) {
    const action = {
      sub_task: "Could not delegate",
      sub_message: "Could not update instruction",
      sub_result: args.finish ? "Could not accept" : "Could not read response",
      sub_control: `Could not ${args.action ?? "control"}`,
    }[tool];
    return {
      action,
      name: identity(args),
      error: true,
      lines: [
        ...preview(typeof details === "string" ? details : text),
        ...(tool === "sub_control" && !args.id
          ? ["Some tasks may already have changed."]
          : []),
      ],
    };
  }
  if (partial) return pending(tool, args, true);
  if (isTask(details)) return taskView(tool, args, details);
  if (Array.isArray(details) && details.every(isTask)) {
    if (!details.length)
      return {
        action:
          tool === "sub_control" && args.action === "continue"
            ? "No paused tasks"
            : "No tasks",
        name: "",
      };
    if (details.length === 1) return taskView(tool, args, details[0]);
    const views = details.map((task) => taskView(tool, args, task));
    const same = views.every((view) => view.action === views[0]!.action);
    return {
      action: same ? views[0]!.action : "Control results",
      name: `${views.length} tasks`,
      error: views.some((view) => view.error),
      lines: views
        .filter((view) => view.error || !same)
        .flatMap((view) => [
          `${view.action} · ${view.name}`,
          ...(view.lines ?? []),
        ]),
    };
  }
  return { action: "Result", name: identity(args), lines: preview(text) };
}

function taskDetails(task: DisplayReport): string {
  const execution = task.execution;
  return [
    `Task: ${clean(task.description)}`,
    `ID: ${clean(task.id)}`,
    task.level === undefined ? undefined : `Required level: ${task.level}`,
    execution
      ? `Execution: ${clean(execution.provider)}/${clean(execution.model)}:${clean(execution.thinking)}`
      : undefined,
    `Session: ${clean(task.sessionFile ?? "")}`,
    task.status !== undefined
      ? `State: ${clean(task.status)}${task.operation ? ` · ${clean(task.operation)}` : ""}`
      : undefined,
    task.outcome ? `Outcome: ${clean(task.outcome)}` : undefined,
    "activity" in task && typeof task.activity === "string"
      ? `Activity: ${clean(task.activity)}`
      : undefined,
    `Elapsed: ${task.elapsedMs} ms · Turns: ${task.turns} · Tools: ${task.toolUses} · Tokens: ${task.tokens}`,
    task.error ? `Error:\n${sanitize(task.error)}` : undefined,
    task.response
      ? `Response:\n${sanitize(task.response)}`
      : task.preview
        ? `Preview:\n${sanitize(task.preview)}`
        : undefined,
    task.pendingInput?.length
      ? `Pending input:\n${task.pendingInput.map((input) => sanitize(input)).join("\n\n")}`
      : undefined,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

/** Only the native row-local state is shared: no task registry, worker access or polling. */
export function taskToolRenderers(tool: Tool): ToolRenderers {
  return {
    // The native error shell would paint an ordinary wait timeout as an execution failure.
    renderShell: "self",
    renderCall(args, theme, context) {
      const state = context.state as RowState;
      return block(
        () => {
          // Exports render the request before the outcome; never give it a lasting live state.
          if (state.view) return "";
          const view = pending(tool, args ?? {}, false);
          const name = view.name ? ` · ${theme.bold(clean(view.name))}` : "";
          const suffix = view.level === undefined ? "" : ` · lvl ${view.level}`;
          return (
            theme.fg(view.error ? "error" : "toolTitle", view.action) +
            name +
            theme.fg("muted", suffix) +
            (context.expanded
              ? `\n\nRequest:\n${JSON.stringify(args ?? {}, null, 2)}`
              : "")
          );
        },
        context.outputPad,
        context.expanded,
      );
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const args = (context.args ?? {}) as Args;
      const raw = textContent(result.content);
      const details = reportDetails(result.details, raw);
      const publicationError = reportFailure(result.details);
      const reference =
        result.details &&
        typeof result.details === "object" &&
        "handoff" in result.details
          ? "\n\n" + sanitize(raw)
          : "";
      const view = summary(
        tool,
        args,
        details,
        raw,
        context.isError &&
          (publicationError === undefined || typeof details === "string"),
        isPartial,
      );
      if (publicationError !== undefined) {
        view.error = true;
        view.lines = [
          `Report unavailable: ${preview(publicationError).join(" ")}`,
          ...(view.lines ?? []),
        ];
      }
      if (reference)
        view.lines = [
          ...(view.lines ?? []),
          "Temporary report · details show the file reference.",
        ];
      (context.state as RowState).view = view;
      if (expanded) {
        const data =
          Array.isArray(details) && details.every(isTask)
            ? details
            : isTask(details)
              ? [details]
              : undefined;
        const detail =
          (publicationError === undefined
            ? ""
            : `Report unavailable: ${sanitize(publicationError)}\n\n`) +
          (data
            ? data.map(taskDetails).join("\n\n")
            : sanitize(typeof details === "string" ? details : raw)) +
          reference;
        return block(
          () =>
            `${view.action}${view.name ? ` · ${clean(view.name)}` : ""}\n\nRequest:\n${JSON.stringify(args, null, 2)}\n\n${detail}`,
          context.outputPad,
          true,
        );
      }
      return block(
        () =>
          [
            theme.fg(view.error ? "error" : "toolTitle", view.action) +
              (view.name ? ` · ${theme.bold(clean(view.name))}` : "") +
              (view.level === undefined
                ? ""
                : theme.fg("muted", ` · lvl ${view.level}`)),
            ...(view.lines ?? []).map((line) =>
              theme.fg(view.error ? "error" : "muted", clean(line)),
            ),
          ].join("\n"),
        context.outputPad,
      );
    },
  };
}
