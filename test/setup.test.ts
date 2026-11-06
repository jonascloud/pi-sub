import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import type { Model } from "@earendil-works/pi-ai";
import { lock } from "proper-lockfile";
import * as lockfile from "proper-lockfile";
import { Coordinator } from "../src/coordinator.ts";
import {
  ladderPath,
  STRENGTH_GUIDANCE,
  type AvailableModel,
  type Ladder,
} from "../src/models.ts";
import { ModelSetup, availableModels, workerDirectory } from "../src/setup.ts";
import type {
  Worker,
  WorkerOptions,
  WorkerEvent,
  WorkerReport,
} from "../src/worker.ts";
vi.mock("proper-lockfile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("proper-lockfile")>();
  return { ...actual, lock: vi.fn(actual.lock) };
});

const available: AvailableModel[] = [
  { provider: "test", model: "fake", thinking: ["off"] },
];
const execution: WorkerOptions = {
  provider: "test",
  model: "fake",
  thinking: "off",
  cwd: "/",
  name: "setup",
};
const ladder: Ladder = { "6": "test/fake:off" };
const proposal = (value = ladder, comparison = "Evidence reviewed") =>
  JSON.stringify({ ladder: value, comparison });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

class FakeWorker implements Worker {
  listener: (event: WorkerEvent) => void = () => {};
  prompts: string[] = [];
  closes = 0;
  private finished = false;
  private result = Promise.withResolvers<WorkerReport>();
  constructor(readonly sessionFile: string) {}
  async run(text: string) {
    this.prompts.push(text);
    this.listener({ type: "agent_start" });
    return this.result.promise;
  }
  async stop() {
    if (this.finished) return;
    this.finished = true;
    this.closes++;
    this.result.resolve({
      text: "",
      sessionFile: this.sessionFile,
      interrupted: true,
      inputPersisted: true,
    });
  }
  onEvent(listener: (event: WorkerEvent) => void) {
    this.listener = listener;
    return () => {
      this.listener = () => {};
    };
  }
  fail(error: string) {
    this.finished = true;
    this.result.resolve({
      text: "",
      error,
      sessionFile: this.sessionFile,
      interrupted: false,
      inputPersisted: true,
    });
  }
  finish(text: string) {
    if (this.finished) throw new Error("Execution already ended");
    this.finished = true;
    this.closes++;
    this.result.resolve({
      text,
      sessionFile: this.sessionFile,
      interrupted: false,
      inputPersisted: true,
    });
  }
}

const fixtures: { cwd: string; coordinator: Coordinator; setup: ModelSetup }[] =
  [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.setup.dispose();
    await f.coordinator.dispose();
    await rm(f.cwd, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});
