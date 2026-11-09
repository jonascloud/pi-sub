import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as fs from "node:fs";
import { dirname } from "node:path";
import type { TaskView } from "../src/coordinator.ts";
import {
  deliveredFile,
  handoff,
  reportDetails,
  reportResult,
  taskMetadata,
  taskReport,
} from "../src/reports.ts";
import { Workspace } from "../src/workspace.ts";

vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
}));
let workspace: Workspace;
beforeEach(() => {
  workspace = new Workspace();
});
afterEach(() => {
  vi.restoreAllMocks();
  workspace.dispose();
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

test("inline content is the only full body; diagnostics do not require a workspace directory", () => {
  vi.spyOn(fs, "mkdtempSync").mockImplementation(() => {
    throw new Error("No disk");
  });
  const value = { ...task, pendingInput: ["Unsent correction"] };
  const result = reportResult(value, workspace);
  expect(envelope(result)).toEqual(taskReport(value));
  expect(reportDetails(result.details)).toEqual(taskMetadata(value));
  expect(result.details.report).not.toHaveProperty("response");
  expect(result.details.report).not.toHaveProperty("pendingInput");
  expect(reportDetails(result.details, result.content[0]!.text)).toMatchObject({
    response: value.response,
    pendingInput: value.pendingInput,
  });
  expect(reportResult("Failure", workspace).details).not.toBe("Failure");
});

test.each(["x".repeat(60000), "漢字🙂\n".repeat(5000)])(
  "oversized reports are complete temporary files, not duplicated in history (%#)",
  (response) => {
    const value = {
      ...task,
      response: response + "END_OF_REPORT",
      error: "error\n".repeat(3000) + "END_OF_ERROR",
      pendingInput: ["UNSENT_INSTRUCTION"],
    };
    const result = reportResult(value, workspace);
    const ref = envelope(result);
    expect(ref).toMatchObject({
      id: task.id,
      status: "ready",
      outcome: "reply",
      errors: 1,
    });
    expect(ref.note).toContain("Temporary");
    expect(Buffer.byteLength(result.content[0]!.text)).toBeLessThanOrEqual(
      50 * 1024,
    );
    const text = fs.readFileSync(ref.file, "utf8");
    for (const body of [value.response, value.error, ...value.pendingInput])
      expect(text).toContain(body);
    const stored = JSON.stringify(result.details);
    for (const marker of [
      "END_OF_REPORT",
      "END_OF_ERROR",
      "UNSENT_INSTRUCTION",
    ])
      expect(stored).not.toContain(marker);
    expect(stored.length).toBeLessThan(2000);
    expect(fs.statSync(ref.file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dirname(ref.file)).mode & 0o777).toBe(0o700);
    expect(deliveredFile(result.details, result.content[0]!.text)).toBe(true);
    expect(deliveredFile(result.details, "Partial reference")).toBe(false);
  },
);

test("large batches use one bounded reference", () => {
  const tasks = Array.from({ length: 600 }, (_, i) => ({
    ...task,
    id: `task-${i}`,
    description: "d".repeat(200),
  }));
  const result = reportResult(tasks, workspace);
  const ref = envelope(result);
  expect(ref).toMatchObject({ count: 600, errors: 0 });
  expect(Buffer.byteLength(result.content[0]!.text)).toBeLessThanOrEqual(
    50 * 1024,
  );
  const text = fs.readFileSync(ref.file, "utf8");
  for (const task of tasks) expect(text).toContain(`"id": "${task.id}"`);
});

test("reports survive follow-up within the runtime and are removed with journals at disposal", () => {
  const value = { ...task, response: "Saved answer\n".repeat(6000) };
  const first = envelope(reportResult(value, workspace));
  const again = envelope(
    reportResult(
      { ...value, reply: { ...value.reply!, delivered: true } },
      workspace,
    ),
  );
  expect(again.file).toBe(first.file);
  const next = envelope(
    reportResult({ ...value, response: value.response + "More" }, workspace),
  );
  expect(next.file).not.toBe(first.file);
  expect(fs.readFileSync(first.file, "utf8")).toContain(value.response);
  const sessions = workspace.sessions;
  fs.writeFileSync(sessions + "/journal.jsonl", "history");
  const root = dirname(sessions);
  workspace.dispose();
  expect(fs.existsSync(root)).toBe(false);
  expect(fs.existsSync(first.file)).toBe(false);
  expect(() => workspace.saveReport("later")).toThrow("closed");
  expect(() => workspace.sessions).toThrow("closed");
});

test("workspaces do not share report ownership", () => {
  const other = new Workspace();
  try {
    const first = workspace.saveReport("same report");
    const second = other.saveReport("same report");
    expect(second).not.toBe(first);
    workspace.dispose();
    expect(fs.readFileSync(second, "utf8")).toBe("same report");
  } finally {
    other.dispose();
  }
});

test("cached reports need no further writes", () => {
  const value = { ...task, response: "x".repeat(60000) };
  const first = reportResult(value, workspace);
  const writes = ["mkdirSync", "openSync", "writeFileSync"] as const;
  for (const method of writes)
    vi.spyOn(fs, method).mockImplementation(() => {
      throw new Error("ENOSPC");
    });
  expect(reportResult(value, workspace)).toEqual(first);
  for (const method of writes) expect(fs[method]).not.toHaveBeenCalled();
});

test("failed writes do not yield references or cache partial data; receipts remain the source for retry", () => {
  const value = { ...task, response: "Complete evidence\n".repeat(6000) };
  const write = fs.writeFileSync;
  let partial = "";
  const open = fs.openSync;
  vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
    partial = String(file);
    return open(file, flags, mode);
  });
  vi.spyOn(fs, "writeFileSync").mockImplementation((file) => {
    write(file, "Partial");
    throw new Error("ENOSPC: no space left on device");
  });
  const failed = reportResult(value, workspace);
  expect(failed.isError).toBe(true);
  expect(envelope(failed)).toMatchObject({
    id: value.id,
    status: "ready",
    reportError: expect.stringContaining("ENOSPC"),
  });
  expect(envelope(failed)).not.toHaveProperty("file");
  expect(failed.details.report).not.toHaveProperty("response");
  expect(deliveredFile(failed.details, failed.content[0]!.text)).toBe(false);
  expect(fs.existsSync(partial)).toBe(false);
  vi.restoreAllMocks();
  const retry = reportResult(value, workspace);
  expect(fs.readFileSync(envelope(retry).file, "utf8")).toContain(
    value.response,
  );
});

test("handoff limits cover bytes, lines and the complete reference", () => {
  expect(handoff("x".repeat(51200), "full", workspace).file).toBeUndefined();
  expect(handoff("x".repeat(51201), "full", workspace).file).toBeDefined();
  expect(handoff("a\n".repeat(2000), "full", workspace).file).toBeDefined();
  expect(() =>
    handoff("x".repeat(1000), "full", workspace, { maxBytes: 10, maxLines: 1 }),
  ).toThrow("reference exceeds");
});
