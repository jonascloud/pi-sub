import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import {
  type AvailableModel,
  type Ladder,
  availableExecutions,
  availableModels,
  ladderPath,
  loadLadder,
  selectExecution,
} from "../src/models.ts";

let dir: string;
const config = {
  "2": "p/cheap:off",
  "6": "p/main:low",
  "8": "p/main:high",
  "10": "p/top:max",
};
const ladder: Ladder = [
  { provider: "p", model: "cheap", thinking: "off", power: 2 },
  { provider: "p", model: "main", thinking: "low", power: 6 },
  { provider: "p", model: "main", thinking: "high", power: 8 },
  { provider: "p", model: "top", thinking: "max", power: 10 },
];
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
  it("validates every rung and parses references at the file boundary", async () => {
    const path = ladderPath();
    await mkdir(dirname(path));
    await writeFile(
      path,
      JSON.stringify({
        "10": "openrouter/vendor/model:free:high",
        "1": "p/m:off",
      }),
    );
    expect(loadLadder(path)).toEqual([
      { provider: "p", model: "m", thinking: "off", power: 1 },
      {
        provider: "openrouter",
        model: "vendor/model:free",
        thinking: "high",
        power: 10,
      },
    ]);
    for (const thinking of [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]) {
      await writeFile(path, JSON.stringify({ "1": `p/m:${thinking}` }));
      expect(loadLadder(path)[0].thinking).toBe(thinking);
    }
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
    ]) {
      await writeFile(path, JSON.stringify({ [key]: "p/m:low" }));
      expect(() => loadLadder(path), key).toThrow(/Invalid ladder rung/);
    }
    for (const entry of [
      null,
      [],
      {},
      1,
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
    ]) {
      await writeFile(path, JSON.stringify({ "1": "p/m:off", "10": entry }));
      expect(() => loadLadder(path), String(entry)).toThrow(/Invalid model/);
    }
    for (const value of [null, [], "{}", 1]) {
      await writeFile(path, JSON.stringify(value));
      expect(() => loadLadder(path)).toThrow(/Expected ladder object/);
    }
  });

  it("uses the first currently available configured rung at or above the minimum", () => {
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
    expect(() => selectExecution([], 1, available)).toThrow();
    expect(() =>
      selectExecution(ladder, 1, [
        { provider: "other", model: "main", thinking: ["low"] },
      ]),
    ).toThrow();
    for (const level of [0, 11, 1.5, NaN, Infinity])
      expect(() => selectExecution(ladder, level, available)).toThrow(
        /integer/,
      );
    expect(available).toHaveLength(4);
  });

  it("available ranges and dispatch agree for sparse, empty and unsupported ladders", () => {
    const cases: [Ladder, AvailableModel[], number[]][] = [
      [ladder, available, [2, 6, 8, 10]],
      [ladder, [{ provider: "p", model: "main", thinking: ["high"] }], [8]],
      [ladder, [{ provider: "p", model: "main", thinking: ["off"] }], []],
      [ladder, [{ provider: "other", model: "main", thinking: ["high"] }], []],
      [ladder, [], []],
      [[], available, []],
      [
        [{ provider: "p", model: "cheap", thinking: "off", power: 1 }],
        available,
        [1],
      ],
    ];
    for (const [configured, native, powers] of cases) {
      expect(
        availableExecutions(configured, native).map((entry) => entry.power),
      ).toEqual(powers);
      const max = powers.at(-1) ?? 0;
      for (let level = 1; level <= 10; level++) {
        if (level <= max)
          expect(selectExecution(configured, level, native).power).toBe(
            powers.find((power) => power >= level),
          );
        else
          expect(() => selectExecution(configured, level, native)).toThrow(
            /No available/,
          );
      }
    }
  });

  it("uses the configured profile and reports a missing ladder without creating files", async () => {
    const path = ladderPath();
    expect(path).toBe(join(dir, "profile", "pi-sub-config.json"));
    expect(() => loadLadder(path)).toThrow(path);
    expect(() => loadLadder(path)).toThrow(
      /instructions\/create-model-ladder\.md/,
    );
    expect(await readdir(dir)).toEqual([]);
  });

  it("reads external edits on every load without changing configuration or profile files", async () => {
    const path = ladderPath();
    await mkdir(dirname(path));
    const ignore = join(dirname(path), ".gitignore");
    await writeFile(ignore, "# operator rules\nsettings.json\n");
    for (const [value, expected] of [
      [config, ladder],
      [
        { "7": "p/main:high" },
        [{ provider: "p", model: "main", thinking: "high", power: 7 }],
      ],
      [{}, []],
    ] as const) {
      const source = JSON.stringify(value);
      await writeFile(path, source);
      expect(loadLadder(path)).toEqual(expected);
      expect(await readFile(path, "utf8")).toBe(source);
    }
    expect(await readFile(ignore, "utf8")).toBe(
      "# operator rules\nsettings.json\n",
    );
    expect((await readdir(dirname(path))).sort()).toEqual([
      ".gitignore",
      "pi-sub-config.json",
    ]);
    await rm(path);
    expect(() => loadLadder(path)).toThrow(/missing/);
  });

  it("reports malformed sources without repairing them or hiding the cause", async () => {
    const path = ladderPath();
    await mkdir(dirname(path));
    for (const source of ["{", '{"6":"p/m:auto"}', "null", "[]"]) {
      await writeFile(path, source);
      expect(() => loadLadder(path)).toThrow(/Invalid model ladder/);
      expect(() => loadLadder(path)).toThrow(path);
      expect(await readFile(path, "utf8")).toBe(source);
    }
    await writeFile(path, '{"11":"p/m:off"}');
    expect(() => loadLadder(path)).toThrow(/Invalid ladder rung: 11/);
    expect(() => loadLadder(dirname(path))).toThrow();
  });
});

it("uses all native availability regardless of parent scope or thinking pins", () => {
  const model = {
    id: "fake",
    provider: "test",
    api: "openai-responses",
    name: "Fake",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1024,
    maxTokens: 256,
  } as Model<any>;
  const another = { ...model, id: "another" };
  const ctx = {
    model,
    scopedModels: [],
    modelRegistry: { getAvailable: () => [model, another] },
  };
  const expected = [
    { provider: "test", model: "fake", thinking: ["off"] },
    { provider: "test", model: "another", thinking: ["off"] },
  ];
  expect(availableModels(ctx as never)).toEqual(expected);
  expect(
    availableModels({
      ...ctx,
      scopedModels: [{ model, thinkingLevel: "high" }],
    } as never),
  ).toEqual(expected);
  expect(
    availableModels({
      ...ctx,
      modelRegistry: { getAvailable: () => [another] },
    } as never),
  ).toEqual([expected[1]]);
  expect(
    availableModels({ modelRegistry: { getAvailable: () => [] } } as never),
  ).toEqual([]);
});
