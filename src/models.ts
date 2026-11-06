import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { readFileSync } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type { ThinkingLevel };
export interface ApprovedModel {
  provider: string;
  model: string;
  thinking: ThinkingLevel[];
}
export interface Execution {
  provider: string;
  model: string;
  thinking: ThinkingLevel;
  cost: number;
  power: number;
}
export interface Candidate {
  provider: string;
  model: string;
  thinking: ThinkingLevel;
  power?: number;
  cost?: number;
  score?: number;
  source?: string;
  retrievedAt?: string;
  rationale: string;
  selected: boolean;
}
export interface Catalog {
  version: 1;
  methodVersion: 1;
  generatedAt: string;
  approved: ApprovedModel[];
  candidates: Candidate[];
}
export const METHOD_VERSION = 1;
export const REFERENCE_COST = 0.07141741932294249;
export const catalogPath = (cwd: string): string =>
  join(cwd, ".pi", "pi-sub", "models.json");
const levels = new Set<string>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected object");
  const o = value as Record<string, unknown>;
  for (const key of Object.keys(o))
    if (!keys.includes(key)) throw new Error(`Unknown key: ${key}`);
  return o;
}
function str(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim())
    throw new Error(`Invalid ${name}`);
  return value;
}
function date(value: unknown): string {
  const s = str(value, "timestamp");
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(s) ||
    !Number.isFinite(Date.parse(s))
  )
    throw new Error("Invalid ISO timestamp");
  return s;
}
function thinking(value: unknown): ThinkingLevel {
  const s = str(value, "thinking");
  if (!levels.has(s)) throw new Error(`Invalid thinking: ${s}`);
  return s as ThinkingLevel;
}
function identity(provider: string, model: string, level: string): string {
  return JSON.stringify([provider, model, level]);
}
function approvedModels(value: unknown): ApprovedModel[] {
  if (!Array.isArray(value)) throw new Error("Invalid approved models");
  const seen = new Set<string>();
  return value.map((entry) => {
    const o = object(entry, ["provider", "model", "thinking"]);
    const provider = str(o.provider, "provider"),
      model = str(o.model, "model");
    if (!Array.isArray(o.thinking) || !o.thinking.length)
      throw new Error("Invalid approved thinking");
    const ts = o.thinking.map(thinking);
    for (const t of ts) {
      const key = identity(provider, model, t);
      if (seen.has(key)) throw new Error("Duplicate approved variant");
      seen.add(key);
    }
    return { provider, model, thinking: ts };
  });
}
function tuples(approved: readonly ApprovedModel[]): Set<string> {
  return new Set(
    approved.flatMap((m) =>
      m.thinking.map((t) => identity(m.provider, m.model, t)),
    ),
  );
}
export function validateCatalog(
  value: unknown,
  approved: readonly ApprovedModel[],
): Catalog {
  const o = object(value, [
    "version",
    "methodVersion",
    "generatedAt",
    "approved",
    "candidates",
  ]);
  if (o.version !== 1 || o.methodVersion !== METHOD_VERSION)
    throw new Error("Unsupported catalog version");
  const snapshot = approvedModels(o.approved),
    expected = tuples(approvedModels(approved));
  const allowed = tuples(snapshot);
  if (
    allowed.size !== expected.size ||
    [...allowed].some((k) => !expected.has(k))
  )
    throw new Error("Approved snapshot does not match approved models");
  if (!Array.isArray(o.candidates)) throw new Error("Invalid candidates");
  const seen = new Set<string>();
  const candidates: Candidate[] = o.candidates.map((entry: unknown) => {
    const c = object(entry, [
      "provider",
      "model",
      "thinking",
      "power",
      "cost",
      "score",
      "source",
      "retrievedAt",
      "rationale",
      "selected",
    ]);
    const provider = str(c.provider, "provider"),
      model = str(c.model, "model"),
      t = thinking(c.thinking);
    const key = identity(provider, model, t);
    if (!allowed.has(key))
      throw new Error("Unapproved or unsupported candidate");
    if (seen.has(key)) throw new Error("Duplicate candidate");
    seen.add(key);
    if (typeof c.selected !== "boolean") throw new Error("Invalid selected");
    const result: Candidate = {
      provider,
      model,
      thinking: t,
      rationale: str(c.rationale, "rationale"),
      selected: c.selected,
    };
    if (c.power !== undefined) {
      if (
        typeof c.power !== "number" ||
        !Number.isInteger(c.power) ||
        c.power < 1 ||
        c.power > 10
      )
        throw new Error("Invalid power");
      result.power = c.power;
    }
    for (const field of ["cost", "score"] as const)
      if (c[field] !== undefined) {
        const n = c[field];
        if (
          typeof n !== "number" ||
          !Number.isFinite(n) ||
          (field === "cost" && n <= 0)
        )
          throw new Error(`Invalid ${field}`);
        result[field] = n;
      }
    if (c.source !== undefined) {
      const source = str(c.source, "source");
      let url: URL;
      try {
        url = new URL(source);
      } catch {
        throw new Error("Invalid source URL");
      }
      if (url.protocol !== "https:") throw new Error("Source must use https");
      result.source = source;
    }
    if (c.retrievedAt !== undefined) result.retrievedAt = date(c.retrievedAt);
    if (
      result.selected &&
      (result.power === undefined ||
        result.cost === undefined ||
        result.score === undefined ||
        !result.source ||
        !result.retrievedAt)
    )
      throw new Error("Selected candidate requires complete evidence");
    return result;
  });
  if (seen.size !== allowed.size)
    throw new Error("Missing approved candidate coverage");
  return {
    version: 1,
    methodVersion: 1,
    generatedAt: date(o.generatedAt),
    approved: snapshot,
    candidates,
  };
}
export function parseCatalog(
  text: string,
  approved: readonly ApprovedModel[],
): Catalog {
  let body = text.trim();
  const fence = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(body);
  if (fence) body = fence[1];
  return validateCatalog(JSON.parse(body), approved);
}
export function selectExecution(
  catalog: Catalog,
  level: number,
  approved: readonly ApprovedModel[],
): Execution {
  if (!Number.isInteger(level) || level < 1 || level > 10)
    throw new Error("Level must be an integer from 1 to 10");
  const allowed = tuples(approved);
  const eligible = catalog.candidates.filter(
    (c) =>
      c.selected &&
      c.power !== undefined &&
      c.power >= level &&
      c.cost !== undefined &&
      allowed.has(identity(c.provider, c.model, c.thinking)),
  );
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  eligible.sort(
    (a, b) =>
      a.cost! - b.cost! ||
      b.power! - a.power! ||
      cmp(a.provider, b.provider) ||
      cmp(a.model, b.model) ||
      cmp(a.thinking, b.thinking),
  );
  const c = eligible[0];
  if (!c)
    throw new Error(
      `No approved selected execution available for level ${level}; run /sub:models to refresh`,
    );
  return {
    provider: c.provider,
    model: c.model,
    thinking: c.thinking,
    cost: c.cost!,
    power: c.power!,
  };
}
export function describeLevels(
  catalog: Catalog,
  approved: readonly ApprovedModel[],
): Array<{ level: number; execution?: Execution; error?: string }> {
  return Array.from({ length: 10 }, (_, i) => {
    const level = i + 1;
    try {
      return { level, execution: selectExecution(catalog, level, approved) };
    } catch (e) {
      return { level, error: e instanceof Error ? e.message : String(e) };
    }
  });
}
export function loadCatalog(path: string): Catalog {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error("Model catalog missing; run /sub:models");
    throw e;
  }
  const raw: unknown = JSON.parse(text);
  const snapshot = object(raw, [
    "version",
    "methodVersion",
    "generatedAt",
    "approved",
    "candidates",
  ]).approved;
  return validateCatalog(raw, approvedModels(snapshot));
}
export async function saveCatalog(
  path: string,
  catalog: Catalog,
  beforeCommit?: () => void,
): Promise<void> {
  const valid = validateCatalog(catalog, catalog.approved);
  const data = JSON.stringify(valid, null, 2) + "\n";
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(data, "utf8");
    } finally {
      await file.close();
    }
    beforeCommit?.();
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}
