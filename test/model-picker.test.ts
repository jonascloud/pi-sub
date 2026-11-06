import { expect, it } from "vitest";
import { chooseModels } from "../src/model-picker.ts";
import type { AvailableModel, Ladder } from "../src/models.ts";

const available: AvailableModel[] = [
  { provider: "p", model: "one", thinking: ["off", "high"] },
  { provider: "p", model: "two", thinking: ["off"] },
];
const ladder: Ladder = {
  "1": { model: "p/one:high", cost: 1 },
  "2": { model: "missing/model:off", cost: 2 },
  "3": { model: "p/two:high", cost: 3 },
};
type Call = { title: string; options: string[]; signal?: AbortSignal };
function fake(
  ...steps: Array<
    (call: Call) => string | undefined | Promise<string | undefined>
  >
) {
  const calls: Call[] = [];
  return {
    calls,
    ui: {
      async select(
        title: string,
        options: string[],
        config?: { signal?: AbortSignal },
      ) {
        const call = { title, options, signal: config?.signal };
        calls.push(call);
        const step = steps.shift();
        if (!step) throw new Error("Unexpected select");
        return step(call);
      },
    },
  };
}
const review = ({ options }: Call) =>
  options.find((o) => o.startsWith("Review selected"))!;

it("preselects physical ladder models and explicitly retains unavailable references", async () => {
  const f = fake(review);
  const signal = new AbortController().signal;
  const snapshot = structuredClone({ available, ladder });
  expect(await chooseModels(f.ui, available, ladder, signal)).toEqual(
    available,
  );
  expect(
    f.calls[0]!.options.filter((option) => /\[[x ]\]/.test(option)).slice(0, 2),
  ).toEqual([expect.stringContaining("[x]"), expect.stringContaining("[x]")]);
  expect(f.calls[0]!.title).toContain("missing/model:off");
  expect(f.calls[0]!.title).toContain("p/two:high");
  expect(f.calls[0]!.title).toContain("retained until a reviewed change");
  expect(f.calls.every((call) => call.signal === signal)).toBe(true);
  expect({ available, ladder }).toEqual(snapshot);
});

it("uses the initial physical model only without an existing configuration", async () => {
  const initial = { provider: "p", model: "two" };
  const f = fake(review);
  expect(
    await chooseModels(
      f.ui,
      available,
      undefined,
      new AbortController().signal,
      initial,
    ),
  ).toEqual([available[1]]);
  const empty = fake(review, ({ title }) => {
    expect(title).toContain("at least one");
    return undefined;
  });
  expect(
    await chooseModels(
      empty.ui,
      available,
      {},
      new AbortController().signal,
      initial,
    ),
  ).toBeUndefined();
});

it("toggles candidates and ignores invalid values without an extra confirmation phase", async () => {
  const f = fake(
    (c) => c.options[1],
    () => "not an option",
    (c) => c.options[2],
    review,
  );
  expect(
    await chooseModels(
      f.ui,
      available,
      undefined,
      new AbortController().signal,
    ),
  ).toEqual(available);
});

it("does not start research with no candidates or infer unavailable initial models", async () => {
  const f = fake(review, ({ title }) => {
    expect(title).toContain("No models are currently available");
    return undefined;
  });
  expect(
    await chooseModels(f.ui, [], undefined, new AbortController().signal, {
      provider: "x",
      model: "y",
    }),
  ).toBeUndefined();
});

it("returns undefined for native cancellation, explicit cancel, and abort before or after select", async () => {
  const signal = new AbortController().signal;
  expect(
    await chooseModels(fake(() => undefined).ui, available, undefined, signal),
  ).toBeUndefined();
  expect(
    await chooseModels(
      fake((c) => c.options.at(-1)).ui,
      available,
      undefined,
      signal,
    ),
  ).toBeUndefined();
  const aborted = new AbortController();
  aborted.abort();
  expect(
    await chooseModels(fake().ui, available, undefined, aborted.signal),
  ).toBeUndefined();
  const during = new AbortController();
  const f = fake((c) => {
    during.abort();
    return review(c);
  });
  expect(
    await chooseModels(f.ui, available, undefined, during.signal, available[0]),
  ).toBeUndefined();
});

it("sanitizes untrusted names and makes every option distinct", async () => {
  const evil: AvailableModel[] = [
    { provider: "p\u001b[31m", model: "x\nCancel (1)", thinking: ["off"] },
    { provider: "p\u001b[31m", model: "x\nCancel (1)", thinking: ["off"] },
  ];
  const f = fake((c) => {
    expect(new Set(c.options).size).toBe(c.options.length);
    expect(c.options.join("")).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    return c.options[1];
  }, review);
  expect(
    await chooseModels(f.ui, evil, undefined, new AbortController().signal),
  ).toEqual([evil[0]]);
});
