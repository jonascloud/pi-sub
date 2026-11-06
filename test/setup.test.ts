import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { Coordinator } from "../src/coordinator.ts";
import {
  catalogPath,
  saveCatalog,
  type ApprovedModel,
  type Catalog,
} from "../src/models.ts";
import { approvedModels, setupModels } from "../src/setup.ts";
import type { Worker, WorkerEvent, WorkerOptions } from "../src/worker.ts";

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
  version: 1,
  methodVersion: 1,
  generatedAt: "2026-11-05T00:00:00Z",
  approved,
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
      selected: true,
    },
  ],
});
class FakeWorker implements Worker {
  listener: (event: WorkerEvent) => void = () => {};
  text = "";
  prompts: string[] = [];
  closes = 0;
  async start() {}
  async send(message: string) {
    this.prompts.push(message);
    this.listener({ type: "agent_start" } as WorkerEvent);
    return "started" as const;
  }
  async pause() {
    return { steering: [], followUp: [] };
  }
  async report() {
    return { text: this.text };
  }
  async close() {
    this.closes++;
  }
  onEvent(listener: (event: WorkerEvent) => void) {
    this.listener = listener;
    return () => {};
  }
  finish(text: string) {
    this.text = text;
    this.listener({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        stopReason: "stop",
      },
    } as WorkerEvent);
    this.listener({ type: "agent_settled", aborted: false });
    this.listener({ type: "worker_state", idle: true });
  }
}
const fixtures: { cwd: string; coordinator: Coordinator }[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.coordinator.dispose();
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});
async function begin(current = () => approved, signal?: AbortSignal) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-sub-setup-"));
  const worker = new FakeWorker();
  const coordinator = new Coordinator({ createWorker: () => worker });
  fixtures.push({ cwd, coordinator });
  const started = Promise.withResolvers<string>();
  const result = setupModels({
    cwd,
    coordinator,
    worker: { ...execution, cwd },
    approved: current,
    signal,
    onStarted: (id) => started.resolve(id),
  });
  // Attach rejection handling before triggering a failure or interruption.
  void result.catch(() => {});
  const id = await started.promise;
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { cwd, worker, coordinator, id, result };
}

describe("model setup", () => {
  it("bootstraps without a catalog, validates all candidates, closes and activates", async () => {
    const fixture = await begin();
    expect(fixture.worker.prompts[0]).toContain("Approved snapshot");
    expect(
      await readFile(join(fixture.cwd, ".pi/pi-sub/.gitignore"), "utf8"),
    ).toBe("*\n");
    fixture.worker.finish(JSON.stringify(catalog()));
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
    await saveCatalog(catalogPath(fixture.cwd), catalog());
    fixture.worker.finish("I cannot obtain comparable evidence.");
    await expect(fixture.result).rejects.toThrow(
      "Previous catalog was not replaced",
    );
    expect(
      JSON.parse(await readFile(catalogPath(fixture.cwd), "utf8")),
    ).toEqual(catalog());
    expect(fixture.worker.closes).toBe(1);
  });
  it("rejects an approval change before activating the proposal", async () => {
    let current = approved;
    const fixture = await begin(() => current);
    current = [];
    fixture.worker.finish(JSON.stringify(catalog()));
    await expect(fixture.result).rejects.toThrow("approval changed");
    await expect(readFile(catalogPath(fixture.cwd))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("refuses activation when approval changes while collecting the research result", async () => {
    let current = approved;
    const fixture = await begin(() => current);
    await saveCatalog(catalogPath(fixture.cwd), catalog());
    fixture.worker.report = async () => {
      current = [];
      return { text: fixture.worker.text };
    };
    fixture.worker.finish(
      JSON.stringify({ ...catalog(), generatedAt: "2026-11-05T01:00:00Z" }),
    );
    await expect(fixture.result).rejects.toThrow("approval changed");
    expect(
      JSON.parse(await readFile(catalogPath(fixture.cwd), "utf8")),
    ).toEqual(catalog());
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
    expect(fixture.worker.closes).toBe(0);
    await fixture.coordinator.continue(fixture.id);
    fixture.worker.finish(JSON.stringify(catalog()));
    await expect(fixture.result).resolves.toHaveProperty("catalog");
  });
  it("closes research on shutdown without replacing existing configuration", async () => {
    const controller = new AbortController();
    const fixture = await begin(() => approved, controller.signal);
    await saveCatalog(catalogPath(fixture.cwd), catalog());
    controller.abort();
    await expect(fixture.result).rejects.toThrow(
      "Previous catalog was not replaced",
    );
    expect(
      JSON.parse(await readFile(catalogPath(fixture.cwd), "utf8")),
    ).toEqual(catalog());
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
