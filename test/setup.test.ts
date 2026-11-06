import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { lock } from "proper-lockfile";
import { Coordinator } from "../src/coordinator.ts";
import {
  catalogPath,
  saveCatalog,
  type ApprovedModel,
  type Catalog,
} from "../src/models.ts";
import { approvedModels, setupModels, workerDirectory } from "../src/setup.ts";
import type {
  Worker,
  WorkerEvent,
  WorkerOptions,
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
const catalog = (): Catalog => ({
  version: 2,
  methodVersion: 1,
  generatedAt: "2026-11-05T00:00:00Z",
  candidates: [
    {
      provider: "test",
      model: "fake",
      thinking: "off",
      power: 6,
      cost: 0.1,
      score: 30,
      source: "https://artificialanalysis.ai/models/fake",
      retrievedAt: "2026-11-05T00:00:00Z",
      rationale: "Test evidence",
    },
  ],
});
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
const fixtures: { cwd: string; coordinator: Coordinator }[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.coordinator.dispose();
    await rm(fixture.cwd, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});
async function begin(current = () => approved, signal?: AbortSignal) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-sub-setup-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(cwd, "agent"));
  const workers: FakeWorker[] = [];
  const coordinator = new Coordinator({
    createWorker: (_options, file) => {
      const worker = new FakeWorker(file);
      workers.push(worker);
      return worker;
    },
  });
  fixtures.push({ cwd, coordinator });
  const started = Promise.withResolvers<string>();
  const result = setupModels({
    coordinator,
    worker: { ...execution, cwd, sessionDir: await workerDirectory(cwd) },
    approved: current,
    signal,
    onStarted: (id) => started.resolve(id),
  });
  // Attach rejection handling before triggering a failure or interruption.
  void result.catch(() => {});
  const id = await started.promise;
  await new Promise((resolve) => setTimeout(resolve, 0));
  return {
    cwd,
    get worker() {
      return workers.at(-1)!;
    },
    workers,
    coordinator,
    id,
    result,
  };
}

