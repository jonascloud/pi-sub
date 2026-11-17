import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const REPORT_CACHE_BYTES = 16 * 1024 * 1024;
export const REPORT_READ_BYTES = 4096;

export interface ReportRef {
  id: string;
  bytes: number;
  file?: string;
}

type Entry =
  { bytes: number; buffer: Buffer } | { bytes: number; file: string };

export class ReportStore {
  private readonly entries = new Map<string, Entry>();
  private memoryBytes = 0;
  private directory?: string;
  private disposed = false;

  /** An envelope must not evict the reports it hands off. No lasting pins. */
  put(text: string, references?: ReadonlySet<string>): ReportRef {
    if (this.disposed) throw new Error("Report store disposed");
    const buffer = Buffer.from(text, "utf8");
    const bytes = buffer.length;
    const id = `report-${randomUUID()}`;
    let excess = this.memoryBytes + bytes - REPORT_CACHE_BYTES;
    const victims: string[] = [];
    if (bytes <= REPORT_CACHE_BYTES && excess > 0) {
      for (const [oldId, entry] of this.entries) {
        if (!("buffer" in entry)) continue;
        if (references?.has(oldId)) break; // Spill instead of breaking FIFO.
        victims.push(oldId);
        excess -= entry.bytes;
        if (excess <= 0) break;
      }
    }
    if (excess > 0) {
      this.directory ??= mkdtempSync(join(tmpdir(), "pi-sub-reports-"));
      const file = join(this.directory, id);
      // Publish only after the write succeeds. The private directory also
      // owns any partial file left by a failed write until teardown.
      writeFileSync(file, buffer, { mode: 0o600, flag: "wx" });
      this.entries.set(id, { bytes, file });
      return { id, bytes, file };
    }
    for (const oldId of victims) {
      this.memoryBytes -= this.entries.get(oldId)!.bytes;
      this.entries.delete(oldId);
    }
    this.entries.set(id, { bytes, buffer });
    this.memoryBytes += bytes;
    return { id, bytes };
  }

  read(
    id: string,
    offset = 0,
    limit = REPORT_READ_BYTES,
  ): {
    id: string;
    bytes: number;
    offset: number;
    next?: number;
    text: string;
  } {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("Report no longer available");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > entry.bytes)
      throw new RangeError("Invalid report offset");
    if (!Number.isSafeInteger(limit) || limit < 4 || limit > REPORT_READ_BYTES)
      throw new RangeError("Invalid report limit");
    const length = Math.min(limit + 1, entry.bytes - offset);
    let chunk: Buffer;
    if ("buffer" in entry) {
      chunk = entry.buffer.subarray(offset, offset + length);
    } else {
      chunk = Buffer.alloc(length);
      const fd = openSync(entry.file, "r");
      try {
        let read = 0;
        while (read < length) {
          const n = readSync(fd, chunk, read, length - read, offset + read);
          if (n === 0) throw new Error("Report file truncated");
          read += n;
        }
      } finally {
        closeSync(fd);
      }
    }
    const continuation = (byte: number) => (byte & 0xc0) === 0x80;
    if (chunk.length && continuation(chunk[0]))
      throw new RangeError("Report offset is not a UTF-8 boundary");
    let end = Math.min(limit, chunk.length);
    while (end < chunk.length && continuation(chunk[end])) end--;
    const next = offset + end;
    return {
      id,
      bytes: entry.bytes,
      offset,
      ...(next < entry.bytes ? { next } : {}),
      text: chunk.toString("utf8", 0, end),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    if (this.directory)
      rmSync(this.directory, { recursive: true, force: true });
    this.entries.clear();
    this.memoryBytes = 0;
    this.disposed = true;
  }
}
