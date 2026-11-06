import {
  stripTerminalSequences,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type { SetupView } from "./setup.ts";

const clean = (text: string) =>
  stripTerminalSequences(text).replace(/\s+/g, " ").trim();
const cost = (value: number | null) =>
  value === null
    ? "unknown"
    : `$${new Intl.NumberFormat("en-US", { maximumSignificantDigits: 5, useGrouping: false }).format(value)}`;

/** A persistent, non-modal draft view leaves the normal prompt available. */
export function renderModelSelection(
  view: SetupView | undefined,
  width: number,
  height = 12,
): string[] {
  if (!view || width < 1 || height < 1) return [];
  const phase =
    view.phase === "review"
      ? `DRAFT ${view.revision} — not saved`
      : view.phase === "saving"
        ? "Saving"
        : view.paused
          ? "Paused · saved ladder"
          : view.id
            ? "Researching · saved ladder"
            : "Preparing";
  const lines = [`Model selection · ${phase} · AA reference USD/task`];
  const content: string[] = [];
  if (view.currentError)
    content.push(`Saved file needs repair: ${clean(view.currentError)}`);
  const ladder = view.draft ?? view.current ?? {};
  const levels = [
    ...new Set([
      ...Object.keys(ladder),
      ...Object.keys(view.draft ? (view.current ?? {}) : {}),
    ]),
  ].sort((a, b) => Number(a) - Number(b));
  for (const level of levels) {
    const entry = ladder[level];
    const previous = view.current?.[level];
    if (!entry) {
      content.push(`lvl ${level}  ${clean(previous!.model)} · removed`);
      continue;
    }
    const change = !view.draft
      ? ""
      : !previous
        ? " · new"
        : entry.model !== previous.model || entry.cost !== previous.cost
          ? " · changed"
          : "";
    content.push(
      `lvl ${level}  ${clean(entry.model)} · ${cost(entry.cost)}${change}`,
    );
  }
  if (view.draft && !Object.keys(view.draft).length)
    content.push("Empty draft — delegation disabled if accepted.");
  else if (!levels.length && view.phase !== "working")
    content.push("Empty ladder — delegation disabled.");
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
  if (height === 1) return [truncateToWidth(lines[0]!, width)];
  const room = Math.max(0, height - 2);
  if (content.length <= room) lines.push(...content);
  else if (room > 0) {
    lines.push(...content.slice(0, room - 1));
    lines.push(
      `+${content.length - room + 1} rows · full draft and comparison in transcript`,
    );
  }
  lines.push(footer);
  return lines.map((line) => truncateToWidth(line, width));
}