async function begin(
  options: {
    baseline?: string;
    available?: () => AvailableModel[];
    choose?: (
      models: AvailableModel[],
      current: Ladder | undefined,
      signal: AbortSignal,
    ) => Promise<AvailableModel[] | undefined>;
    prepare?: () => Promise<boolean>;
  } = {},
) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-sub-setup-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(cwd, "agent"));
  const workers: FakeWorker[] = [];
  const coordinator = new Coordinator({
    createWorker: (_, file) => {
      const w = new FakeWorker(file);
      workers.push(w);
      return w;
    },
  });
  if (options.baseline !== undefined) {
    await mkdir(dirname(ladderPath()), { recursive: true });
    await writeFile(ladderPath(), options.baseline);
  }
  const onReport = vi.fn();
  const onSaved = vi.fn();
  const onChange = vi.fn();
  const setup = new ModelSetup({
    coordinator,
    available: options.available ?? (() => available),
    choose: options.choose ?? (async (models) => models),
    prepare: options.prepare ?? (async () => true),
    onReport,
    onSaved,
    onChange,
  });
  fixtures.push({ cwd, coordinator, setup });
  return {
    cwd,
    coordinator,
    setup,
    workers,
    onReport,
    onSaved,
    onChange,
    open: () => setup.open({ ...execution, cwd }),
    get worker() {
      return workers.at(-1)!;
    },
    get id() {
      return setup.view!.id!;
    },
  };
}
async function review(
  f: Awaited<ReturnType<typeof begin>>,
  value = ladder,
  comparison?: string,
) {
  f.worker.finish(proposal(value, comparison));
  await tick();
  expect(f.setup.view?.phase).toBe("review");
}
it("returns before research ends and writes only after explicit revision-bound acceptance", async () => {
  const f = await begin();
  await f.open();
  expect(f.setup.view?.phase).toBe("working");
  await expect(f.setup.accept(f.setup.view!.revision)).rejects.toThrow();
  expect(f.worker.prompts[0]).toContain("Selected variants (research only):");
  expect(f.worker.prompts[0]).toContain(STRENGTH_GUIDANCE);
  await review(f, ladder, "accept");
  await expect(readFile(ladderPath())).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(f.onReport.mock.calls[0]![0].content).toContain("DRAFT (not saved)");
  const id = f.id;
  await f.setup.accept(f.setup.view!.revision);
  expect(JSON.parse(await readFile(ladderPath(), "utf8"))).toEqual(ladder);
  expect(f.onSaved).toHaveBeenCalledOnce();
  expect(f.setup.active).toBe(false);
  expect(f.coordinator.inspect(id)).toMatchObject({ outcome: "reply" });
});
it("reports a cleanup warning without undoing a committed acceptance", async () => {
  const f = await begin();
  await f.open();
  await review(f);
  const id = f.id;
  const original = (
    await vi.importActual<typeof import("proper-lockfile")>("proper-lockfile")
  ).lock;
  const spy = vi.spyOn(lockfile, "lock").mockImplementation(async (...args) => {
    const release = await original(...args);
    return async () => {
      await release();
      throw new Error("release failed");
    };
  });
  try {
    await expect(
      f.setup.accept(f.setup.view!.revision),
    ).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(ladderPath(), "utf8"))).toEqual(ladder);
    expect(f.onSaved).toHaveBeenCalledOnce();
    expect(f.setup.active).toBe(false);
    expect(f.onReport).toHaveBeenLastCalledWith({
      content: "Model ladder saved, but cleanup failed: release failed",
      details: { id, path: ladderPath() },
    });
    expect(f.coordinator.inspect(id)).toMatchObject({ outcome: "reply" });
  } finally {
    spy.mockRestore();
  }
});
it("reserves and cancels the human model choice without starting research or saving", async () => {
  const choice = Promise.withResolvers<AvailableModel[] | undefined>();
  let signal: AbortSignal | undefined;
  const f = await begin({
    baseline: JSON.stringify(ladder),
    choose: async (_models, _current, abort) => {
      signal = abort;
      return choice.promise;
    },
  });
  const opening = f.open();
  await tick();
  expect(f.setup.view?.phase).toBe("choosing");
  expect(f.coordinator.list()).toEqual([]);
  await f.setup.cancel();
  expect(signal?.aborted).toBe(true);
  choice.resolve(available);
  await opening;
  expect(f.workers).toHaveLength(0);
  expect(await readFile(ladderPath(), "utf8")).toBe(JSON.stringify(ladder));
});

it("an interruption epoch invalidates a late choice even after admission reopens", async () => {
  const choice = Promise.withResolvers<AvailableModel[] | undefined>();
  const f = await begin({ choose: () => choice.promise });
  const opening = f.open();
  await tick();
  await f.coordinator.interrupt();
  await f.coordinator.prompt();
  choice.resolve(available);
  await opening;
  expect(f.workers).toHaveLength(0);
  expect(f.setup.active).toBe(false);
});

it("interrupting startup after the dialog cannot enqueue a late research task", async () => {
  const f = await begin({ baseline: "{}" });
  f.onChange.mockImplementation((view) => {
    if (view?.phase === "working" && !view.id) void f.coordinator.interrupt();
  });
  await f.open();
  expect(f.workers).toHaveLength(0);
  expect(f.coordinator.list()).toEqual([]);
  expect(f.setup.active).toBe(false);
  expect(await readFile(ladderPath(), "utf8")).toBe("{}");
});

