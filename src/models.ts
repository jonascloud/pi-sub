import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";

export type { ThinkingLevel };

export const STRENGTH_GUIDANCE =
  "Levels (approximate, not benchmark guarantees): 1–2 mechanical/narrow; 3–4 routine implementation; 5–6 multi-file work/moderate analysis; 7–8 complex design/debugging; 9–10 hardest, highly uncertain work.";
export interface AvailableModel {
  provider: string;
  model: string;
  thinking: ThinkingLevel[];
}
export type Ladder = readonly Execution[];
export interface Execution {
  provider: string;
  model: string;
  thinking: ThinkingLevel;
  power: number;
}

// Pi's extension loader does not expose pi-ai/providers/model-schema.
const thinkingLevels = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

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

function parseReference(
  text: string,
): Pick<Execution, "provider" | "model" | "thinking"> {
  if (/\s/u.test(text))
    throw new Error(
      "Invalid model reference: expected provider/model:thinking without whitespace",
    );
  const slash = text.indexOf("/");
  const colon = text.lastIndexOf(":");
  const thinking = thinkingLevels.find(
    (level) => level === text.slice(colon + 1),
  );
  if (slash <= 0 || colon <= slash + 1 || !thinking)
    throw new Error(
      "Invalid model reference: expected provider/model:thinking with explicit native thinking",
    );
  return {
    provider: text.slice(0, slash),
    model: text.slice(slash + 1, colon),
    thinking,
  };
}

function object(value: unknown, key: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Expected ${key} to be an object`);
  return value as Record<string, unknown>;
}

function validateLadder(value: unknown): Ladder {
  const result: Execution[] = [];
  for (const [rung, raw] of Object.entries(object(value, "piSub.ladder"))) {
    if (!/^(?:[1-9]|10)$/.test(rung))
      throw new Error(`Invalid ladder rung: ${rung}`);
    if (typeof raw !== "string")
      throw new Error(`Invalid model at rung ${rung}`);
    result.push({ ...parseReference(raw), power: Number(rung) });
  }
  return result.sort((a, b) => a.power - b.power);
}

/** Pi owns settings scope, trust, merging and reload. */
export function loadLadder(settings: object): Ladder {
  try {
    if ("piSub" in settings) {
      const { ladder } = object(settings.piSub, "piSub");
      if (ladder !== undefined) {
        const entries = validateLadder(ladder);
        if (entries.length) return entries;
      }
    }
  } catch (error) {
    throw new Error(
      `Invalid model ladder in settings.json: ${error instanceof Error ? error.message : String(error)}. ${setupHelp}`,
      { cause: error },
    );
  }
  throw new Error(
    `No model ladder configured (piSub.ladder in settings.json). ${setupHelp}`,
  );
}

/** Filter the validated ladder without changing its strength order. */
export function availableExecutions(
  ladder: Ladder,
  available: readonly AvailableModel[],
): Execution[] {
  return ladder.filter((entry) =>
    available.some(
      (a) =>
        a.provider === entry.provider &&
        a.model === entry.model &&
        a.thinking.includes(entry.thinking),
    ),
  );
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
    `No available ladder execution for level ${level}; check piSub.ladder in settings.json and native model availability. ${setupHelp}`,
  );
}
