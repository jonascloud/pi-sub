import { afterEach, beforeEach, expect, test } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import type { TaskView } from "../src/coordinator.ts";
import {
  handoff,
  reportDetails,
  reportResult,
  taskReport,
} from "../src/reports.ts";

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pi-sub-reports-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});
const task: TaskView = {
  id: "task-1",
  description: "Review",
  level: 3,
  execution: { provider: "test", model: "fake", thinking: "off" },
  sessionFile: "native.jsonl",
  turns: 1,
  toolUses: 0,
  tokens: 1,
  elapsedMs: 1,
  response: "Small response",
  status: "ready",
  outcome: "reply",
  activity: "",
  reply: { id: "reply-1", delivered: false },
};
const envelope = (value: ReturnType<typeof reportResult>) =>
  JSON.parse(value.content[0]!.text);

test("small handoffs stay inline without creating files or changing details", () => {
  const result = reportResult(task, cwd);
  expect(envelope(result)).toEqual(taskReport(task));
  expect(result.details).toEqual(task);
  expect(reportResult("Failure", cwd)).toEqual({
    content: [{ type: "text", text: "Failure" }],
    details: "Failure",
  });
  expect(readdirSync(cwd)).toEqual([]);
});

test("oversized UTF-8 and single-line responses retain identity, errors, pending input and complete readable text", () => {
  for (const response of ["x".repeat(60000), "漢字🙂\n".repeat(5000)]) {
    const value = {
      ...task,
      response,
      error: "Partial failure",
      pendingInput: ["Not sent\nSecond line"],
    };
    const result = reportResult(value, cwd);
    const ref = envelope(result);
    expect(ref).toMatchObject({
      id: task.id,
      status: "ready",
      outcome: "reply",
      errors: 1,
    });
    expect(ref).not.toHaveProperty("response");
    expect(Buffer.byteLength(result.content[0]!.text)).toBeLessThanOrEqual(
      50 * 1024,
    );
    const text = readFileSync(ref.file, "utf8");
    expect(text).toContain("Response:\n" + response);
    expect(text).toContain("Error:\nPartial failure");
    expect(text).toContain("Pending input:\nNot sent\nSecond line");
    expect(reportDetails(result.details)).toEqual(value);
    expect(statSync(ref.file).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(ref.file)).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(dirname(ref.file), ".gitignore"), "utf8")).toBe(
      "*\n",
    );
  }
});

test("large batches use one bounded reference, including all tasks and errors in the file", () => {
  const tasks = Array.from({ length: 600 }, (_, i) => ({
    ...task,
    id: `task-${i}`,
    response: "Report " + i,
    description: "d".repeat(200),
    sessionFile: "/ignored/" + "p".repeat(200),
    ...(i === 599 ? { outcome: "error" as const, error: "Final failure" } : {}),
  }));
  const result = reportResult(tasks, cwd);
  const ref = envelope(result);
  expect(ref).toMatchObject({ count: 600, errors: 1 });
  expect(Buffer.byteLength(result.content[0]!.text)).toBeLessThanOrEqual(
    50 * 1024,
  );
  const text = readFileSync(ref.file, "utf8");
  for (const task of tasks) expect(text).toContain(`"id": "${task.id}"`);
  expect(text).toContain("Final failure");
  expect(
    readdirSync(dirname(ref.file)).filter((name) => name.endsWith(".txt")),
  ).toHaveLength(1);
});

test("files are immutable, reused across delivery bookkeeping changes, and remain readable after completion", () => {
  const value = { ...task, response: "Saved answer\n".repeat(6000) };
  const first = envelope(reportResult(value, cwd));
  const original = readFileSync(first.file, "utf8");
  const again = envelope(
    reportResult(
      { ...value, reply: { ...value.reply!, delivered: true } },
      cwd,
    ),
  );
  expect(again.file).toBe(first.file);
  const next = envelope(
    reportResult(
      {
        ...value,
        response: value.response + "More",
        reply: { id: "reply-2", delivered: false },
      },
      cwd,
    ),
  );
  expect(next.file).not.toBe(first.file);
  expect(readFileSync(first.file, "utf8")).toBe(original);
  expect(
    readdirSync(dirname(first.file)).some((name) => name.endsWith(".tmp")),
  ).toBe(false);
  execFileSync("git", ["init", "-q", cwd]);
  expect(
    execFileSync("git", ["-C", cwd, "check-ignore", first.file], {
      encoding: "utf8",
    }).trim(),
  ).toBe(first.file);
});

test("publication failures never return a reference or overwrite a changed artifact", () => {
  const value = { ...task, response: "x".repeat(60000) };
  const ref = envelope(reportResult(value, cwd));
  writeFileSync(ref.file, "External change");
  expect(() => reportResult(value, cwd)).toThrow("Stored report has changed");
  expect(readFileSync(ref.file, "utf8")).toBe("External change");
  expect(
    readdirSync(dirname(ref.file)).some((name) => name.endsWith(".tmp")),
  ).toBe(false);
  writeFileSync(join(dirname(ref.file), ".gitignore"), "!*\n");
  expect(() => reportResult(value, cwd)).toThrow("must remain ignored");
  rmSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi"), "not a directory");
  expect(() => reportResult(value, cwd)).toThrow();
});

test("limits cover actual UTF-8 bytes, line counts and the final reference", () => {
  expect(handoff("x".repeat(51200), "full", cwd).file).toBeUndefined();
  expect(handoff("x".repeat(51201), "full", cwd).file).toBeDefined();
  expect(handoff("a\n".repeat(2000), "full", cwd).file).toBeDefined();
  expect(() =>
    handoff("x".repeat(1000), "full", cwd, { maxBytes: 10, maxLines: 1 }),
  ).toThrow("reference exceeds");
});