describe("model setup", () => {
  it("bootstraps without a catalog, validates all candidates, closes and activates", async () => {
    const fixture = await begin();
    expect(fixture.worker.prompts[0]).toContain("Approved snapshot");
    expect(
      await readFile(join(fixture.cwd, ".pi/pi-sub/.gitignore"), "utf8"),
    ).toBe("*\n");
    fixture.worker.finish(JSON.stringify({ ...catalog(), approved }));
    const result = await fixture.result;
    expect(JSON.parse(await readFile(result.path, "utf8"))).toEqual(catalog());
    expect(fixture.worker.closes).toBe(1);
    expect(() => fixture.coordinator.get(fixture.id)).toThrow(
      "Unknown live task",
    );
    expect(fixture.coordinator.inspect(fixture.id)).toMatchObject({
      outcome: "reply",
    });
  });
  it("preserves the old catalog when research output is invalid", async () => {
    const fixture = await begin();
    await saveCatalog(catalogPath(), catalog());
    fixture.worker.finish("I cannot obtain comparable evidence.");
    await expect(fixture.result).rejects.toThrow("Global catalog:");
    expect(JSON.parse(await readFile(catalogPath(), "utf8"))).toEqual(
      catalog(),
    );
    expect(fixture.worker.closes).toBe(1);
  });
  it("rejects an approval change before activating the proposal", async () => {
    let current = approved;
    const fixture = await begin(() => current);
    current = [];
    fixture.worker.finish(JSON.stringify({ ...catalog(), approved }));
    await expect(fixture.result).rejects.toThrow("approval changed");
    await expect(readFile(catalogPath())).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("does not retroactively reject committed ratings when approval changes after acceptance", async () => {
    let current = approved;
    const fixture = await begin(() => current);
    await saveCatalog(catalogPath(), catalog());
    fixture.coordinator.subscribe(() => {
      if (!fixture.coordinator.list().some((task) => task.id === fixture.id))
        current = [];
    });
    fixture.worker.finish(
      JSON.stringify({
        ...catalog(),
        approved,
        generatedAt: "2026-11-05T01:00:00Z",
      }),
    );
    await expect(fixture.result).resolves.toHaveProperty("catalog");
    expect(JSON.parse(await readFile(catalogPath(), "utf8"))).toEqual({
      ...catalog(),
      generatedAt: "2026-11-05T01:00:00Z",
    });
  });
  it.each(["interrupt", "stop", "approval"] as const)(
    "cancels activation while waiting for the global lock: %s",
    async (action) => {
      let current = approved;
      const fixture = await begin(() => current);
      await saveCatalog(catalogPath(), catalog());
      const release = await lock(catalogPath(), { realpath: false });
      try {
        fixture.worker.finish(
          JSON.stringify({
            ...catalog(),
            approved,
            generatedAt: "2026-11-05T01:00:00Z",
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(fixture.coordinator.get(fixture.id).status).toBe("ready");
        if (action === "stop") await fixture.coordinator.stop(fixture.id);
        if (action === "approval") current = [];
        if (action === "interrupt") {
          await fixture.coordinator.interrupt();
          await fixture.coordinator.prompt(); // Reopening admission must not revive an invalidated commit.
        }
      } finally {
        await release();
      }
      await expect(fixture.result).rejects.toThrow();
      expect(JSON.parse(await readFile(catalogPath(), "utf8"))).toEqual(
        catalog(),
      );
    },
  );

  it("merges reviewed variants without deleting unrelated global assessments", async () => {
    const fixture = await begin();
    const other = { ...catalog().candidates[0]!, model: "other", power: 9 };
    await saveCatalog(catalogPath(), {
      ...catalog(),
      candidates: [...catalog().candidates, other],
    });
    fixture.worker.finish(JSON.stringify({ ...catalog(), approved }));
    const result = await fixture.result;
    expect(result.catalog.candidates).toHaveLength(2);
    expect(result.catalog.candidates).toContainEqual(other);
    expect(result.catalog).not.toHaveProperty("approved");
    expect(result.path).toBe(
      join(fixture.cwd, "agent", "pi-sub", "models.json"),
    );
    await expect(
      readFile(join(fixture.cwd, ".pi/pi-sub/models.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists a negative reassessment instead of silently retaining old routing evidence", async () => {
    const fixture = await begin();
    await saveCatalog(catalogPath(), catalog());
    const negative = {
      provider: "test",
      model: "fake",
      thinking: "off",
      rationale: "No comparable evidence remains.",
    };
    fixture.worker.finish(
      JSON.stringify({ ...catalog(), approved, candidates: [negative] }),
    );
    const result = await fixture.result;
    expect(result.catalog.candidates).toEqual([negative]);
  });

  it("preserves an existing runtime ignore file", async () => {
    const fixture = await begin();
    const path = join(fixture.cwd, ".pi/pi-sub/.gitignore");
    await writeFile(path, "sessions/\n");
    await workerDirectory(fixture.cwd);
    expect(await readFile(path, "utf8")).toBe("sessions/\n");
    fixture.worker.finish(JSON.stringify({ ...catalog(), approved }));
    await fixture.result;
  });

  it("keeps paused research pending until the parent explicitly continues", async () => {
    const fixture = await begin();
    await fixture.coordinator.pause(fixture.id);
    let completed = false;
    void fixture.result
      .finally(() => {
        completed = true;
      })
      .catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(completed).toBe(false);
    const previous = fixture.worker;
    expect(previous.closes).toBe(1);
    await fixture.coordinator.continue(fixture.id);
    expect(fixture.worker).not.toBe(previous);
    expect(fixture.worker.sessionFile).toBe(previous.sessionFile);
    fixture.worker.finish(JSON.stringify({ ...catalog(), approved }));
    await expect(fixture.result).resolves.toHaveProperty("catalog");
  });
  it("closes research on shutdown without replacing existing configuration", async () => {
    const controller = new AbortController();
    const fixture = await begin(() => approved, controller.signal);
    await saveCatalog(catalogPath(), catalog());
    controller.abort();
    await expect(fixture.result).rejects.toThrow("Global catalog:");
    expect(JSON.parse(await readFile(catalogPath(), "utf8"))).toEqual(
      catalog(),
    );
    expect(fixture.worker.closes).toBe(1);
  });
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
