import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderModelSelection } from "../src/model-view.ts";
import type { SetupView } from "../src/setup.ts";

const view: SetupView = {
  phase: "review",
  revision: 2,
  paused: false,
  current: {
    "6": "test/old:low",
    "9": "test/old:high",
  },
  draft: {
    "6": "test/new:low",
    "7": "test/new:medium",
  },
};
describe("model selection panel", () => {
  it("puts draft state and concrete changes before actions without claiming activation", () => {
    const lines = renderModelSelection(view, 140).join("\n");
    expect(lines).toContain("DRAFT 2 — not saved");
    expect(lines.split("\n")[0]!.length).toBeLessThan(80);
    expect(lines).toContain("test/new:low · changed");
    expect(lines).toContain("test/new:medium · new");
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
    for (const [shown, height] of [
      [view, 2],
      [{ ...view, currentError: "invalid JSON" }, 3],
    ] as const) {
      const tiny = renderModelSelection(shown, 120, height).join("\n");
      expect(tiny).toContain("full draft and comparison in transcript");
      expect(tiny).not.toContain("accept · cancel");
    }
    expect(renderModelSelection(undefined, 80)).toEqual([]);
    expect(
      renderModelSelection({ ...view, draft: {} }, 140).join("\n"),
    ).toContain("delegation disabled if accepted");
  });
  it("does not claim a saved ladder before one exists or a draft was committed", () => {
    const requested = renderModelSelection(
      { phase: "working", revision: 1, paused: false },
      160,
    ).join("\n");
    expect(requested).toContain("Preparing");
    expect(requested).not.toContain("saved ladder");
    const researching = {
      phase: "working" as const,
      revision: 1,
      paused: false,
      id: "research",
    };
    expect(renderModelSelection(researching, 160).join("\n")).toContain(
      "Researching · no saved ladder at start",
    );
    expect(
      renderModelSelection({ ...researching, current: view.current }, 160).join(
        "\n",
      ),
    ).toContain("Researching · saved-at-start ladder");
    const broken = renderModelSelection(
      { ...researching, currentError: "bad JSON", paused: true },
      160,
    ).join("\n");
    expect(broken).toContain("Paused · saved-at-start file needs repair");
    expect(broken).not.toContain("Paused · saved ladder");
    const saving = renderModelSelection({ ...view, phase: "saving" }, 160).join(
      "\n",
    );
    expect(saving).not.toContain("not yet saved"); // Publication can precede completion of storage cleanup.
    expect(saving).toContain("cancel before commit");
  });
  it("retains repair and empty-draft warnings ahead of rows even at minimum height", () => {
    const critical = {
      ...view,
      draft: {},
      currentError: "invalid JSON " + "x".repeat(500),
    };
    for (const height of [1, 2, 3, 4, 5, 12]) {
      const lines = renderModelSelection(critical, 120, height);
      const text = lines.join("\n");
      expect(lines.length).toBeLessThanOrEqual(height);
      expect(text).toMatch(/repair/i);
      expect(text).toMatch(/empty draft/i);
      expect(text).toContain("delegation disabled if accepted");
      for (const line of lines)
        expect(visibleWidth(line)).toBeLessThanOrEqual(120);
    }
    // Removed rows used to push the empty-draft consequence out of the panel.
    expect(
      renderModelSelection({ ...view, draft: {} }, 120, 3).join("\n"),
    ).toContain("delegation disabled if accepted");
  });
  it("shows a saved empty ladder as disabled while research or a replacement draft is pending", () => {
    for (const pending of [
      {
        ...view,
        current: {},
        draft: undefined,
        phase: "working" as const,
        id: "research",
      },
      { ...view, current: {} },
    ]) {
      expect(renderModelSelection(pending, 180).join("\n")).toContain(
        "Empty saved-at-start ladder — delegation disabled in baseline",
      );
      expect(renderModelSelection(pending, 180, 1).join("\n")).toContain(
        "EMPTY saved-at-start ladder — delegation disabled in baseline",
      );
    }
  });
  it("sanitizes panel text", () => {
    const unsafe = "\x1b]8;;https://evil.test\x07visible\x1b]8;;\x07\x07\b";
    const lines = renderModelSelection(
      {
        ...view,
        currentError: unsafe,
        draft: { "6": unsafe },
      },
      160,
    ).join("\n");
    expect(lines).toContain("visible");
    expect(lines).not.toMatch(/[\x1b\x07\x08]/);
    expect(lines).not.toContain("evil.test");
  });
});
