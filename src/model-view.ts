import {
  stripTerminalSequences,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type { SetupView } from "./setup.ts";

const clean = (text: string) =>
  stripTerminalSequences(text)
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
/** A persistent, non-modal draft view leaves the normal prompt available. */
export function renderModelSelection(
  view: SetupView | undefined,
  width: number,
  height = 12,
): string[] {
  if (!view || width < 1 || height < 1) return [];
  // SetupView.current is the opening snapshot, not a live read of the file.
  const saved = view.currentError
    ? "saved-at-start file needs repair"
    : view.current !== undefined
      ? "saved-at-start ladder"
      : "no saved ladder at start";
  const phase =
    view.phase === "choosing"
      ? "Choose models"
      : view.phase === "review"
        ? `DRAFT ${view.revision} — not saved`
        : view.phase === "saving"
          ? `Saving draft ${view.revision}`
          : view.paused
            ? `Paused · ${saved}`
            : view.id
              ? `Researching · ${saved}`
              : "Preparing";
  const lines = [`Model ladder · ${phase}`];
  const warnings: string[] = [];
  const content: string[] = [];
  if (view.currentError)
    warnings.push(
      `Saved file needs repair (at start): ${clean(view.currentError)}`,
    );
  const draft =
    view.phase === "working" || view.phase === "choosing"
      ? undefined
      : view.draft;
  const ladder = draft ?? view.current ?? {};
  const levels = [
    ...new Set([
      ...Object.keys(ladder),
      ...Object.keys(draft ? (view.current ?? {}) : {}),
    ]),
  ].sort((a, b) => Number(a) - Number(b));
  for (const level of levels) {
    const entry = ladder[level];
    const previous = view.current?.[level];
    if (!entry) {
      content.push(`lvl ${level}  ${clean(previous!)} · removed`);
      continue;
    }
    const change = !draft
      ? ""
      : !previous
        ? " · new"
        : entry !== previous
          ? " · changed"
          : "";
    content.push(`lvl ${level}  ${clean(entry)}${change}`);
  }
  const emptyDraft = draft !== undefined && !Object.keys(draft).length;
  const emptySaved =
    view.current !== undefined && !Object.keys(view.current).length;
  if (emptyDraft)
    warnings.push("Empty draft — delegation disabled if accepted.");
  else if (emptySaved)
    warnings.push(
      "Empty saved-at-start ladder — delegation disabled in baseline.",
    );
  const footer =
    view.phase === "saving"
      ? "cancel before commit"
      : view.phase === "review"
        ? "Refine by prompt · accept · cancel"
        : !view.id
          ? "cancel"
          : view.paused
            ? "Refine to resume · cancel"
            : "Refine by prompt · cancel";
  // Warnings outrank rows and actions. In a tiny panel keep all critical states
  // together, rather than letting removed rows bury an empty draft or repair.
  const critical = [
    view.currentError ? "REPAIR needed at start" : "",
    emptyDraft ? "EMPTY draft — delegation disabled if accepted" : "",
    !emptyDraft && emptySaved
      ? "EMPTY saved-at-start ladder — delegation disabled in baseline"
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
  if (height === 1)
    return [
      truncateToWidth(critical ? `${critical} · ${phase}` : lines[0]!, width),
    ];
  const room = Math.max(0, height - 2);
  if (warnings.length > room) {
    if (room === 0) lines[0] = `${critical} · ${phase}`;
    else lines.push(critical);
  } else {
    lines.push(...warnings);
    const rows = room - warnings.length;
    if (content.length <= rows) lines.push(...content);
    else if (rows > 0) {
      lines.push(...content.slice(0, rows - 1));
      lines.push(
        `+${content.length - rows + 1} rows · full draft and comparison in transcript`,
      );
    }
  }
  lines.push(
    content.length && room <= warnings.length
      ? `+${content.length} rows · full draft and comparison in transcript`
      : footer,
  );
  return lines.map((line) => truncateToWidth(line, width));
}
