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
export interface LadderEntry {
  model: string;
  cost: number | null;
}
export type Ladder = Record<string, LadderEntry>;
export interface Execution {
  provider: string;
  model: string;
  thinking: ThinkingLevel;
  cost: number | null;
  power: number;
}

const thinkingLevels = new Set<string>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export const ladderPath = (): string =>
  join(getAgentDir(), "pi-sub", "models.json");

export function parseReference(
  text: string,
): Pick<Execution, "provider" | "model" | "thinking"> {
  if (typeof text !== "string" || /\s/u.test(text))
    throw new Error(
      "Invalid model reference: expected provider/model:thinking without whitespace",
    );
  const slash = text.indexOf("/");
  const colon = text.lastIndexOf(":");
  if (
    slash <= 0 ||
    colon <= slash + 1 ||
    !thinkingLevels.has(text.slice(colon + 1))
  )
    throw new Error(
      "Invalid model reference: expected provider/model:thinking with explicit native thinking",
    );
  return {
    provider: text.slice(0, slash),
    model: text.slice(slash + 1, colon),
    thinking: text.slice(colon + 1) as ThinkingLevel,
  };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected ladder object");
  return value as Record<string, unknown>;
}

export function validateLadder(value: unknown): Ladder {
  const result: Ladder = {};
  for (const [rung, raw] of Object.entries(object(value))) {
    if (!/^(?:[1-9]|10)$/.test(rung))
      throw new Error(`Invalid ladder rung: ${rung}`);
    const entry = object(raw);
    if (
      Object.keys(entry).length !== 2 ||
      !Object.hasOwn(entry, "model") ||
      !Object.hasOwn(entry, "cost")
    )
      throw new Error(`Rung ${rung} requires exactly model and cost`);
    if (typeof entry.model !== "string")
      throw new Error(`Invalid model at rung ${rung}`);
    parseReference(entry.model);
    const cost = entry.cost;
    if (
      cost !== null &&
      (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)
    )
      throw new Error(`Invalid cost at rung ${rung}`);
    result[rung] = { model: entry.model, cost };
  }
  return result;
}

export function formatLadder(ladder: Ladder): string {
  const valid = validateLadder(ladder);
  const rows = Object.keys(valid)
    .sort((a, b) => Number(a) - Number(b))
    .map((rung) => `  ${JSON.stringify(rung)}: ${JSON.stringify(valid[rung])}`);
  return rows.length ? `{\n${rows.join(",\n")}\n}\n` : "{}\n";
}

export function readLadderSource(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function loadLadder(path: string): Ladder {
  const source = readLadderSource(path);
  if (source === undefined)
    throw new Error("Model ladder missing; run /sub:models");
  try {
    return validateLadder(JSON.parse(source));
  } catch (error) {
    throw new Error("Invalid model ladder; run /sub:models to replace it", {
      cause: error,
    });
  }
}

export async function saveLadder(
  path: string,
  ladder: Ladder,
  expectedSource: string | undefined,
  beforeCommit?: () => void,
): Promise<void> {
  const source = formatLadder(ladder);
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
  const verifySource = () => {
    if (readLadderSource(path) !== expectedSource)
      throw new Error(
        "Model ladder changed; run /sub:models again before replacing it",
      );
  };
  try {
    verifySource();
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(source, "utf8");
    } finally {
      await file.close();
    }
    // Recheck after asynchronous IO, including non-cooperating manual edits.
    verifySource();
    beforeCommit?.();
    // Cancellation/authorization verification and publication must not yield.
    renameSync(temp, path);
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

export function selectExecution(
  ladder: Ladder,
  level: number,
  approved: readonly ApprovedModel[],
): Execution {
  if (!Number.isInteger(level) || level < 1 || level > 10)
    throw new Error("Level must be an integer from 1 to 10");
  const valid = validateLadder(ladder);
  for (let power = level; power <= 10; power++) {
    const entry = valid[String(power)];
    if (!entry) continue;
    const reference = parseReference(entry.model);
    if (
      approved.some(
        (a) =>
          a.provider === reference.provider &&
          a.model === reference.model &&
          a.thinking.includes(reference.thinking),
      )
    )
      return { ...reference, cost: entry.cost, power };
  }
  throw new Error(
    `No approved ladder execution available for level ${level}; run /sub:models`,
  );
}

export function describeLevels(
  ladder: Ladder,
  approved: readonly ApprovedModel[],
): Array<{ level: number; execution?: Execution; error?: string }> {
  return Array.from({ length: 10 }, (_, i) => {
    const level = i + 1;
    try {
      return { level, execution: selectExecution(ladder, level, approved) };
    } catch (error) {
      return {
        level,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}
