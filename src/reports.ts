import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import type { TaskResult, TaskView } from "./coordinator.ts";

export type Report = TaskView | TaskResult;
export type Reports = string | Report | Report[];
export interface Handoff {
  content: string;
  file?: string;
}

/** Model-facing handoff; execution diagnostics stay in native result details. */
export function taskReport(task: Report) {
  return {
    id: task.id,
    description: task.description,
    ...("status" in task
      ? { status: task.status, operation: task.operation }
      : {}),
    outcome: task.outcome,
    ...("reply" in task && task.reply ? { reply: { id: task.reply.id } } : {}),
    response: task.response,
    error: task.error,
    pendingInput: task.pendingInput?.length ? task.pendingInput : undefined,
  };
}

/** Actual text lines, not a report escaped inside one large JSON string. */
function reportText(value: Reports): string {
  if (typeof value === "string") return value;
  return (Array.isArray(value) ? value : [value])
    .map((task) => {
      const { description, response, error, pendingInput, ...identity } =
        taskReport(task);
      return [
        JSON.stringify(identity, null, 2),
        `Task:\n${description}`,
        ...(error === undefined ? [] : [`Error:\n${error}`]),
        `Response:\n${response}`,
        ...(pendingInput ?? []).map((input) => `Pending input:\n${input}`),
      ].join("\n\n");
    })
    .join("\n\n---\n\n");
}

/** Synchronous publication keeps native delivery boundaries free of stale async snapshots.
 * Files are private, content-addressed and atomically published without replacement.
 */
function publish(cwd: string, text: string): string {
  const directory = resolve(cwd, ".pi/pi-sub/reports");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const ignore = resolve(directory, ".gitignore");
  try {
    writeFileSync(ignore, "*\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (readFileSync(ignore, "utf8") !== "*\n")
      throw new Error(`Report directory must remain ignored: ${ignore}`);
  }
  const bytes = Buffer.from(text, "utf8");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const file = resolve(directory, `${digest}.txt`);
  const temporary = resolve(directory, `.${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, bytes);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!readFileSync(file).equals(bytes))
        throw new Error(`Stored report has changed: ${file}`);
    }
  } finally {
    unlinkSync(temporary);
  }
  return file;
}

/** The entire envelope, including the reference, must fit. Never clip serialized JSON. */
export function handoff(
  content: string,
  value: Reports,
  cwd: string,
  limits = { maxBytes: 50 * 1024, maxLines: 2000 },
): Handoff {
  const fits = (text: string) =>
    Buffer.byteLength(text, "utf8") <= limits.maxBytes &&
    text.split("\n").length <= limits.maxLines;
  if (fits(content)) return { content };
  const file = publish(cwd, reportText(value));
  const tasks =
    typeof value === "string" ? [] : Array.isArray(value) ? value : [value];
  const task = tasks.length === 1 ? tasks[0]! : undefined;
  const identity = task
    ? {
        id: task.id,
        ...("status" in task
          ? { status: task.status, operation: task.operation }
          : {}),
        outcome: task.outcome,
      }
    : tasks.length
      ? { count: tasks.length }
      : {};
  const envelope = JSON.stringify({
    ...identity,
    ...(tasks.length
      ? {
          errors: tasks.filter(
            (task) => task.error !== undefined || task.outcome === "error",
          ).length,
        }
      : {}),
    file,
    note: "Full report in file; read as needed.",
  });
  if (!fits(envelope))
    throw new Error("Report reference exceeds the handoff limit");
  return { content: envelope, file };
}

export function reportResult(value: Reports, cwd: string) {
  const raw =
    typeof value === "string"
      ? value
      : JSON.stringify(
          Array.isArray(value) ? value.map(taskReport) : taskReport(value),
        );
  const result = handoff(raw, value, cwd);
  return {
    content: [{ type: "text" as const, text: result.content }],
    details: result.file ? { report: value, handoff: result } : value,
  };
}

function artifact(details: unknown): Handoff | undefined {
  if (!details || typeof details !== "object" || !("handoff" in details))
    return;
  const value = details.handoff;
  if (
    value &&
    typeof value === "object" &&
    "file" in value &&
    typeof value.file === "string" &&
    "content" in value &&
    typeof value.content === "string"
  )
    return value as Handoff;
}

export function reportDetails(details: unknown): unknown {
  return artifact(details) &&
    details &&
    typeof details === "object" &&
    "report" in details
    ? details.report
    : details;
}

/** Delivery proves the exact published reference was in context, not that its file was read. */
export function deliveredFile(details: unknown, content: string): boolean {
  return artifact(details)?.content === content;
}
