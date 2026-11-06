import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseReference, type AvailableModel, type Ladder } from "./models.ts";

type PickerUI = Pick<ExtensionContext["ui"], "select">;
type PhysicalModel = Pick<AvailableModel, "provider" | "model">;

// Native select uses labels as values. Escape names and prefix rows with unique indices.
function label(value: string): string {
  return JSON.stringify(value).replace(
    /[\u007f-\u009f\u2028\u2029\p{Cf}]/gu,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
const same = (a: PhysicalModel, b: PhysicalModel) =>
  a.provider === b.provider && a.model === b.model;

/** One human selection phase, supported by both native TUI and RPC dialogs. */
export async function chooseModels(
  ui: PickerUI,
  available: readonly AvailableModel[],
  current: Ladder | undefined,
  signal: AbortSignal,
  initialModel?: PhysicalModel,
): Promise<AvailableModel[] | undefined> {
  if (signal.aborted) return undefined;
  const models = structuredClone([...available]);
  const references = Object.entries(current ?? {}).map(([rung, entry]) => ({
    rung,
    reference: parseReference(entry.model),
    text: entry.model,
  }));
  const selected = new Set<number>();
  models.forEach((model, i) => {
    if (
      current !== undefined
        ? references.some(({ reference }) => same(model, reference))
        : initialModel !== undefined && same(model, initialModel)
    )
      selected.add(i);
  });
  const unavailable = references.filter(
    ({ reference }) =>
      !models.some(
        (model) =>
          same(model, reference) && model.thinking.includes(reference.thinking),
      ),
  );
  const warning = unavailable.length
    ? "\nUnavailable saved references (retained until a reviewed change):\n" +
      unavailable
        .map(({ rung, text }) => `  Rung ${label(rung)}: ${label(text)}`)
        .join("\n")
    : "";
  let message = "";
  while (!signal.aborted) {
    const rows = models.map(
      (model, i) =>
        `${i + 1}. [${selected.has(i) ? "x" : " "}] ${label(model.provider)} / ${label(model.model)}`,
    );
    const review = `Review selected models (${selected.size} selected)`;
    let choice: string | undefined;
    try {
      choice = await ui.select(
        `Choose candidate models for ladder research${warning}${message}`,
        [review, ...rows, "Cancel"],
        { signal },
      );
    } catch (error) {
      if (signal.aborted) return undefined;
      throw error;
    }
    if (signal.aborted || choice === undefined || choice === "Cancel")
      return undefined;
    const index = rows.indexOf(choice);
    if (index !== -1) {
      if (selected.has(index)) selected.delete(index);
      else selected.add(index);
      message = "";
    } else if (choice === review) {
      if (selected.size) return models.filter((_, i) => selected.has(i));
      message = models.length
        ? "\nSelect at least one available model to start research."
        : "\nNo models are currently available; research cannot start.";
    }
  }
  return undefined;
}
