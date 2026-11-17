import { existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REPORT_CACHE_BYTES,
  REPORT_READ_BYTES,
  ReportStore,
} from "../src/report-store.ts";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, writeFileSync: vi.fn(fs.writeFileSync) };
});
import { writeFileSync } from "node:fs";

let store = new ReportStore();
afterEach(() => {
  store.dispose();
  store = new ReportStore();
  vi.restoreAllMocks();
});

describe("ReportStore", () => {
  it("accounts for UTF-8 and pages without splitting characters, including controls and EOF", () => {
    const value = "a😀\n\0é漢z";
    const ref = store.put(value);
    expect(ref.bytes).toBe(Buffer.byteLength(value));
    let offset = 0;
    let result = "";
    do {
      const page = store.read(ref.id, offset, 4);
      result += page.text;
      if (page.next === undefined) break;
      expect(page.next).toBeGreaterThan(offset);
      offset = page.next;
    } while (true);
    expect(result).toBe(value);
    expect(store.read(ref.id, ref.bytes)).toEqual({
      id: ref.id,
      bytes: ref.bytes,
      offset: ref.bytes,
      text: "",
    });
    const empty = store.put("");
    expect(store.read(empty.id).text).toBe("");
    expect(() => store.read(ref.id, 2)).toThrow(/boundary/);
    for (const bad of [-1, 1.5, NaN, Infinity, ref.bytes + 1])
      expect(() => store.read(ref.id, bad)).toThrow();
    for (const bad of [0, 3, 4.5, NaN, REPORT_READ_BYTES + 1])
      expect(() => store.read(ref.id, 0, bad)).toThrow();
    expect(() => store.read("missing")).toThrow("Report no longer available");
  });

  it("enforces the exact memory budget in insertion order, not read order", () => {
    const first = store.put("a");
    const second = store.put("b");
    const bulk = store.put("x".repeat(REPORT_CACHE_BYTES - 2));
    expect(store.read(first.id).text).toBe("a");
    store.put("z");
    expect(() => store.read(first.id)).toThrow("Report no longer available");
    expect(store.read(second.id).text).toBe("b");
    expect(store.read(bulk.id).text.length).toBe(REPORT_READ_BYTES);
    const full = store.put("q".repeat(REPORT_CACHE_BYTES));
    expect(full.file).toBeUndefined();
    expect(() => store.read(second.id)).toThrow();
    expect(() => store.read(bulk.id)).toThrow();
  });

  it("spills oversized reports privately, pages them, and removes them on disposal", () => {
    const value = "x".repeat(REPORT_CACHE_BYTES - 1) + "😀abc";
    const ref = store.put(value);
    expect(ref.file).toBeDefined();
    expect(statSync(ref.file!).mode & 0o777).toBe(0o600);
    expect(store.read(ref.id, REPORT_CACHE_BYTES - 1, 4)).toMatchObject({
      text: "😀",
      next: REPORT_CACHE_BYTES + 3,
    });
    expect(() => store.read(ref.id, REPORT_CACHE_BYTES)).toThrow(/boundary/);
    store.put("y".repeat(REPORT_CACHE_BYTES));
    expect(existsSync(ref.file!)).toBe(true);
    const dir = dirname(ref.file!);
    store.dispose();
    store.dispose();
    expect(existsSync(dir)).toBe(false);
    expect(() => store.read(ref.id)).toThrow("Report no longer available");
    expect(() => store.put("new")).toThrow();
  });

  it("does not publish failed spills and cleans up on disposal", () => {
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw new Error("write failed");
    });
    expect(() => store.put("x".repeat(REPORT_CACHE_BYTES + 1))).toThrow(
      "write failed",
    );
    const ref = store.put("x".repeat(REPORT_CACHE_BYTES + 1));
    expect(existsSync(ref.file!)).toBe(true);
    store.dispose();
    expect(existsSync(dirname(ref.file!))).toBe(false);
  });

  it("creates distinct immutable references", () => {
    const a = store.put("same");
    const b = store.put("same");
    expect(a.id).toMatch(/^report-[0-9a-f-]{36}$/);
    expect(a.id).not.toBe(b.id);
    a.bytes = 0;
    a.id = "other";
    expect(store.read(b.id).text).toBe("same");
  });
});
