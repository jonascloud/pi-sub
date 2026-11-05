import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createWorker, type Worker, type WorkerEvent } from "../src/worker.ts";

const dirs: string[] = [];
const workers: Worker[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((w) => w.close()));
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
async function setup(
  thinking: "off" | "high" = "off",
  env: Record<string, string> = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "worker-test-"));
  dirs.push(dir);
  const worker = createWorker({
    cwd: dir,
    provider: "worker-test",
    model: "fake",
    thinking,
    name: "test",
    sessionDir: join(dir, "sessions"),
    env: { PI_CODING_AGENT_DIR: join(dir, "agent"), ...env },
    args: [
      "--no-extensions",
      "--extension",
      resolve("test/fixtures/provider.js"),
    ],
  });
  workers.push(worker);
  return worker;
}
function settled(worker: Worker) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error("settled timeout"));
    }, 10000);
    const off = worker.onEvent((event: WorkerEvent) => {
      if (event.type === "worker_error" || event.type === "agent_settled") {
        clearTimeout(timer);
        off();
        if (event.type === "worker_error") reject(new Error(event.error));
        else resolve();
      }
    });
  });
}
test("real CLI: handshake, events, native usage and continuing after abort", async () => {
  const worker = await setup();
  await worker.start();
  const events: string[] = [];
  worker.onEvent((e) => events.push(e.type));
  const done = settled(worker);
  await worker.send("hello");
  await done;
  const report = await worker.report();
  expect(report.text).toBe("fake response");
  expect(report.sessionFile).toBeTruthy();
  expect(report.usage).toEqual({
    input: 10,
    output: 3,
    cacheRead: 2,
    cacheWrite: 1,
    cacheWrite1h: 1,
    reasoning: 2,
    totalTokens: 16,
    cost: {
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      total: 10,
      totalFromProvider: true,
    },
  });
  expect(events).toContain("message_update");
  await worker.send("slow");
  await expect(worker.report()).rejects.toThrow("worker is active");
  await worker.send("steer");
  const cleared = await worker.pause();
  expect(cleared.steering).toContain("steer");
  const continued = settled(worker);
  await worker.send("again");
  await continued;
  const finalReport = await worker.report();
  expect(finalReport.text).toBe("fake response");
  // The aborted response also reports usage; each native entry is counted once.
  expect(finalReport.usage).toMatchObject({
    input: 30,
    reasoning: 6,
    cacheWrite1h: 3,
    cost: { total: 30, totalFromProvider: true },
  });
  await Promise.all([worker.close(), worker.close()]);
}, 30000);
test("handled input rejects and unsupported dialog fails the worker", async () => {
  const worker = await setup();
  await worker.start();
  await expect(worker.send("/handled")).rejects.toThrow("handled");
  await expect(worker.send("/dialog")).rejects.toThrow(
    "Unsupported extension UI dialog",
  );
  await expect(worker.report()).rejects.toThrow(
    "Unsupported extension UI dialog",
  );
}, 30000);
test("unexpected child exit while active emits worker_error and closes", async () => {
  const worker = await setup("off", { WORKER_TEST_CRASH: "1" });
  await worker.start();
  const failed = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error("heartbeat timeout"));
    }, 6000);
    const off = worker.onEvent((event) => {
      if (event.type === "worker_error") {
        clearTimeout(timer);
        off();
        resolve(event.error);
      }
    });
  });
  await worker.send("crash");
  expect(await failed).toMatch(/exited|stdin/i);
  expect(await worker.report()).toMatchObject({ text: "", usage: undefined });
  await Promise.all([worker.close(), worker.close()]);
}, 15000);
test("startup dialog fails without waiting for a UI response", async () => {
  const worker = await setup("off", { WORKER_TEST_STARTUP_DIALOG: "1" });
  await expect(worker.start()).rejects.toThrow(
    "Unsupported extension UI dialog",
  );
}, 15000);
test("startup rejects model fallback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "worker-test-"));
  dirs.push(dir);
  const worker = createWorker({
    cwd: dir,
    provider: "missing-provider",
    model: "missing-model",
    thinking: "off",
    name: "test",
    env: { PI_CODING_AGENT_DIR: join(dir, "agent") },
    args: ["--no-extensions"],
  });
  workers.push(worker);
  await expect(worker.start()).rejects.toThrow();
}, 30000);

test("recovers persisted response and usage after unsupported UI", async () => {
  const worker = await setup("off", { WORKER_TEST_END_DIALOG: "1" });
  await worker.start();
  const failed = settled(worker);
  await worker.send("hello");
  await expect(failed).rejects.toThrow("Unsupported extension UI dialog");
  const report = await worker.report();
  expect(report.text).toBe("fake response");
  expect(report.sessionFile).toMatch(/\.jsonl$/);
  expect(report.usage).toMatchObject({
    input: 10,
    reasoning: 2,
    cacheWrite1h: 1,
    cost: { total: 10, totalFromProvider: true },
  });
}, 15000);

test("publishes cleared queue even when abort crashes", async () => {
  const worker = await setup("off", { WORKER_TEST_ABORT_CRASH: "1" });
  await worker.start();
  const events: WorkerEvent[] = [];
  worker.onEvent((event) => events.push(event));
  await worker.send("slow");
  await worker.send("queued");
  await expect(worker.pause()).rejects.toThrow();
  expect(events).toContainEqual({
    type: "worker_queue_cleared",
    steering: ["queued"],
    followUp: [],
  });
}, 15000);

test("recovers persisted usage when an idle exit is first discovered during report", async () => {
  const worker = await setup();
  await worker.start();
  const done = settled(worker);
  await worker.send("first");
  await done;
  await expect(worker.send("/crash")).rejects.toThrow();
  expect(await worker.report()).toMatchObject({
    text: "fake response",
    usage: { input: 10, cost: { total: 10 } },
  });
}, 15000);

test("recovers earlier response when the next active run crashes", async () => {
  const worker = await setup("off", { WORKER_TEST_CRASH_AFTER_RESPONSE: "1" });
  await worker.start();
  const done = settled(worker);
  await worker.send("first");
  await done;
  const failed = settled(worker);
  await worker.send("second");
  await expect(failed).rejects.toThrow();
  expect(await worker.report()).toMatchObject({
    text: "fake response",
    usage: { input: 10, cost: { total: 10, totalFromProvider: true } },
  });
}, 15000);
