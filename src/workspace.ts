import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Scratch data belongs to one active parent runtime, never to saved history. */
export class Workspace {
  private root?: string;
  private closed = false;
  private reports = new Map<string, string>();

  private directory(name: string): string {
    if (this.closed) throw new Error("Subagent workspace has closed");
    this.root ??= mkdtempSync(join(tmpdir(), "pi-sub-"));
    const directory = join(this.root, name);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    return directory;
  }

  get sessions(): string {
    return this.directory("sessions");
  }

  saveReport(text: string): string {
    if (this.closed) throw new Error("Subagent workspace has closed");
    const key = createHash("sha256").update(text).digest("hex");
    const saved = this.reports.get(key);
    if (saved) return saved;
    const file = join(this.directory("reports"), `${randomUUID()}.txt`);
    const fd = openSync(file, "wx", 0o600);
    try {
      try {
        writeFileSync(fd, text, "utf8");
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      unlinkSync(file);
      throw error;
    }
    this.reports.set(key, file);
    return file;
  }

  /** Call only after all owned workers have physically closed. */
  dispose(): void {
    this.closed = true;
    this.reports.clear();
    if (this.root) rmSync(this.root, { recursive: true, force: true });
    this.root = undefined;
  }
}
