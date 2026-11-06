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
import { execFileSync, spawn } from "node:child_process";
import * as lockfile from "proper-lockfile";
import {
  type AvailableModel,
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

vi.mock("proper-lockfile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("proper-lockfile")>();
  return { ...actual, lock: vi.fn(actual.lock) };
});

let dir: string;
const ladder: Ladder = {
  "2": "p/cheap:off",
  "6": "p/main:low",
  "8": "p/main:high",
  "10": "p/top:max",
};
const available: AvailableModel[] = [
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

  it("accepts only canonical integer rungs and exact model references", () => {
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
      "available",
      "candidates",
    ])
      expect(() => validateLadder({ [key]: ladder["6"] }), key).toThrow();
    for (const entry of [
      null,
      [],
      {},
      1,
      undefined,
      "p/m",
      "p/m:auto",
      { model: "p/m:low" },
    ])
      expect(() => validateLadder({ "6": entry })).toThrow();
    for (const value of [null, [], "{}", 1])
      expect(() => validateLadder(value)).toThrow();
  });

  it("uses the first currently available confirmed rung at or above the minimum", () => {
    expect(selectExecution(ladder, 3, available)).toEqual({
      provider: "p",
      model: "main",
      thinking: "low",
      power: 6,
    });
    expect(selectExecution(ladder, 7, available).power).toBe(8);
    const highOnly = [
      { provider: "p", model: "main", thinking: ["high"] },
    ] satisfies AvailableModel[];
    expect(selectExecution(ladder, 3, highOnly).power).toBe(8);
    expect(selectExecution(ladder, 9, available).power).toBe(10);
    expect(() => selectExecution(ladder, 1, [])).toThrow(/No available/);
    expect(() => selectExecution(ladder, 7, available.slice(0, 1))).toThrow();
    expect(() => selectExecution({}, 1, available)).toThrow();
    expect(() =>
      selectExecution(ladder, 1, [
        { provider: "other", model: "main", thinking: ["low"] },
      ]),
    ).toThrow();
    for (const level of [0, 11, 1.5, NaN, Infinity])
      expect(() => selectExecution(ladder, level, available)).toThrow(
        /integer/,
      );
    const rows = describeLevels(ladder, highOnly);
    expect(rows).toHaveLength(10);
    expect(rows[0]).toMatchObject({ level: 1, execution: { power: 8 } });
    expect(rows[9]).toMatchObject({ level: 10, error: expect.any(String) });
    expect(available).toHaveLength(4);
  });

  it("formats four sorted single-line rows without runtime metadata", () => {
    const text = formatLadder(
      Object.fromEntries(Object.entries(ladder).reverse()),
    );
    expect(text.split("\n")).toHaveLength(7);
    expect(text).toBe(
      '{\n  "2": "p/cheap:off",\n  "6": "p/main:low",\n  "8": "p/main:high",\n  "10": "p/top:max"\n}\n',
    );
    expect(JSON.parse(text)).toEqual(ladder);
    expect(formatLadder({})).toBe("{}\n");
    expect(text).not.toMatch(
      /version|approved|available|selected|candidates|ranking|benchmark|auth/,
    );
  });

  it("uses the configured profile and reports a missing ladder", () => {
    const path = ladderPath();
    expect(path).toBe(join(dir, "profile", "pi-sub-config.json"));
    expect(readLadderSource(path)).toBeUndefined();
    expect(() => loadLadder(path)).toThrow(/\/sub:models/);
  });

  it("writes private complete replacements, preserving the ignore file", async () => {
    const path = ladderPath();
    await saveLadder(path, ladder, undefined);
    expect(loadLadder(path)).toEqual(ladder);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
    const ignore = join(dirname(path), ".gitignore");
    expect((await stat(ignore)).mode & 0o777).toBe(0o600);
    expect(await readFile(ignore, "utf8")).toBe("/pi-sub-config.json\n");
    execFileSync("git", ["init", "-q", dirname(path)]);
    const ignored = execFileSync("git", ["check-ignore", "--stdin"], {
      cwd: dirname(path),
      input:
        "pi-sub-config.json\nsettings.json\nauth.json\nnested/pi-sub-config.json\n",
      encoding: "utf8",
    });
    expect(ignored).toBe("pi-sub-config.json\n");
    await writeFile(ignore, "custom\n# keep this");
    await saveLadder(path, {}, readLadderSource(path));
    expect(loadLadder(path)).toEqual({});
    expect(await readFile(ignore, "utf8")).toBe(
      "custom\n# keep this\n/pi-sub-config.json\n",
    );
    await saveLadder(path, ladder, readLadderSource(path));
    expect(await readFile(ignore, "utf8")).toBe(
      "custom\n# keep this\n/pi-sub-config.json\n",
    );
  });

  it("appends a final ignore rule after a negation and does not duplicate it", async () => {
    const path = ladderPath();
    await mkdir(dirname(path), { recursive: true });
    const ignore = join(dirname(path), ".gitignore");
    const original = "/pi-sub-config.json\n!/pi-sub-config.json\n# keep";
    await writeFile(ignore, original);
    execFileSync("git", ["init", "-q", dirname(path)]);
    await saveLadder(path, ladder, undefined);
    expect(await readFile(ignore, "utf8")).toBe(
      `${original}\n/pi-sub-config.json\n`,
    );
    expect(
      execFileSync("git", ["check-ignore", "--", "pi-sub-config.json"], {
        cwd: dirname(path),
        encoding: "utf8",
      }).trim(),
    ).toBe("pi-sub-config.json");
    await saveLadder(path, {}, readLadderSource(path));
    expect(await readFile(ignore, "utf8")).toBe(
      `${original}\n/pi-sub-config.json\n`,
    );
  });

  it("returns cleanup warnings after publication but preserves pre-commit failures", async () => {
    const original = (
      await vi.importActual<typeof import("proper-lockfile")>("proper-lockfile")
    ).lock;
    const spy = vi
      .spyOn(lockfile, "lock")
      .mockImplementation(async (...args) => {
        const release = await original(...args);
        return async () => {
          await release();
          throw new Error("release failed");
        };
      });
    try {
      const path = ladderPath();
      expect(await saveLadder(path, ladder, undefined)).toEqual([
        expect.objectContaining({ message: "release failed" }),
      ]);
      expect(loadLadder(path)).toEqual(ladder);
      await expect(
        saveLadder(path, {}, readLadderSource(path), () => {
          throw new Error("cancelled");
        }),
      ).rejects.toMatchObject({
        cause: expect.objectContaining({ message: "cancelled" }),
        errors: [
          expect.objectContaining({ message: "cancelled" }),
          expect.objectContaining({ message: "release failed" }),
        ],
      });
      expect(loadLadder(path)).toEqual(ladder);
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects stale tokens, manual edits and deletion without merging", async () => {
    const path = ladderPath();
    const results = await Promise.allSettled([
      saveLadder(path, ladder, undefined),
      saveLadder(path, {}, undefined),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await readFile(join(dirname(path), ".gitignore"), "utf8")).toBe(
      "/pi-sub-config.json\n",
    );
    const token = readLadderSource(path)!;
    await writeFile(path, token + " ");
    await expect(saveLadder(path, {}, token)).rejects.toThrow(/changed/);
    expect(readLadderSource(path)).toBe(token + " ");
    await rm(path);
    await expect(saveLadder(path, {}, token)).rejects.toThrow(/changed/);
    expect(readLadderSource(path)).toBeUndefined();
  });

  it("preserves malformed sources until explicit exact-source repair", async () => {
    const path = ladderPath();
    await mkdir(dirname(path), { recursive: true });
    for (const broken of ["{", '{"6":"p/m:auto"}']) {
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
      "pi-sub-config.json",
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
        "pi-sub-config.json",
      ]);
    } finally {
      child.kill();
    }
  });
});
