import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { lock } from "proper-lockfile";
import { readFileSync, renameSync } from "node:fs";
import { mkdir, open, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type { ThinkingLevel };

export const STRENGTH_GUIDANCE =
  "Strength is an approximate relative local scale, not a benchmark guarantee or a scale with equal numeric distances: 1–2 mechanical or narrow work; 3–4 bounded routine implementation; 5–6 multi-file work or moderate analysis; 7–8 complex design or debugging; 9–10 the hardest work with high uncertainty.";
export interface AvailableModel {
  provider: string;
  model: string;
  thinking: ThinkingLevel[];
}
export type Ladder = Record<string, string>;
export interface Execution {
  provider: string;
  model: string;
  thinking: ThinkingLevel;
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
  join(getAgentDir(), "pi-sub-config.json");

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
    if (typeof raw !== "string")
      throw new Error(`Invalid model at rung ${rung}`);
    parseReference(raw);
    result[rung] = raw;
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

/** Resolve only after publication; returned cleanup warnings do not undo the save. */
export async function saveLadder(
  path: string,
  ladder: Ladder,
  expectedSource: string | undefined,
  beforeCommit?: () => void,
): Promise<unknown[]> {
  const source = formatLadder(ladder);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
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
  let committed = false;
  let failure: unknown;
  let failed = false;
  const cleanupWarnings: unknown[] = [];
  try {
    verifySource();
    // Serialize cooperative saves so they cannot append duplicate ignore rules.
    const ignore = await open(join(dirname(path), ".gitignore"), "a+", 0o600);
    try {
      const contents = await ignore.readFile("utf8");
      const rule = `/${basename(path).replace(/[\\*?\[\]#! ]/g, "\\$&")}`;
      const last = contents
        .split(/\r?\n/)
        .findLast((line) => line && !line.startsWith("#"));
      if (last !== rule)
        await ignore.appendFile(
          `${contents && !contents.endsWith("\n") ? "\n" : ""}${rule}\n`,
          "utf8",
        );
    } finally {
      await ignore.close();
    }
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
    committed = true;
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    if (!committed) {
      try {
        await unlink(temp);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          cleanupWarnings.push(error);
      }
    }
    try {
      await release();
    } catch (error) {
      cleanupWarnings.push(error);
    }
  }
  if (failed) {
    if (cleanupWarnings.length)
      throw new AggregateError(
        [failure, ...cleanupWarnings],
        "Model ladder save and cleanup failed",
        { cause: failure },
      );
    throw failure;
  }
  return cleanupWarnings;
}

export function selectExecution(
  ladder: Ladder,
  level: number,
  available: readonly AvailableModel[],
): Execution {
  if (!Number.isInteger(level) || level < 1 || level > 10)
    throw new Error("Level must be an integer from 1 to 10");
  const valid = validateLadder(ladder);
  for (let power = level; power <= 10; power++) {
    const entry = valid[String(power)];
    if (!entry) continue;
    const reference = parseReference(entry);
    if (
      available.some(
        (a) =>
          a.provider === reference.provider &&
          a.model === reference.model &&
          a.thinking.includes(reference.thinking),
      )
    )
      return { ...reference, power };
  }
  throw new Error(
    `No available ladder execution for level ${level}; run /sub:models`,
  );
}

export function describeLevels(
  ladder: Ladder,
  available: readonly AvailableModel[],
): Array<{ level: number; execution?: Execution; error?: string }> {
  return Array.from({ length: 10 }, (_, i) => {
    const level = i + 1;
    try {
      return { level, execution: selectExecution(ladder, level, available) };
    } catch (error) {
      return {
        level,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}
