import { afterEach, expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { Coordinator } from "../src/coordinator.ts";
import {
  createWorker,
  type Worker,
  type WorkerOptions,
} from "../src/worker.ts";

const dirs: string[] = [];
const workers: Worker[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function setup(env: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "worker-native-"));
  dirs.push(dir);
  const session = join(dir, "sessions", "task.jsonl");
  const options: WorkerOptions = {
    cwd: dir,
    provider: "worker-test",
    model: "fake",
    thinking: "off",
    name: "test",
    env: { PI_CODING_AGENT_DIR: join(dir, "agent"), ...env },
    args: ["--no-extensions", "-e", resolve("test/fixtures/provider.js")],
  };
  const make = (overrides: Partial<WorkerOptions> = {}, sessionId?: string) => {
    const worker = createWorker(
      { ...options, ...overrides },
      session,
      sessionId,
    );
    workers.push(worker);
    return worker;
  };
  return { make, session, dir, options };
}
function nextEvent(worker: Worker, type: string) {
  return new Promise<void>((resolve) => {
    const off = worker.onEvent((event) => {
      if (event.type === type) {
        off();
        resolve();
      }
    });
  });
}

test("native CLI: a new process continues the same saved question/answer context", async () => {
  const { make, session, dir, options } = await setup();
  // Public context hook observes what the native CLI actually restores, rather
  // than inferring continuity just from the presence of a session file.
  const observer = join(dir, "observe.ts");
  const log = join(dir, "context.json");
  await writeFile(
    observer,
    `import {writeFileSync} from 'node:fs'; export default pi => { pi.on('context', event => {writeFileSync(${JSON.stringify(log)}, JSON.stringify(event.messages));}); };`,
  );
  const first = make();
  const events: string[] = [];
  first.onEvent((event) => events.push(event.type));
  const report = await first.run("What is your response?");
  expect(report).toMatchObject({
    text: "fake response",
    sessionFile: session,
    inputPersisted: true,
    interrupted: false,
    usage: {
      input: 10,
      reasoning: 2,
      cacheWrite1h: 1,
      cost: { total: 10, totalFromProvider: true },
    },
  });
  expect(report.error).toBeUndefined();
  expect(events).toContain("message_update");
  const second = make({ args: [...options.args!, "-e", observer] });
  const continued = await second.run("Explain your previous answer.");
  expect(continued).toMatchObject({
    text: "fake response",
    sessionFile: session,
    inputPersisted: true,
    usage: {
      input: 20,
      reasoning: 4,
      cacheWrite1h: 2,
      cost: { total: 20, totalFromProvider: true },
    },
  });
  expect(continued.error).toBeUndefined();
  const messages = JSON.parse(await readFile(log, "utf8"));
  expect(messages.map((message: { role: string }) => message.role)).toEqual(
    expect.arrayContaining(["user", "assistant", "user"]),
  );
  expect(JSON.stringify(messages)).toContain("What is your response?");
  expect(JSON.stringify(messages)).toContain("fake response");
}, 30000);

