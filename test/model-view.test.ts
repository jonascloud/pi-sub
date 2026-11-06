import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderModelSelection } from "../src/model-view.ts";
import type { SetupView } from "../src/setup.ts";

const view: SetupView = {
  phase: "review",
  revision: 2,
  paused: false,
  current: {
    "6": { model: "test/old:low", cost: 0.1 },
    "9": { model: "test/old:high", cost: 1 },
  },
  draft: {
    "6": { model: "test/new:low", cost: 0.2 },
    "7": { model: "test/new:medium", cost: null },
  },
};
describe("model selection panel", () => {
  it("puts draft state and concrete changes before actions without claiming activation", () => {
    const lines = renderModelSelection(view, 140).join("\n");
    expect(lines).toContain("DRAFT 2 — not saved");
    expect(lines).toContain("AA reference USD/task");
    expect(lines).toContain("test/new:low · $0.2 · changed");
    expect(lines).toContain("test/new:medium · unknown · new");
    expect(lines).toContain("test/old:high · removed");
    expect(lines).toContain("accept · cancel");
    expect(lines).not.toContain("unchanged");
  });
  it("shows preparation, pause, publication and repair explicitly", () => {
    expect(
      renderModelSelection(
        { phase: "working", revision: 1, paused: false },
        120,
      ).join("\n"),
    ).toContain("Preparing");
    expect(
      renderModelSelection({ ...view, phase: "working", paused: true }, 120)[0],
    ).toContain("Paused");
    expect(
      renderModelSelection({ ...view, phase: "saving" }, 120).join("\n"),
    ).toContain("Saving");
    expect(
      renderModelSelection({ ...view, currentError: "invalid JSON" }, 120).join(
        "\n",
      ),
    ).toContain("Saved file needs repair");
  });
  it("respects narrow terminals and makes omitted rows discoverable", () => {
    for (const width of [0, 1, 10, 30, 80])
      for (const height of [0, 1, 2, 4, 12]) {
        const lines = renderModelSelection(view, width, height);
        expect(lines.length).toBeLessThanOrEqual(height);
        for (const line of lines)
          expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    expect(renderModelSelection(view, 120, 4).join("\n")).toContain(
      "full draft and comparison in transcript",
    );
    expect(renderModelSelection(undefined, 80)).toEqual([]);
    expect(
      renderModelSelection({ ...view, draft: {} }, 140).join("\n"),
    ).toContain("delegation disabled if accepted");
  });
});