it("only selected candidates may receive new or retained available assignments", async () => {
  const other: AvailableModel = {
    provider: "test",
    model: "other",
    thinking: ["off"],
  };
  const old = "test/other:off";
  const f = await begin({
    baseline: JSON.stringify({ "9": old }),
    available: () => [...available, other],
    choose: async () => available,
  });
  await f.open();
  expect(f.worker.prompts[0]).not.toContain('"model":"other"'); // Only the current ladder contains its full reference.
  f.worker.finish(proposal({ ...ladder, "9": old }));
  await tick();
  expect(f.setup.active).toBe(false);
  expect(f.onReport.mock.calls.at(-1)![0].content).toContain("selection");
});

it("rejects a chosen physical model that disappears or was not offered", async () => {
  for (const novel of [false, true]) {
    let current = available;
    const f = await begin({
      available: () => current,
      choose: async (models) => {
        if (novel)
          return [
            { provider: "not-offered", model: "other", thinking: ["off"] },
          ];
        current = [];
        return models;
      },
    });
    await f.open();
    expect(f.workers).toHaveLength(0);
    expect(f.setup.active).toBe(false);
    expect(f.onReport.mock.calls.at(-1)![0].content).toContain("available");
  }
});

it("does not expand selected thinking authority when native support changes during the dialog", async () => {
  let current = available;
  const f = await begin({
    available: () => current,
    choose: async (offered) => {
      current = [{ ...available[0]!, thinking: ["off", "high"] }];
      return offered;
    },
  });
  await f.open();
  const selected = JSON.parse(
    f.worker.prompts[0]!.split(
      "Selected variants (research only):\n",
    )[1]!.split("\n\nCurrent ladder:")[0]!,
  );
  expect(selected[0].thinking).toEqual(["off"]);
  f.worker.finish(proposal({ "6": "test/fake:high" }));
  await tick();
  expect(f.setup.active).toBe(false);
  expect(f.onReport.mock.calls.at(-1)![0].content).toContain("selection");
});

it("report consumers cannot mutate the internal draft after it was shown", async () => {
  const f = await begin();
  await f.open();
  await review(f);
  const report = f.onReport.mock.calls[0]![0] as {
    details: { proposal: { ladder: Ladder } };
  };
  report.details.proposal.ladder["6"] = "test/other:off";
  expect(f.setup.view?.draft).toEqual(ladder);
  await f.setup.accept(f.setup.view!.revision);
  expect(JSON.parse(await readFile(ladderPath(), "utf8"))).toEqual(ladder);
});

it("reserves open before prepare and initializes ignored runtime storage", async () => {
  const ready = Promise.withResolvers<boolean>();
  const f = await begin({ prepare: () => ready.promise });
  const first = f.open();
  await expect(f.open()).rejects.toThrow("already active");
  ready.resolve(true);
  await first;
  expect(await readFile(join(f.cwd, ".pi/pi-sub/.gitignore"), "utf8")).toBe(
    "*\n",
  );
  await writeFile(join(f.cwd, ".pi/pi-sub/.gitignore"), "sessions/\n");
  await workerDirectory(f.cwd);
  expect(await readFile(join(f.cwd, ".pi/pi-sub/.gitignore"), "utf8")).toBe(
    "sessions/\n",
  );
});
it.each(["", "# custom rules\n*.tmp", "sessions/\n!sessions/\n"])(
  "protects journals even with an existing insufficient ignore file: %j",
  async (contents) => {
    const f = await begin();
    execFileSync("git", ["init", "--quiet", f.cwd]);
    const directory = join(f.cwd, ".pi/pi-sub");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, ".gitignore"), contents);
    const [sessions] = await Promise.all(
      Array.from({ length: 4 }, () => workerDirectory(f.cwd)),
    );
    await mkdir(sessions!, { recursive: true });
    await writeFile(join(sessions!, "private.jsonl"), "private task history");
    expect(
      execFileSync(
        "git",
        ["check-ignore", "--", ".pi/pi-sub/sessions/private.jsonl"],
        { cwd: f.cwd },
      )
        .toString()
        .trim(),
    ).toBe(".pi/pi-sub/sessions/private.jsonl");
    const ignored = await readFile(join(directory, ".gitignore"), "utf8");
    expect(ignored.startsWith(contents)).toBe(true);
    await workerDirectory(f.cwd);
    expect(await readFile(join(directory, ".gitignore"), "utf8")).toBe(ignored);
  },
);

