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
        ? "Saving confirmed ladder"
        : view.paused
          ? "Paused — send a refinement to resume"
          : "Working — no configuration changed";
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
      ? " · saved at start"
      : !previous
        ? " · new"
        : entry.model !== previous.model || entry.cost !== previous.cost
          ? " · changed"
          : " · unchanged";
    content.push(
      `lvl ${level}  ${clean(entry.model)} · ${cost(entry.cost)}${change}`,
    );
  }
  if (view.draft && !Object.keys(view.draft).length)
    content.push("Empty draft — delegation disabled if accepted.");
  else if (!levels.length)
    content.push(
      view.phase === "working"
        ? "Preparing a proposal. The saved ladder remains active."
        : "Empty ladder — delegation disabled.",
    );
  const footer =
    view.phase === "saving"
      ? "Saving… /sub:models cancel stops only an uncommitted save."
      : "Type a refinement, accept or cancel · /sub:models cancel";
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
