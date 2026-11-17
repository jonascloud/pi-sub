import { afterEach, expect, test } from "vitest";
import type { TaskView } from "../src/coordinator.ts";
import { REPORT_CACHE_BYTES, ReportStore } from "../src/report-store.ts";
import {
  captureReport,
  ENVELOPE_BYTES,
  excerpt,
  INLINE_BYTES,
  oneLine,
  PREVIEW_BYTES,
  readReport,
  replyBatch,
  sanitize,
  errorResult,
  toolResult,
} from "../src/reports.ts";

let store = new ReportStore();
afterEach(() => {
  store.dispose();
  store = new ReportStore();
});
const task: TaskView = {
  id: "task-1",
  level: 3,
  description: "Review changes",
  execution: { provider: "p", model: "m", thinking: "off" },
  sessionFile: "native.jsonl",
  status: "ready",
  activity: "",
  turns: 1,
  toolUses: 0,
  tokens: 1,
  elapsedMs: 1,
  response: "Question?\nImportant detail.",
  unsent: 0,
  delivered: false,
};
const capture = (fields: Partial<TaskView> = {}) => {
  const value = { ...task, ...fields };
  return { ...value, ...captureReport(value, store) };
};
function complete(id: string) {
  let text = "",
    offset = 0;
  while (true) {
    const page = store.read(id, offset);
    text += page.text;
    if (page.next === undefined) return text;
    offset = page.next;
  }
}

test("short reports stay inline, with one immutable reference and compact diagnostics", () => {
  const saved = capture();
  const result = toolResult(saved, store);
  expect(JSON.parse(result.content[0]!.text)).toEqual({
    id: task.id,
    description: task.description,
    status: "ready",
    response: task.response,
    report: saved.report,
  });
  expect(saved.report.bytes).toBeLessThan(INLINE_BYTES);
  expect(JSON.parse(complete(saved.report.id))).toMatchObject({
    response: task.response,
  });
  expect(result.details.tasks).toMatchObject([
    {
      id: task.id,
      status: "ready",
      preview: oneLine(task.response),
      report: saved.report,
    },
  ]);
  expect(result.details.tasks[0]).not.toHaveProperty("response");
  expect(JSON.parse(toolResult([], store).content[0]!.text)).toEqual([]);
  const later = capture({ response: "Different answer" });
  expect(later.report.id).not.toBe(saved.report.id);
  expect(JSON.parse(complete(saved.report.id)).response).toBe(task.response);
});

test("only acceptance after delivery omits the reply; inspecting or first accepting still delivers it", () => {
  const saved = capture({
    response: "important evidence ".repeat(70),
    status: "failed",
    error: "failure",
  });
  const body = (view: TaskView) =>
    JSON.parse(toolResult(view, store).content[0]!.text);
  const accepted = { ...saved, status: "accepted" as const };
  expect(body(accepted)).toMatchObject({
    response: saved.response,
    error: saved.error,
    report: saved.report,
  });
  expect(body({ ...saved, delivered: true })).toEqual(body(saved));
  expect(body({ ...accepted, delivered: true })).toEqual({
    id: saved.id,
    status: "accepted",
    report: { id: saved.report.id },
  });
  expect(JSON.parse(complete(saved.report.id)).response).toBe(saved.response);
});

test("large answers and errors leave previews, but all evidence is readable without another model call", () => {
  const response = "Evidence 漢字\n".repeat(3000) + "END_OF_ANSWER";
  const error = "Failure 😀\n".repeat(3000) + "END_OF_ERROR";
  const saved = capture({ status: "failed", response, error, unsent: 2 });
  expect(Buffer.byteLength(saved.response)).toBeLessThanOrEqual(PREVIEW_BYTES);
  expect(Buffer.byteLength(saved.error!)).toBeLessThanOrEqual(240);
  expect(saved.response).toContain("…");
  expect(JSON.parse(complete(saved.report.id))).toMatchObject({
    response,
    error,
    unsent: 2,
  });
  for (const text of [
    toolResult(saved, store).content[0]!.text,
    replyBatch([saved], store).content,
  ]) {
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(ENVELOPE_BYTES);
    expect(text).toContain(saved.report.id);
    expect(text).not.toContain("END_OF_ANSWER");
    expect(text).not.toContain("END_OF_ERROR");
    expect(text).not.toContain("Ask the subagent");
  }
  const batch = replyBatch([saved], store);
  expect(batch.content.indexOf("Failure")).toBeLessThan(
    batch.content.indexOf("Evidence"),
  );
  expect(JSON.stringify(batch.details)).not.toContain("END_OF_ANSWER");
  const page = readReport(store, saved.report.id, 0, 16);
  expect(page.content[0]!.text).toContain("Next: sub_result");
  expect(page.details.report).not.toHaveProperty("text");
});