it("refines using a fresh execution in the same session, rejecting stale acceptance", async () => {
  const f = await begin();
  await f.open();
  await review(f);
  const revision = f.setup.view!.revision;
  const previous = f.worker;
  await f.setup.revise("Recheck strengths");
  expect(f.worker).not.toBe(previous);
  expect(f.worker.sessionFile).toBe(previous.sessionFile);
  await expect(f.setup.accept(revision)).rejects.toThrow();
  await review(f);
  await expect(f.setup.accept(revision)).rejects.toThrow();
  await f.setup.accept(f.setup.view!.revision);
});
it("discards an old observer on active redirection", async () => {
  const f = await begin();
  await f.open();
  const previous = f.worker;
  await f.setup.revise("New evidence");
  expect(previous.closes).toBe(1);
  expect(f.setup.view?.draft).toBeUndefined();
  await review(f);
  expect(f.onReport).toHaveBeenCalledOnce();
});
it("reflects pause and resumes without completing the workflow", async () => {
  const f = await begin();
  await f.open();
  const id = f.id;
  await f.coordinator.pause(id);
  expect(f.setup.view?.paused).toBe(true);
  await f.coordinator.continue(id);
  expect(f.setup.view?.paused).toBe(false);
  await review(f);
});
it.each(["cancel", "interrupt", "availability", "external"] as const)(
  "blocks publication under the global lock: %s",
  async (action) => {
    let current = available;
    const baseline = JSON.stringify({});
    const f = await begin({ baseline, available: () => current });
    await f.open();
    await review(f);
    const release = await lock(ladderPath(), { realpath: false });
    const saving = f.setup.accept(f.setup.view!.revision);
    void saving.catch(() => {});
    await tick();
    await expect(f.setup.revise("Busy input")).rejects.toThrow("busy");
    if (action === "cancel") await f.setup.cancel();
    if (action === "interrupt") {
      await f.coordinator.interrupt();
      await f.coordinator.prompt();
    }
    if (action === "availability") current = [];
    if (action === "external") await writeFile(ladderPath(), "{\n}\n");
    await release();
    await expect(saving).rejects.toThrow();
    expect(await readFile(ladderPath(), "utf8")).toBe(
      action === "external" ? "{\n}\n" : baseline,
    );
    expect(f.onSaved).not.toHaveBeenCalled();
  },
);
it("checks cancellation after a reentrant availability callback in the final publication hook", async () => {
  let attack = false,
    calls = 0;
  const f = await begin({
    baseline: "{}",
    available: () => {
      if (attack && ++calls === 2) void f.setup.cancel();
      return available;
    },
  });
  await f.open();
  await review(f);
  attack = true;
  await expect(f.setup.accept(f.setup.view!.revision)).rejects.toThrow();
  expect(await readFile(ladderPath(), "utf8")).toBe("{}");
  expect(f.onSaved).not.toHaveBeenCalled();
});

