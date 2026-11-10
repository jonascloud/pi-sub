import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type { ThinkingLevel };

export const STRENGTH_GUIDANCE =
  "Levels (approximate, not benchmark guarantees): 1–2 mechanical/narrow; 3–4 routine implementation; 5–6 multi-file work/moderate analysis; 7–8 complex design/debugging; 9–10 hardest, highly uncertain work.";
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

const setupGuide = fileURLToPath(
  new URL("../instructions/create-model-ladder.md", import.meta.url),
);
const setupHelp = `Ask an agent to follow ${setupGuide}.`;

/** Native availability is a hard limit; the configured ladder, not parent scope, authorizes delegation. */
export function availableModels(
  ctx: Pick<ExtensionContext, "modelRegistry">,
): AvailableModel[] {
  return ctx.modelRegistry.getAvailable().map((model) => ({
    provider: model.provider,
    model: model.id,
    thinking: getSupportedThinkingLevels(model),
  }));
}

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

/** Runtime configuration is read-only; changes take effect on the next admission. */
export function loadLadder(path: string): Ladder {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`Model ladder missing at ${path}. ${setupHelp}`, {
        cause: error,
      });
    throw error;
  }
  try {
    return validateLadder(JSON.parse(source));
  } catch (error) {
    throw new Error(
      `Invalid model ladder at ${path}: ${error instanceof Error ? error.message : String(error)}. ${setupHelp}`,
      { cause: error },
    );
  }
}

/** Validated integer rungs enumerate in ascending strength order. */
export function availableExecutions(
  ladder: Ladder,
  available: readonly AvailableModel[],
): Execution[] {
  return Object.entries(validateLadder(ladder)).flatMap(([power, entry]) => {
    const reference = parseReference(entry);
    return available.some(
      (a) =>
        a.provider === reference.provider &&
        a.model === reference.model &&
        a.thinking.includes(reference.thinking),
    )
      ? [{ ...reference, power: Number(power) }]
      : [];
  });
}

export function selectExecution(
  ladder: Ladder,
  level: number,
  available: readonly AvailableModel[],
): Execution {
  if (!Number.isInteger(level) || level < 1 || level > 10)
    throw new Error("Level must be an integer from 1 to 10");
  const execution = availableExecutions(ladder, available).find(
    (entry) => entry.power >= level,
  );
  if (execution) return execution;
  throw new Error(
    `No available ladder execution for level ${level}; check ${ladderPath()} and native model availability. ${setupHelp}`,
  );
}

/** A retained execution stays usable while available and configured at or above its level. */
export function checkRetained(
  ladder: Ladder,
  level: number,
  execution: Pick<Execution, "provider" | "model" | "thinking">,
  available: readonly AvailableModel[],
): void {
  const same = (entry: Pick<Execution, "provider" | "model">) =>
    entry.provider === execution.provider && entry.model === execution.model;
  if (
    !available.some((a) => same(a) && a.thinking.includes(execution.thinking))
  )
    throw new Error(
      "The retained execution is no longer available. Stop this subagent instead.",
    );
  if (
    !availableExecutions(ladder, available).some(
      (entry) =>
        entry.power >= level &&
        same(entry) &&
        entry.thinking === execution.thinking,
    )
  )
    throw new Error(
      "The retained execution no longer meets the task's minimum level. Stop this subagent instead.",
    );
}