test("one envelope budget bounds batches and metadata, including JSON escape expansion", () => {
  const tasks = Array.from({ length: 60 }, (_, i) =>
    capture({
      id: `task-${i}`,
      description: "label".repeat(500),
      response: "\x00".repeat(2000),
      error: '"\\\n'.repeat(2000),
      status: "failed",
    }),
  );
  const result = toolResult(tasks, store);
  const batch = replyBatch(tasks, store);
  for (const text of [result.content[0]!.text, batch.content]) {
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(ENVELOPE_BYTES);
    const ref = JSON.parse(text);
    expect(ref.summary).toContain("60");
    const full = complete(ref.report.id);
    expect(full).toContain("task-59");
    expect(full).toContain(tasks[59]!.report.id);
  }
  expect(result.details.tasks).toHaveLength(8);
  expect(batch.details.tasks).toHaveLength(8);
  const all = JSON.parse(
    complete(JSON.parse(result.content[0]!.text).report.id),
  );
  expect(all).toHaveLength(60);
  const error = errorResult("e".repeat(100000), store);
  expect(Buffer.byteLength(error.content[0]!.text)).toBeLessThanOrEqual(
    ENVELOPE_BYTES,
  );
  expect(complete(JSON.parse(error.content[0]!.text).report.id)).toBe(
    "e".repeat(100000),
  );
});

test("packaging an oversized handoff cannot evict the reports needed to read it", () => {
  const tasks = Array.from({ length: 20 }, (_, i) =>
    capture({ id: `t-${i}`, response: "x".repeat(2500) + i }),
  );
  store.put(
    "f".repeat(
      REPORT_CACHE_BYTES - tasks.reduce((n, task) => n + task.report.bytes, 0),
    ),
  );
  for (const text of [
    toolResult(tasks, store).content[0]!.text,
    replyBatch(tasks, store).content,
  ]) {
    const ref = JSON.parse(text).report;
    expect(ref.file).toBeDefined();
    expect(complete(ref.id)).toContain(tasks[0]!.report.id);
    for (const [i, task] of tasks.entries())
      expect(JSON.parse(complete(task.report.id)).response).toBe(
        "x".repeat(2500) + i,
      );
  }
  store.put("z"); // The handoff did not pin or refresh its members.
  expect(() => store.read(tasks[0]!.report.id)).toThrow(
    "Report no longer available",
  );
});

test("pages stay small even for escaped controls and preserve character boundaries", () => {
  const text = '\0\\"\n😀漢'.repeat(3000);
  const ref = store.put(text);
  let offset = 0;
  do {
    const result = readReport(store, ref.id, offset);
    expect(Buffer.byteLength(result.content[0]!.text)).toBeLessThanOrEqual(
      ENVELOPE_BYTES,
    );
    expect(result.content[0]!.text).not.toContain("�");
    const next = result.details.report.next;
    if (next === undefined) break;
    offset = next;
  } while (true);
  expect(complete(ref.id)).toBe(text);
  expect(excerpt("a😀z", 5)).toBe("a…");
  expect(excerpt("exact", 5)).toBe("exact");
  expect(excerpt("a�".repeat(20), 7)).toBe("a�…");
});

test("text for the screen carries no terminal commands or control characters", () => {
  const unsafe =
    "\x1b[31mVisible\x1b[0m\x1b]8;;https://evil.test\x07link\x1b]8;;\x07\x1b_Gpayload\x1b\\\x07\b\r\nnext";
  expect(sanitize(unsafe)).toBe("Visiblelink\nnext");
  expect(oneLine(unsafe)).toBe("Visiblelink next");
  expect(oneLine("x".repeat(500))).toBe("x".repeat(159) + "…");
});
