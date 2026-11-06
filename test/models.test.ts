import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import {
  type ApprovedModel,
  type Candidate,
  type Catalog,
  REFERENCE_COST,
  catalogPath,
  describeLevels,
  hasEvidence,
  loadCatalog,
  parseProposal,
  saveCatalog,
  selectExecution,
  validateCatalog,
} from "../src/models.ts";

const approved: ApprovedModel[] = [
  { provider: "p", model: "m", thinking: ["off", "xhigh"] },
];
const evidence: Candidate = {
  provider: "p",
  model: "m",
  thinking: "off",
  power: 6,
  cost: REFERENCE_COST,
  score: 30,
  source: "https://example.com/a",
  retrievedAt: "2026-01-01T00:00:00.000Z",
  rationale: "review",
};
function catalog(candidates: Candidate[] = [evidence]): Catalog {
  return {
    version: 2,
    methodVersion: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    candidates,
  };
}
const negative: Candidate = {
  provider: "p",
  model: "m",
  thinking: "off",
  rationale: "No credible evidence",
};
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "models-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "profile"));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe("global catalog", () => {
  it("uses only the current Pi profile regardless of cwd and never falls back", async () => {
    const original = process.cwd();
    const path = catalogPath();
    const project = join(dir, "project");
    await mkdir(join(project, ".pi", "pi-sub"), { recursive: true });
    await writeFile(
      join(project, ".pi", "pi-sub", "models.json"),
      JSON.stringify(catalog()),
    );
    try {
      process.chdir(project);
      expect(catalogPath()).toBe(path);
      expect(() => loadCatalog(catalogPath())).toThrow(/run \/sub:models/);
      await saveCatalog(path, catalog());
      vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "other-profile"));
      expect(catalogPath()).toBe(
        join(dir, "other-profile", "pi-sub", "models.json"),
      );
      expect(() => loadCatalog(catalogPath())).toThrow(/run \/sub:models/);
    } finally {
      process.chdir(original);
    }
  });

  it("separates credible evidence from current approval and economic selection", () => {
    const high = {
      ...evidence,
      thinking: "xhigh" as const,
      power: 9,
      cost: REFERENCE_COST * 2,
    };
    const c = catalog([evidence, high, { ...negative, model: "negative" }]);
    expect(hasEvidence(evidence)).toBe(true);
    for (const field of [
      "power",
      "cost",
      "score",
      "source",
      "retrievedAt",
    ] as const) {
      const partial = { ...evidence };
      delete partial[field];
      expect(hasEvidence(partial)).toBe(false);
      expect(() => selectExecution(catalog([partial]), 1, approved)).toThrow();
    }
    expect(hasEvidence({ ...evidence, source: "http://example.com" })).toBe(
      false,
    );
    expect(selectExecution(c, 1, approved).cost).toBe(REFERENCE_COST);
    expect(selectExecution(c, 7, approved).thinking).toBe("xhigh");
    // Former economic losers have no persistent selection flag.
    expect(
      selectExecution(c, 1, [{ ...approved[0], thinking: ["xhigh"] }]).thinking,
    ).toBe("xhigh");
    expect(() => selectExecution(c, 1, [])).toThrow();
    expect(describeLevels(c, approved)[9].error).toBeTruthy();
    expect(() => selectExecution(c, 0, approved)).toThrow();
    const tied = catalog([{ ...evidence, model: "z" }, evidence]);
    expect(
      selectExecution(tied, 1, [...approved, { ...approved[0], model: "z" }])
        .model,
    ).toBe("m");
  });

  it("validates strict catalog schemas but allows empty and negative assessments", () => {
    expect(validateCatalog(catalog([]))).toEqual(catalog([]));
    expect(validateCatalog(catalog([negative]))).toEqual(catalog([negative]));
    for (const change of [
      { extra: 1 },
      { approved },
      { version: 1 },
      { methodVersion: 2 },
      { generatedAt: "yesterday" },
      { candidates: [evidence, evidence] },
    ])
      expect(() => validateCatalog({ ...catalog(), ...change })).toThrow();
    for (const change of [
      { selected: false },
      { power: 11 },
      { power: 1.5 },
      { cost: 0 },
      { score: NaN },
      { source: "http://example.com" },
      { retrievedAt: "bad" },
      { rationale: " " },
      { thinking: "unknown" },
    ])
      expect(() =>
        validateCatalog(catalog([{ ...evidence, ...change } as Candidate])),
      ).toThrow();
  });

  it("requires exact nonempty proposal snapshot and complete tuple coverage, stripping approvals", () => {
    const c = catalog([negative, { ...negative, thinking: "xhigh" }]);
    const proposal = { ...c, approved };
    expect(
      parseProposal(
        `\`\`\`json\n${JSON.stringify(proposal)}\n\`\`\``,
        approved,
      ),
    ).toEqual(c);
    expect(() =>
      parseProposal(`result: ${JSON.stringify(proposal)}`, approved),
    ).toThrow();
    for (const change of [
      { approved: [] },
      { approved: [{ ...approved[0], model: "other" }] },
      { candidates: [negative] },
      { candidates: [...c.candidates, { ...negative, model: "other" }] },
      { extra: true },
    ])
      expect(() =>
        parseProposal(JSON.stringify({ ...proposal, ...change }), approved),
      ).toThrow();
    expect(() =>
      parseProposal(JSON.stringify({ ...catalog([]), approved: [] }), []),
    ).toThrow();
  });

  it("writes private files and preserves existing ignore content", async () => {
    const path = catalogPath();
    expect(await saveCatalog(path, catalog())).toEqual(catalog());
    expect(loadCatalog(path)).toEqual(catalog());
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
    const ignore = join(dirname(path), ".gitignore");
    expect((await stat(ignore)).mode & 0o777).toBe(0o600);
    expect(await readFile(ignore, "utf8")).toBe("*\n");
    await writeFile(ignore, "custom\n");
    await saveCatalog(path, catalog());
    expect(await readFile(ignore, "utf8")).toBe("custom\n");
  });

  it("merges concurrent updates, keeps metadata and prevents timestamp regression", async () => {
    const path = catalogPath();
    const newer = { ...catalog(), generatedAt: "2026-02-01T00:00:00Z" };
    const other = {
      ...evidence,
      model: "other",
      source: "https://example.com/other",
    };
    await Promise.all([
      saveCatalog(path, newer),
      saveCatalog(path, catalog([other])),
    ]);
    expect(loadCatalog(path).candidates).toEqual(
      expect.arrayContaining([evidence, other]),
    );
    expect(loadCatalog(path).generatedAt).toBe(newer.generatedAt);
    const merged = await saveCatalog(path, catalog([negative]));
    expect(merged.candidates).toEqual(
      expect.arrayContaining([negative, other]),
    );
    expect(hasEvidence(merged.candidates.find((c) => c.model === "m")!)).toBe(
      false,
    );
    const partial = { ...negative, power: 8 };
    const reassessed = await saveCatalog(path, catalog([partial]));
    expect(reassessed.candidates.find((c) => c.model === "m")).toEqual(partial);
    expect(() => selectExecution(reassessed, 1, approved)).toThrow();
  });

  it("preserves malformed and incompatible files and cleans up after late cancellation", async () => {
    const path = catalogPath();
    await saveCatalog(path, catalog());
    const before = await readFile(path, "utf8");
    await expect(
      saveCatalog(path, catalog([negative]), () => {
        throw new Error("approval revoked");
      }),
    ).rejects.toThrow("approval revoked");
    expect(await readFile(path, "utf8")).toBe(before);
    expect((await readdir(dirname(path))).sort()).toEqual([
      ".gitignore",
      "models.json",
    ]);
    for (const broken of [
      "{",
      JSON.stringify({ ...catalog(), methodVersion: 2 }),
      JSON.stringify({ ...catalog(), version: 1 }),
    ]) {
      await writeFile(path, broken);
      await expect(saveCatalog(path, catalog())).rejects.toThrow();
      expect(await readFile(path, "utf8")).toBe(broken);
      expect(() => loadCatalog(path)).toThrow();
    }
  });

  it("publishes without yielding after final approval verification", async () => {
    const path = catalogPath();
    await saveCatalog(path, catalog());
    const observed = Promise.withResolvers<Catalog>();
    await saveCatalog(path, catalog([negative]), () => {
      queueMicrotask(() => observed.resolve(loadCatalog(path)));
    });
    expect((await observed.promise).candidates).toEqual([negative]);
  });

  it("respects a lock held by an independent process and reads the latest file under it", async () => {
    const path = catalogPath();
    await saveCatalog(path, catalog());
    const other = catalog([{ ...evidence, model: "child" }]);
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import lockfile from 'proper-lockfile';
      import { writeFile } from 'node:fs/promises';
      const release = await lockfile.lock(process.argv[1], {realpath:false});
      console.log('locked');
      await new Promise(resolve => process.stdin.once('data', resolve));
      await writeFile(process.argv[1], process.argv[2]);
      await release();
    `,
        path,
        JSON.stringify(other),
      ],
      {
        cwd: dirname(dirname(new URL(import.meta.url).pathname)),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const exited = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`child exit ${code}`)),
      );
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout!.once("data", () => resolve());
        child.once("error", reject);
        child.once("exit", () =>
          reject(new Error("child exited before locking")),
        );
      });
      const saving = saveCatalog(path, catalog());
      child.stdin!.end("release\n");
      await saving;
      await exited;
      expect(loadCatalog(path).candidates).toEqual(
        expect.arrayContaining([evidence, other.candidates[0]]),
      );
    } finally {
      child.kill();
    }
  });
});
