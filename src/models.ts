import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { lock } from "proper-lockfile";
import { readFileSync, renameSync } from "node:fs";
import { mkdir, open, unlink } from "node:fs/promises";
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
}
export interface Catalog {
  version: 2;
  methodVersion: 1;
  generatedAt: string;
  candidates: Candidate[];
}
export const METHOD_VERSION = 1;
export const REFERENCE_COST = 0.07141741932294249;
export const catalogPath = (): string =>
  join(getAgentDir(), "pi-sub", "models.json");
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
export function validateCatalog(value: unknown): Catalog {
  const o = object(value, [
    "version",
    "methodVersion",
    "generatedAt",
    "candidates",
  ]);
  if (o.version !== 2 || o.methodVersion !== METHOD_VERSION)
    throw new Error("Unsupported catalog version");
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
    ]);
    const provider = str(c.provider, "provider"),
      model = str(c.model, "model"),
      t = thinking(c.thinking);
    const key = identity(provider, model, t);
    if (seen.has(key)) throw new Error("Duplicate candidate");
    seen.add(key);
    const result: Candidate = {
      provider,
      model,
      thinking: t,
      rationale: str(c.rationale, "rationale"),
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
    return result;
  });
  return {
    version: 2,
    methodVersion: 1,
    generatedAt: date(o.generatedAt),
    candidates,
  };
}
export function parseProposal(
  text: string,
  approved: readonly ApprovedModel[],
): Catalog {
  let body = text.trim();
  const fence = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(body);
  if (fence) body = fence[1];
  const proposal = object(JSON.parse(body), [
    "version",
    "methodVersion",
    "generatedAt",
    "approved",
    "candidates",
  ]);
  const expected = tuples(approvedModels(approved));
  const snapshot = tuples(approvedModels(proposal.approved));
  if (
    !expected.size ||
    expected.size !== snapshot.size ||
    [...snapshot].some((key) => !expected.has(key))
  )
    throw new Error("Approved snapshot does not match approved models");
  const { approved: _snapshot, ...raw } = proposal;
  const catalog = validateCatalog(raw);
  if (
    catalog.candidates.length !== expected.size ||
    catalog.candidates.some(
      (c) => !expected.has(identity(c.provider, c.model, c.thinking)),
    )
  )
    throw new Error("Missing approved candidate coverage or foreign candidate");
  return catalog;
}
type EvidencedCandidate = Candidate &
  Required<
    Pick<Candidate, "power" | "cost" | "score" | "source" | "retrievedAt">
  >;

export function hasEvidence(
  candidate: Candidate,
): candidate is EvidencedCandidate {
  if (
    [
      candidate.power,
      candidate.cost,
      candidate.score,
      candidate.source,
      candidate.retrievedAt,
    ].some((value) => value === undefined)
  )
    return false;
  try {
    validateCatalog({
      version: 2,
      methodVersion: METHOD_VERSION,
      generatedAt: candidate.retrievedAt,
      candidates: [candidate],
    });
    return true;
  } catch {
    return false;
  }
}

export function selectExecution(
  catalog: Catalog,
  level: number,
  approved: readonly ApprovedModel[],
): Execution {
  if (!Number.isInteger(level) || level < 1 || level > 10)
    throw new Error("Level must be an integer from 1 to 10");
  const allowed = tuples(approved);
  const eligible = catalog.candidates
    .filter(hasEvidence)
    .filter(
      (c) =>
        c.power >= level &&
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
      `No approved evidenced execution available for level ${level}; run /sub:models to refresh`,
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
  return validateCatalog(JSON.parse(text));
}
export async function saveCatalog(
  path: string,
  update: Catalog,
  beforeCommit?: () => void,
): Promise<Catalog> {
  const valid = validateCatalog(update);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const ignore = await open(join(dirname(path), ".gitignore"), "wx", 0o600);
    try {
      await ignore.writeFile("*\n", "utf8");
    } finally {
      await ignore.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const release = await lock(path, {
    realpath: false,
    retries: { retries: 12, factor: 1, minTimeout: 100, maxTimeout: 100 },
  });
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    let current: Catalog | undefined;
    try {
      // Only a missing file is a new catalog; invalid existing data must survive.
      current = validateCatalog(JSON.parse(readFileSync(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const candidates = new Map(
      current?.candidates.map((c) => [
        identity(c.provider, c.model, c.thinking),
        c,
      ]),
    );
    for (const c of valid.candidates)
      candidates.set(identity(c.provider, c.model, c.thinking), c);
    const merged: Catalog = {
      ...valid,
      generatedAt:
        current &&
        Date.parse(current.generatedAt) > Date.parse(valid.generatedAt)
          ? current.generatedAt
          : valid.generatedAt,
      candidates: [...candidates.values()],
    };
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(merged, null, 2) + "\n", "utf8");
    } finally {
      await file.close();
    }
    beforeCommit?.();
    // Keep final approval/cancellation verification and publication in one JS turn.
    renameSync(temp, path);
    return merged;
  } finally {
    try {
      await unlink(temp).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    } finally {
      await release();
    }
  }
}
