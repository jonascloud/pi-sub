import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ApprovedModel,
  type Catalog,
  REFERENCE_COST,
  catalogPath,
  describeLevels,
  loadCatalog,
  parseCatalog,
  saveCatalog,
  selectExecution,
  validateCatalog,
} from "../src/models.ts";

const approved: ApprovedModel[] = [
  { provider: "p", model: "m", thinking: ["off", "high"] },
];
const catalog: Catalog = {
  version: 1,
  methodVersion: 1,
  generatedAt: "2026-01-01T00:00:00.000Z",
  approved,
  candidates: [
    {
      provider: "p",
      model: "m",
      thinking: "off",
      power: 6,
      cost: REFERENCE_COST,
      score: 30,
      source: "https://example.com/a",
      retrievedAt: "2026-01-01T00:00:00.000Z",
      rationale: "review",
      selected: true,
    },
    {
      provider: "p",
      model: "m",
      thinking: "high",
      power: 9,
      cost: REFERENCE_COST * 2,
      score: 50,
      source: "https://example.com/b",
      retrievedAt: "2026-01-01T00:00:00.000Z",
      rationale: "review",
      selected: true,
    },
  ],
};
describe("catalog", () => {
  it("routes by minimum strength and fixed cost", () => {
    expect(selectExecution(catalog, 1, approved).cost / REFERENCE_COST).toBe(1);
    expect(selectExecution(catalog, 7, approved).cost / REFERENCE_COST).toBe(2);
    expect(() => selectExecution(catalog, 10, approved)).toThrow();
    expect(describeLevels(catalog, approved)[9].error).toBeTruthy();
    expect(
      selectExecution(catalog, 1, [{ ...approved[0], thinking: ["high"] }])
        .thinking,
    ).toBe("high");
  });
  it("rejects invalid input, duplicates and missing coverage", () => {
    const bad = (change: Record<string, unknown>) => ({
      ...catalog,
      ...change,
    });
    expect(() => validateCatalog(bad({ extra: 1 }), approved)).toThrow();
    expect(() =>
      validateCatalog(bad({ candidates: [catalog.candidates[0]] }), approved),
    ).toThrow();
    expect(() =>
      validateCatalog(
        bad({ candidates: [catalog.candidates[0], catalog.candidates[0]] }),
        approved,
      ),
    ).toThrow();
    expect(() =>
      validateCatalog(
        bad({
          candidates: [
            { ...catalog.candidates[0], cost: "1" },
            catalog.candidates[1],
          ],
        }),
        approved,
      ),
    ).toThrow();
    expect(() =>
      validateCatalog(
        bad({
          candidates: [
            { ...catalog.candidates[0], model: "other" },
            catalog.candidates[1],
          ],
        }),
        approved,
      ),
    ).toThrow();
    expect(() =>
      validateCatalog(
        bad({
          candidates: [
            { ...catalog.candidates[0], score: undefined },
            catalog.candidates[1],
          ],
        }),
        approved,
      ),
    ).toThrow();
    expect(
      parseCatalog(`\`\`\`json\n${JSON.stringify(catalog)}\n\`\`\``, approved),
    ).toEqual(catalog);
    expect(() =>
      parseCatalog(`result: ${JSON.stringify(catalog)}`, approved),
    ).toThrow();
  });
  it("writes atomically, validates before replacing and retains historical snapshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "models-"));
    try {
      const path = catalogPath(dir);
      expect(() => loadCatalog(path, approved)).toThrow(/run \/sub:models/);
      await saveCatalog(path, catalog);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      const before = await readFile(path, "utf8");
      await expect(
        saveCatalog(path, { ...catalog, candidates: [] }),
      ).rejects.toThrow();
      await expect(
        saveCatalog(path, catalog, () => {
          throw new Error("approval revoked before commit");
        }),
      ).rejects.toThrow("approval revoked");
      expect(await readFile(path, "utf8")).toBe(before);
      expect(loadCatalog(path, [])).toEqual(catalog);
      expect(() => selectExecution(loadCatalog(path, []), 1, [])).toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
