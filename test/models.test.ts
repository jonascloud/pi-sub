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
  type Ladder,
  describeLevels,
  formatLadder,
  ladderPath,
  loadLadder,
  parseReference,
  readLadderSource,
  saveLadder,
  selectExecution,
  validateLadder,
} from "../src/models.ts";

let dir: string;
const ladder: Ladder = {
  "2": { model: "p/cheap:off", cost: 0 },
  "6": { model: "p/main:low", cost: 0.07134 },
  "8": { model: "p/main:high", cost: 9 },
  "10": { model: "p/top:max", cost: null },
};
const approved: ApprovedModel[] = [
  { provider: "p", model: "cheap", thinking: ["off"] },
  { provider: "p", model: "main", thinking: ["low", "high"] },
  { provider: "p", model: "top", thinking: ["max"] },
  { provider: "p", model: "outside", thinking: ["off"] },
];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ladder-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "profile"));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe("model ladder", () => {
  it("parses first slash and last colon, requiring explicit native thinking", () => {
    expect(parseReference("openrouter/vendor/model:free:high")).toEqual({
      provider: "openrouter",
      model: "vendor/model:free",
      thinking: "high",
    });
    for (const thinking of [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ])
      expect(parseReference(`p/m:${thinking}`).thinking).toBe(thinking);
    for (const text of [
      "",
      "p/m",
      "/m:low",
      "p/:low",
      "p/m:",
      "p/m:auto",
      "p/m:LOW",
      " p/m:low",
      "p/m:low\n",
      "p/a b:low",
      "p\t/m:low",
      "p/m:\u00a0low",
    ])
      expect(() => parseReference(text), text).toThrow();
  });

  it("accepts only canonical integer rungs and exact entries with honest costs", () => {
    expect(validateLadder({})).toEqual({});
    expect(validateLadder(ladder)).toEqual(ladder);
    for (const key of [
      "0",
      "11",
      "01",
      "+1",
      "1.0",
      "1e0",
      " 1",
      "NaN",
      "-1",
      "1.5",
      "version",
      "approved",
      "candidates",
    ])
      expect(() => validateLadder({ [key]: ladder["6"] }), key).toThrow();
    for (const cost of [-1, Infinity, -Infinity, NaN, "0", undefined])
      expect(() =>
        validateLadder({ "6": { model: "p/m:low", cost } }),
      ).toThrow();
    for (const entry of [
      null,
      [],
      {},
      { model: "p/m:low" },
      { ...ladder["6"], selected: true },
      { ...ladder["6"], ranking: 1 },
      { cost: null, model: "p/m" },
    ])
      expect(() => validateLadder({ "6": entry })).toThrow();
    for (const value of [null, [], "{}", 1])
      expect(() => validateLadder(value)).toThrow();
    expect(
      validateLadder({ "1": { model: "p/m:off", cost: null } })["1"].cost,
    ).toBeNull();
  });

  it("uses the first currently approved confirmed rung, never price or outside alternatives", () => {
    expect(selectExecution(ladder, 3, approved)).toEqual({
      provider: "p",
      model: "main",
      thinking: "low",
      cost: 0.07134,
      power: 6,
    });
    expect(selectExecution(ladder, 7, approved).power).toBe(8);
    const highOnly = [
      { provider: "p", model: "main", thinking: ["high"] },
    ] satisfies ApprovedModel[];
    expect(selectExecution(ladder, 3, highOnly).power).toBe(8);
    expect(selectExecution(ladder, 9, approved).cost).toBeNull();
    expect(() => selectExecution(ladder, 1, [])).toThrow(/No approved/);
    expect(() => selectExecution(ladder, 7, approved.slice(0, 1))).toThrow();
    expect(() => selectExecution({}, 1, approved)).toThrow();
    expect(() =>
      selectExecution(ladder, 1, [
        { provider: "other", model: "main", thinking: ["low"] },
      ]),
    ).toThrow();
    for (const level of [0, 11, 1.5, NaN, Infinity])
      expect(() => selectExecution(ladder, level, approved)).toThrow(/integer/);
    const rows = describeLevels(ladder, highOnly);
    expect(rows).toHaveLength(10);
    expect(rows[0]).toMatchObject({ level: 1, execution: { power: 8 } });
    expect(rows[9]).toMatchObject({ level: 10, error: expect.any(String) });
    expect(approved).toHaveLength(4);
  });

  it("formats four sorted single-line rows without runtime metadata", () => {
    const text = formatLadder(
      Object.fromEntries(Object.entries(ladder).reverse()),
    );
    expect(text.split("\n")).toHaveLength(7);
    expect(text).toBe(
      '{\n  "2": {"model":"p/cheap:off","cost":0},\n  "6": {"model":"p/main:low","cost":0.07134},\n  "8": {"model":"p/main:high","cost":9},\n  "10": {"model":"p/top:max","cost":null}\n}\n',
    );
    expect(JSON.parse(text)).toEqual(ladder);
    expect(formatLadder({})).toBe("{}\n");
    expect(text).not.toMatch(
      /version|approved|selected|candidates|ranking|benchmark|auth/,
    );
  });

  it("uses only the profile, with no project fallback or automatic migration", async () => {
    const original = process.cwd();
    const path = ladderPath();
    const project = join(dir, "project");
    await mkdir(join(project, ".pi", "pi-sub"), { recursive: true });
    await writeFile(
      join(project, ".pi", "pi-sub", "models.json"),
      formatLadder(ladder),
    );
    try {
      process.chdir(project);
      expect(ladderPath()).toBe(path);
      expect(readLadderSource(path)).toBeUndefined();
      expect(() => loadLadder(path)).toThrow(/\/sub:models/);
      expect(readLadderSource(path)).toBeUndefined();
      vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "other"));
      expect(ladderPath()).toBe(join(dir, "other", "pi-sub", "models.json"));
      expect(() => loadLadder(ladderPath())).toThrow();
    } finally {
      process.chdir(original);
    }
  });

  it("writes private complete replacements, preserving the ignore file", async () => {
    const path = ladderPath();
    await saveLadder(path, ladder, undefined);
    expect(loadLadder(path)).toEqual(ladder);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
    const ignore = join(dirname(path), ".gitignore");
    expect((await stat(ignore)).mode & 0o777).toBe(0o600);
    expect(await readFile(ignore, "utf8")).toBe("*\n");
    await writeFile(ignore, "custom\n");
    await saveLadder(path, {}, readLadderSource(path));
    expect(loadLadder(path)).toEqual({});
    expect(await readFile(ignore, "utf8")).toBe("custom\n");
  });

  it("rejects stale tokens, manual edits and deletion without merging", async () => {
    const path = ladderPath();
    const results = await Promise.allSettled([
      saveLadder(path, ladder, undefined),
      saveLadder(path, {}, undefined),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const token = readLadderSource(path)!;
    await writeFile(path, token + " ");
    await expect(saveLadder(path, {}, token)).rejects.toThrow(/changed/);
    expect(readLadderSource(path)).toBe(token + " ");
    await rm(path);
    await expect(saveLadder(path, {}, token)).rejects.toThrow(/changed/);
    expect(readLadderSource(path)).toBeUndefined();
  });

  it("preserves malformed/legacy sources until explicit exact-source repair", async () => {
    const path = ladderPath();
    await mkdir(dirname(path), { recursive: true });
    for (const broken of [
      "{",
      '{"version":2,"candidates":[]}',
      '{"6":{"model":"p/m:low","cost":-1}}',
    ]) {
      await writeFile(path, broken);
      expect(() => loadLadder(path)).toThrow(/\/sub:models/);
      expect(readLadderSource(path)).toBe(broken);
      await expect(saveLadder(path, ladder, undefined)).rejects.toThrow(
        /changed/,
      );
      await saveLadder(path, ladder, broken);
      expect(loadLadder(path)).toEqual(ladder);
    }
    expect(() => readLadderSource(dirname(path))).toThrow();
  });

  it("cleans up cancellation and publishes in the same JS turn as the final check", async () => {
    const path = ladderPath();
    await saveLadder(path, ladder, undefined);
    const token = readLadderSource(path);
    await expect(
      saveLadder(path, {}, token, () => {
        throw new Error("cancelled");
      }),
    ).rejects.toThrow("cancelled");
    expect(readLadderSource(path)).toBe(token);
    expect((await readdir(dirname(path))).sort()).toEqual([
      ".gitignore",
      "models.json",
    ]);
    let observed: Ladder | undefined;
    await saveLadder(path, {}, token, () => {
      queueMicrotask(() => {
        observed = loadLadder(path);
      });
    });
    expect(observed).toEqual({});
  });

  it("compares source under an independent process lock", async () => {
    const path = ladderPath();
    await saveLadder(path, ladder, undefined);
    const token = readLadderSource(path);
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
      await writeFile(process.argv[1], '{}\\n');
      await release();
    `,
        path,
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
      const saving = saveLadder(path, ladder, token);
      const rejected = expect(saving).rejects.toThrow(/changed/);
      child.stdin!.end("release\n");
      await rejected;
      await exited;
      expect(loadLadder(path)).toEqual({});
      expect((await readdir(dirname(path))).sort()).toEqual([
        ".gitignore",
        "models.json",
      ]);
    } finally {
      child.kill();
    }
  });
});