it("retains unavailable baseline rows but does not grant authority to move them", async () => {
  const foreign = "foreign/model:off";
  const f = await begin({ baseline: JSON.stringify({ "9": foreign }) });
  await f.open();
  await review(f, { ...ladder, "9": foreign });
  await f.setup.accept(f.setup.view!.revision);
  await f.open();
  f.worker.finish(proposal({ "8": foreign }));
  await tick();
  expect(f.setup.active).toBe(false);
  expect(f.onReport.mock.calls.at(-1)![0].content).toContain("selection");
});
it("rechecks selected unchanged entries when availability disappears before acceptance", async () => {
  let current = available;
  const f = await begin({
    baseline: JSON.stringify(ladder),
    available: () => current,
  });
  await f.open();
  await review(f);
  current = [];
  await expect(f.setup.accept(f.setup.view!.revision)).rejects.toThrow(
    "available",
  );
  expect(f.onSaved).not.toHaveBeenCalled();
  expect(await readFile(ladderPath(), "utf8")).toBe(JSON.stringify(ladder));
});
it.each([
  "garbage",
  JSON.stringify({ ladder, comparison: "ok", available }),
  JSON.stringify({ ladder, comparison: "" }),
  JSON.stringify({
    ladder: { "0": "test/fake:off" },
    comparison: "ok",
  }),
])("closes invalid research without writing: %s", async (response) => {
  const f = await begin({ baseline: "{}" });
  await f.open();
  const id = f.id;
  f.worker.finish(response);
  await tick();
  expect(f.setup.active).toBe(false);
  expect(f.coordinator.list()).toHaveLength(0);
  expect(f.coordinator.inspect(id)).toBeDefined();
  expect(await readFile(ladderPath(), "utf8")).toBe("{}");
});
it("allows explicit repair of malformed baseline", async () => {
  const f = await begin({ baseline: "broken" });
  await f.open();
  expect(f.setup.view?.currentError).toBeTruthy();
  await review(f);
  await f.setup.accept(f.setup.view!.revision);
  expect(JSON.parse(await readFile(ladderPath(), "utf8"))).toEqual(ladder);
});
it("closes provider failures and remains rerunnable", async () => {
  const f = await begin();
  await f.open();
  f.worker.fail("Provider unavailable");
  await tick();
  expect(f.setup.active).toBe(false);
  await f.open();
  expect(f.setup.active).toBe(true);
});
it("leaves failed termination owned by the coordinator, even with throwing callbacks", async () => {
  const f = await begin();
  await f.open();
  const id = f.id;
  const stop = vi
    .spyOn(f.worker, "stop")
    .mockRejectedValue(new Error("stop failed"));
  f.onReport.mockImplementation(() => {
    throw new Error("observer failed");
  });
  f.onChange.mockImplementation(() => {
    throw new Error("observer failed");
  });
  await f.setup.cancel();
  expect(f.setup.active).toBe(false);
  expect(f.coordinator.get(id).outcome).toBe("error");
  stop.mockRestore();
  await f.coordinator.stop(id);
  expect(f.coordinator.list()).toHaveLength(0);
});
it("dispose only detaches observers; coordinator shutdown owns workers", async () => {
  const f = await begin();
  await f.open();
  const worker = f.worker;
  f.setup.dispose();
  expect(worker.closes).toBe(0);
  expect(f.setup.active).toBe(false);
  expect(f.setup.view).toBeUndefined();
  expect(f.onChange).toHaveBeenLastCalledWith(undefined);
  await f.coordinator.dispose();
  expect(worker.closes).toBe(1);
});

it("accepts exactly one JSON fence without extracting surrounding prose", async () => {
  const f = await begin();
  await f.open();
  f.worker.finish(`\n\`\`\`json\n${proposal()}\n\`\`\`\n`);
  await tick();
  expect(f.setup.view?.phase).toBe("review");
  expect(f.onReport.mock.calls.at(-1)![0].details.proposal.ladder).toEqual(
    ladder,
  );
  await f.setup.cancel();
  for (const response of [
    `Here is the proposal:\n\`\`\`json\n${proposal()}\n\`\`\``,
    `\`\`\`json\n${proposal()}\n\`\`\`\nDone.`,
    `\`\`\`json\n${proposal()}\n\`\`\`\n\`\`\`json\n${proposal()}\n\`\`\``,
  ]) {
    await f.open();
    f.worker.finish(response);
    await tick();
    expect(f.setup.active).toBe(false);
    expect(f.coordinator.list()).toHaveLength(0);
  }
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
    { provider: "test", model: "another", thinking: ["off"] },
    ...available,
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
  ).toEqual([expected[0]]);
});
