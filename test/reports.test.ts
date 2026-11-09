import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as fs from "node:fs";
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
  deliveredFile,
  reportDetails,
  reportResult,
  taskReport,
} from "../src/reports.ts";

vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
}));

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pi-sub-reports-"));
});
afterEach(() => {
  vi.restoreAllMocks();
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

test("report paths are reused and earlier reports survive follow-up", () => {
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
  execFileSync("git", ["init", "-q", cwd]);
  expect(
    execFileSync("git", ["-C", cwd, "check-ignore", first.file], {
      encoding: "utf8",
    }).trim(),
  ).toBe(first.file);
});

test("storage failures preserve task state and full details without claiming delivery", () => {
  const value = { ...task, response: "x".repeat(60000) };
  writeFileSync(join(cwd, ".pi"), "not a directory");
  const failed = reportResult(value, cwd);
  expect(failed.isError).toBe(true);
  expect(envelope(failed)).toMatchObject({
    id: value.id,
    status: "ready",
    reportError: expect.any(String),
  });
  expect(envelope(failed)).not.toHaveProperty("file");
  expect(reportDetails(failed.details)).toEqual(value);
  expect(deliveredFile(failed.details, failed.content[0]!.text)).toBe(false);
  expect(() => handoff("x".repeat(60000), value, cwd)).toThrow();
});

test("existing ignore rules are preserved rather than policed", () => {
  const value = { ...task, response: "x".repeat(60000) };
  const ref = envelope(reportResult(value, cwd));
  const ignore = join(dirname(ref.file), ".gitignore");
  const rules = "# Local reports\n*\n";
  writeFileSync(ignore, rules);
  const next = reportResult(
    { ...value, response: value.response + "More" },
    cwd,
  );
  expect(next.isError).not.toBe(true);
  expect(readFileSync(envelope(next).file, "utf8")).toContain(
    value.response + "More",
  );
  expect(readFileSync(ignore, "utf8")).toBe(rules);
});

test("identical reports need no new writes, even when storage is full or read-only", () => {
  const value = { ...task, response: "x".repeat(60000) };
  const first = reportResult(value, cwd);
  const writes = ["mkdirSync", "openSync", "writeFileSync"] as const;
  for (const method of writes)
    vi.spyOn(fs, method).mockImplementation(() => {
      throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    });
  expect(reportResult(value, cwd)).toEqual(first);
  for (const method of writes) expect(fs[method]).not.toHaveBeenCalled();
  expect(readFileSync(envelope(first).file, "utf8")).toContain(value.response);
});

test("failed writes are not cached or returned; a retry writes the complete report", () => {
  const value = { ...task, response: "Complete evidence\n".repeat(6000) };
  const write = fs.writeFileSync;
  vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
    if (typeof file === "number") {
      write(file, "Partial");
      throw new Error("ENOSPC: no space left on device");
    }
    write(file, data, options);
  });
  const failed = reportResult(value, cwd);
  expect(failed.isError).toBe(true);
  expect(envelope(failed)).not.toHaveProperty("file");
  expect(readdirSync(join(cwd, ".pi/pi-sub/reports"))).toEqual([".gitignore"]);
  vi.restoreAllMocks();
  const retry = reportResult(value, cwd);
  expect(retry.isError).not.toBe(true);
  expect(readFileSync(envelope(retry).file, "utf8")).toContain(value.response);
});

test("publication failures retain bounded confirmed state and full diagnostics, not a false handoff", () => {
  const {
    status: _status,
    activity: _activity,
    reply: _reply,
    ...receipt
  } = task;
  const value = {
    ...receipt,
    outcome: "reply" as const,
    response: "x".repeat(60000),
  };
  const reportError = "ENOSPC: no space left on device";
  vi.spyOn(fs, "openSync").mockImplementation(() => {
    throw new Error(reportError);
  });
  const result = reportResult(value, cwd);
  expect(result.isError).toBe(true);
  expect(envelope(result)).toMatchObject({
    id: value.id,
    archived: true,
    outcome: "reply",
    reportError,
  });
  expect(envelope(result)).not.toHaveProperty("file");
  expect(result.details).toEqual({ report: value, reportError });
  expect(Buffer.byteLength(result.content[0]!.text)).toBeLessThanOrEqual(
    50 * 1024,
  );
  const batch = reportResult(
    Array.from({ length: 600 }, (_, i) => ({ ...value, id: `task-${i}` })),
    cwd,
  );
  expect(envelope(batch)).toMatchObject({
    count: 600,
    archived: 600,
    errors: 0,
  });
  expect(Buffer.byteLength(batch.content[0]!.text)).toBeLessThanOrEqual(
    50 * 1024,
  );
});

test("limits cover actual UTF-8 bytes, line counts and the final reference", () => {
  expect(handoff("x".repeat(51200), "full", cwd).file).toBeUndefined();
  expect(handoff("x".repeat(51201), "full", cwd).file).toBeDefined();
  expect(handoff("a\n".repeat(2000), "full", cwd).file).toBeDefined();
  expect(() =>
    handoff("x".repeat(1000), "full", cwd, { maxBytes: 10, maxLines: 1 }),
  ).toThrow("reference exceeds");
});