test("native continuation refuses a deleted journal and keeps prior task usage", async () => {
  const { options, dir } = await setup();
  const coordinator = new Coordinator();
  try {
    const id = coordinator.start({
      prompt: "Keep this original instruction.",
      description: "journal integrity",
      level: 1,
      worker: { ...options, sessionDir: join(dir, "sessions") },
    });
    const first = await coordinator.wait(id, undefined, 15000);
    expect(first.tokens).toBe(16);
    await rm(first.sessionFile);
    await coordinator.message(
      id,
      "Continue without losing the original instruction.",
    );
    expect(await coordinator.wait(id, undefined, 15000)).toMatchObject({
      outcome: "error",
      error: "Native session file is missing",
      tokens: 16,
      pendingInput: ["Continue without losing the original instruction."],
    });
    await expect(readFile(first.sessionFile)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await coordinator.collect(id);
    expect(coordinator.drainUsage()?.totalTokens).toBe(16);
  } finally {
    await coordinator.dispose();
  }
}, 20000);

test("the native child refuses history lost between parent preflight and CLI startup", async () => {
  const { make, dir } = await setup();
  const first = await make().run("Original persisted instruction.");
  expect(first.error).toBeUndefined();
  const wrapper = join(dir, "delete-before-load.mjs");
  const marker = join(dir, "provider-called");
  await writeFile(
    wrapper,
    `import {unlinkSync} from 'node:fs';
unlinkSync(process.env.PI_SUB_EXPECTED_SESSION_FILE);
await import(${JSON.stringify(pathToFileURL(join(getPackageDir(), "dist/cli.js")).href)});`,
  );
  const report = await make(
    {
      cliPath: wrapper,
      env: {
        PI_CODING_AGENT_DIR: join(dir, "agent"),
        WORKER_TEST_SLOW_CHILD: "1",
        WORKER_TEST_CHILD_MARKER: marker,
      },
    },
    first.sessionId,
  ).run("Must not execute against empty history.");
  expect(report.error).toMatch(/session identity|session file/);
  await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
}, 15000);

test("native user message events do not acknowledge an input whose journal append fails", async () => {
  const { make, session, dir, options } = await setup();
  const first = await make().run("Original persisted instruction.");
  expect(first.error).toBeUndefined();
  const extension = join(dir, "fail-append.ts");
  await writeFile(
    extension,
    `import {renameSync, mkdirSync} from 'node:fs';
export default pi => pi.on('message_end', (event, ctx) => {
  if (event.message.role !== 'user') return;
  const file = ctx.sessionManager.getSessionFile();
  renameSync(file, file + '.saved');
  mkdirSync(file); // The subsequent native append must fail, including when tests run as root.
});`,
  );
  const report = await make(
    { args: [...options.args!, "-e", extension] },
    first.sessionId,
  ).run("Unwritten correction.");
  expect(report).toMatchObject({
    inputPersisted: false,
    error: expect.stringContaining("EISDIR"),
    usage: { totalTokens: 16 },
  });
  expect(await readFile(session + ".saved", "utf8")).not.toContain(
    "Unwritten correction.",
  );
}, 20000);

test("native JSON can exit zero on provider error; report still fails", async () => {
  const { make } = await setup({ WORKER_TEST_INTEGRATION: "1" });
  expect(await make().run("integration:child-error")).toMatchObject({
    error: "fatal synthetic failure",
    inputPersisted: true,
    interrupted: false,
  });
}, 15000);

test("thinking clamp is rejected before any provider call", async () => {
  const { make, dir } = await setup({ WORKER_TEST_SLOW_CHILD: "1" });
  const marker = join(dir, "called");
  const guard = make({
    thinking: "xhigh",
    env: {
      PI_CODING_AGENT_DIR: join(dir, "agent"),
      WORKER_TEST_SLOW_CHILD: "1",
      WORKER_TEST_CHILD_MARKER: marker,
    },
  });
  const report = await guard.run("must never reach provider");
  expect(report.error).toMatch(/model mismatch/);
  expect(report.text).toBe("");
  // Native Pi may append the user while unwinding an aborted preparation.
  // The important safety property is that no provider call occurred.
  await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
}, 15000);

test("native stop drains close and a different process can continue", async () => {
  const { make, options } = await setup({ WORKER_TEST_SLOW_CHILD: "1" });
  const first = make();
  const started = nextEvent(first, "message_start");
  const running = first.run("slow first request");
  await started;
  await Promise.all([first.stop(), first.stop()]);
  expect(await running).toMatchObject({
    interrupted: true,
    inputPersisted: true,
  });
  const report = await make({
    env: { PI_CODING_AGENT_DIR: options.env!.PI_CODING_AGENT_DIR! },
  }).run("continue after interruption");
  expect(report).toMatchObject({
    text: "fake response",
    interrupted: false,
    inputPersisted: true,
  });
  expect(report.error).toBeUndefined();
}, 20000);

test("native headless dialogs return denial defaults without approval", async () => {
  const { make, dir, options } = await setup();
  const extension = join(dir, "dialog.ts");
  const result = join(dir, "dialog-result.json");
  await writeFile(
    extension,
    `import {writeFileSync} from 'node:fs'; export default pi => { pi.on('session_start',async(_,ctx)=>{const approved=await ctx.ui.confirm('danger','approve?'); const other=[await ctx.ui.select('select',['yes']),await ctx.ui.input('input'),await ctx.ui.editor('editor')]; writeFileSync(${JSON.stringify(result)},JSON.stringify({approved,other,hasUI:ctx.hasUI}));});};`,
  );
  const report = await make({ args: [...options.args!, "-e", extension] }).run(
    "hello",
  );
  expect(report.error).toBeUndefined();
  expect(JSON.parse(await readFile(result, "utf8"))).toEqual({
    approved: false,
    other: [null, null, null],
    hasUI: false,
  });
}, 15000);

test("native tool permission denial prevents the protected side effect", async () => {
  const { make, dir, options } = await setup();
  const extension = join(dir, "permission.ts");
  const marker = join(dir, "protected-side-effect");
  const approval = join(dir, "approval.json");
  await writeFile(
    extension,
    `
import { createAssistantMessageEventStream } from ${JSON.stringify(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai/utils/event-stream")))};
import { writeFileSync } from 'node:fs';
import { Type } from 'typebox';
export default pi => {
  pi.registerTool({name:'protected_action',label:'Protected action',description:'Test permission boundary',parameters:Type.Object({}),
    async execute(_id,_args,_signal,_update,ctx) {
      const approved=await ctx.ui.confirm('Permission','Allow protected action?');
      writeFileSync(${JSON.stringify(approval)},JSON.stringify({approved}));
      if(approved) writeFileSync(${JSON.stringify(marker)},'must not happen');
      return {content:[{type:'text',text:approved?'approved':'denied'}],details:{approved}};
    }
  });
  pi.registerProvider('permission-test',{
    baseUrl:'http://localhost',apiKey:'test',api:'permission-test-api',
    models:[{id:'fake',name:'Fake permission test',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:100000,maxTokens:1000}],
    streamSimple(model,context) {
      const stream=createAssistantMessageEventStream();
      const done=context.messages.some(message=>message.role==='toolResult');
      const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),
        content:done?[{type:'text',text:'Permission denied'}]:[{type:'toolCall',id:'protected-call',name:'protected_action',arguments:{}}],
        stopReason:done?'stop':'toolUse',
        usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
      queueMicrotask(()=>{stream.push({type:'done',reason:message.stopReason,message});stream.end();});
      return stream;
    }
  });
};
`,
  );
  const worker = make({
    provider: "permission-test",
    args: [...options.args!, "-e", extension],
  });
  const events: string[] = [];
  worker.onEvent((event) => {
    if (event.type === "tool_execution_start") events.push(event.toolName);
  });
  const report = await worker.run("Try the protected action.");
  expect(report.error).toBeUndefined();
  expect(report.text).toBe("Permission denied");
  expect(events).toContain("protected_action");
  expect(JSON.parse(await readFile(approval, "utf8"))).toEqual({
    approved: false,
  });
  await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
}, 15000);

test("dialog-only input without a new assistant response is an error", async () => {
  const { make } = await setup();
  expect((await make().run("first")).error).toBeUndefined();
  expect(await make().run("/dialog")).toMatchObject({
    text: "",
    inputPersisted: false,
    interrupted: false,
    error: expect.stringContaining("No new assistant response"),
  });
}, 15000);

test("native crash after restoration cannot return the old answer", async () => {
  const { make, options } = await setup();
  expect((await make().run("first")).text).toBe("fake response");
  const report = await make({
    env: { ...options.env, WORKER_TEST_CRASH_AFTER_RESPONSE: "1" },
  }).run("second");
  expect(report).toMatchObject({
    text: "",
    interrupted: false,
    inputPersisted: true,
    usage: { input: 10, cost: { total: 10 } },
  });
  expect(report.error).toMatch(/42/);
}, 20000);
