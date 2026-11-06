import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Model } from "@earendil-works/pi-ai";
import { lock } from "proper-lockfile";
import { Coordinator } from "../src/coordinator.ts";
import { ladderPath, type ApprovedModel, type Ladder } from "../src/models.ts";
import { ModelSetup, approvedModels, workerDirectory } from "../src/setup.ts";
import type {
  Worker,
  WorkerOptions,
  WorkerEvent,
  WorkerReport,
} from "../src/worker.ts";
const approved: ApprovedModel[] = [
  { provider: "test", model: "fake", thinking: ["off"] },
];
const execution: WorkerOptions = {
  provider: "test",
  model: "fake",
  thinking: "off",
  cwd: "/",
  name: "setup",
};
const ladder: Ladder = { "6": { model: "test/fake:off", cost: 0.1 } };
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
    approved?: () => ApprovedModel[];
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
    approved: options.approved ?? (() => approved),
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
  expect(f.worker.prompts[0]).toContain("Approved variants (research only):");
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
it("report consumers cannot mutate the internal draft after it was shown", async () => {
  const f = await begin();
  await f.open();
  await review(f);
  const report = f.onReport.mock.calls[0]![0] as {
    details: { proposal: { ladder: Ladder } };
  };
  report.details.proposal.ladder["6"]!.cost = 999;
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
it("refines using a fresh execution in the same session, rejecting stale acceptance", async () => {
  const f = await begin();
  await f.open();
  await review(f);
  const revision = f.setup.view!.revision;
  const previous = f.worker;
  await f.setup.revise("Recheck costs");
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
it.each(["cancel", "interrupt", "approval", "external"] as const)(
  "blocks publication under the global lock: %s",
  async (action) => {
    let current = approved;
    const baseline = JSON.stringify({});
    const f = await begin({ baseline, approved: () => current });
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
    if (action === "approval") current = [];
    if (action === "external") await writeFile(ladderPath(), "{\n}\n");
    await release();
    await expect(saving).rejects.toThrow();
    expect(await readFile(ladderPath(), "utf8")).toBe(
      action === "external" ? "{\n}\n" : baseline,
    );
    expect(f.onSaved).not.toHaveBeenCalled();
  },
);
it("retains foreign baseline rows but does not grant authority to move them", async () => {
  const foreign = { model: "foreign/model:off", cost: 2 };
  const f = await begin({ baseline: JSON.stringify({ "9": foreign }) });
  await f.open();
  await review(f, { ...ladder, "9": foreign });
  await f.setup.accept(f.setup.view!.revision);
  await f.open();
  f.worker.finish(proposal({ "8": foreign }));
  await tick();
  expect(f.setup.active).toBe(false);
  expect(f.onReport.mock.calls.at(-1)![0].content).toContain("approval");
});
it("checks current approval only for changed rows at acceptance", async () => {
  let current = approved;
  const f = await begin({
    baseline: JSON.stringify(ladder),
    approved: () => current,
  });
  await f.open();
  await review(f);
  current = [];
  await f.setup.accept(f.setup.view!.revision);
  expect(f.onSaved).toHaveBeenCalledOnce();
});
it.each([
  "garbage",
  JSON.stringify({ ladder, comparison: "ok", approved }),
  JSON.stringify({ ladder, comparison: "" }),
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

it("uses native model scope and limits an unscoped session to its current model", () => {
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
  expect(approvedModels(ctx as never)).toEqual(approved);
  expect(
    approvedModels({ ...ctx, scopedModels: [{ model: another }] } as never)[0]!
      .model,
  ).toBe("another");
});
