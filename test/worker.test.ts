import { afterEach, expect, test, vi } from "vitest";
import { spawn } from "node:child_process";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import childGuard from "../src/child.ts";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorker,
  type Worker,
  type WorkerOptions,
} from "../src/worker.ts";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const dirs: string[] = [];
const workers: Worker[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
const usage = {
  input: 10,
  output: 3,
  cacheRead: 2,
  cacheWrite: 1,
  totalTokens: 16,
  reasoning: 2,
  cacheWrite1h: 1,
  cost: {
    input: 1,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
    total: 10,
    totalFromProvider: true,
  },
};
const prelude = `
const fs = require('node:fs');
const file = process.argv[process.argv.indexOf('--session') + 1];
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
const append = value => fs.appendFileSync(file, JSON.stringify(value) + '\\n');
if (!fs.existsSync(file)) append({type:'session',version:3,id:'session'});
const entry = (id,message) => ({type:'message',id,parentId:null,timestamp:new Date().toISOString(),message});
const user = {role:'user',content:[{type:'text',text:'hello'}],timestamp:Date.now()};
const assistant = {role:'assistant',content:[{type:'text',text:'new response'}],stopReason:'stop',usage:${JSON.stringify(usage)},timestamp:Date.now()};
`;
async function setup(body: string, options: Partial<WorkerOptions> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "worker-process-"));
  dirs.push(dir);
  const cliPath = join(dir, "child.cjs");
  await writeFile(cliPath, prelude + body);
  const session = join(dir, "session.jsonl");
  const config: WorkerOptions = {
    cwd: dir,
    provider: "test",
    model: "fake",
    thinking: "off",
    name: "test",
    cliPath,
    ...options,
  };
  const worker = createWorker(config, session);
  workers.push(worker);
  return { worker, session, dir, config };
}
function nextEvent(worker: Worker, type = "agent_start") {
  return new Promise<void>((resolve) => {
    const off = worker.onEvent((event) => {
      if (event.type === type) {
        off();
        resolve();
      }
    });
  });
}

test("launch uses stdin and fixed native options, LF-only framing and split UTF-8", async () => {
  const { worker, dir } = await setup(
    `
let input=''; process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
 fs.writeFileSync(file+'.args', JSON.stringify({args:process.argv,input,child:process.env.PI_SUB_CHILD}));
 user.content=input.trim(); append(entry('u',user)); emit({type:'message_end',message:user});
 assistant.content[0].text = 'ä\\u2028middle\\u2029end'; append(entry('a',assistant));
 const bytes=Buffer.from(JSON.stringify({type:'message_end',message:assistant})+'\\r\\n');
 const split=bytes.indexOf(Buffer.from('ä'))+1;
 process.stdout.write(bytes.subarray(0,split));
 setTimeout(()=>process.stdout.write(bytes.subarray(split)),10);
});
`,
  );
  const events: string[] = [];
  worker.onEvent((event) => events.push(event.type));
  const prompt = " \nprivate prompt\nwith lines \t";
  const report = await worker.run(prompt);
  expect(report).toMatchObject({
    text: "ä\u2028middle\u2029end",
    interrupted: false,
    inputPersisted: true,
    usage,
  });
  expect(report.error).toBeUndefined();
  const launch = JSON.parse(
    await readFile(join(dir, "session.jsonl.args"), "utf8"),
  );
  expect(spawn).toHaveBeenLastCalledWith(
    "node",
    expect.any(Array),
    expect.any(Object),
  );
  expect(launch.input).toBe(prompt);
  expect(launch.args).not.toContain(prompt);
  expect(launch.args).toEqual(
    expect.arrayContaining([
      "--mode",
      "json",
      "--print",
      "--session",
      "-e",
      "--exclude-tools",
    ]),
  );
  expect(launch.args).not.toContain("--approve");
  expect(launch.child).toBe("1");
  expect(events).toEqual(["message_end", "message_end"]);
  await expect(worker.run("again")).rejects.toThrow("once");
});

test("child guard rejects a switched assignment journal through public session context", () => {
  vi.stubEnv("PI_SUB_CHILD", "1");
  vi.stubEnv("PI_SUB_EXPECTED_PROVIDER", "test");
  vi.stubEnv("PI_SUB_EXPECTED_MODEL", "fake");
  vi.stubEnv("PI_SUB_EXPECTED_THINKING", "off");
  vi.stubEnv("PI_SUB_EXPECTED_SESSION_FILE", "/expected/task.jsonl");
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const on =
      vi.fn<
        (
          type: string,
          handler: (event: unknown, ctx: ExtensionContext) => unknown,
        ) => void
      >();
    childGuard({ on } as unknown as ExtensionAPI);
    const beforeStart = on.mock.calls.find(
      ([type]) => type === "before_agent_start",
    )![1];
    let sessionFile = "/expected/task.jsonl";
    const abort = vi.fn();
    const ctx = {
      model: { provider: "test", id: "fake" },
      thinkingLevel: "off",
      sessionManager: { getSessionFile: () => sessionFile },
      abort,
    } as unknown as ExtensionContext;
    beforeStart({}, ctx);
    expect(abort).not.toHaveBeenCalled();
    sessionFile = "/unrelated/task.jsonl";
    beforeStart({}, ctx);
    expect(abort).toHaveBeenCalledOnce();
    expect(diagnostic).toHaveBeenCalledWith(
      expect.stringContaining("Worker session mismatch"),
    );
  } finally {
    diagnostic.mockRestore();
    vi.unstubAllEnvs();
  }
});

test("stop before run prevents spawning; stop is idempotent", async () => {
  const { worker, session } = await setup(`process.exit(99)`);
  await Promise.all([worker.stop(), worker.stop()]);
  expect(await worker.run("hello")).toMatchObject({
    text: "",
    interrupted: true,
    inputPersisted: false,
  });
  await expect(readFile(session)).rejects.toMatchObject({ code: "ENOENT" });
});

test.each([false, true])(
  "stop waits for drained close; force kill=%s",
  async (force) => {
    const { worker } = await setup(`
process.on('SIGTERM', () => { ${force ? "" : `setTimeout(()=>{ emit({type:'message_end',message:assistant}); process.exit(0); },100);`} });
emit({type:'agent_start'}); emit({type:'agent_settled',aborted:false});
setInterval(()=>{},1000);
`);
    const ready = nextEvent(worker);
    let finished = false;
    const running = worker.run("hello").then((report) => {
      finished = true;
      return report;
    });
    await ready;
    expect(finished).toBe(false);
    const start = Date.now();
    await Promise.all([worker.stop(), worker.stop()]);
    const report = await running;
    expect(report.interrupted).toBe(true);
    expect(report.inputPersisted).toBe(false);
    expect(report.text).toBe(force ? "" : "new response");
    expect(Date.now() - start).toBeGreaterThanOrEqual(force ? 900 : 80);
  },
  10000,
);

test("even exit is not close while an inherited stdout pipe is open", async () => {
  const { worker } = await setup(`
require('node:child_process').spawn(process.execPath,['-e',"setTimeout(()=>console.log(JSON.stringify({type:'message_end',message:"+JSON.stringify(assistant)+"})),150)"],{stdio:['ignore',process.stdout,'ignore']});
process.exit(0);
`);
  expect(await worker.run("hello")).toMatchObject({
    text: "new response",
    interrupted: false,
  });
});

test("failed bounded stop can be retried without settling run before close", async () => {
  const { worker } = await setup(`
require('node:child_process').spawn(process.execPath,['-e',"setTimeout(()=>process.exit(0),4500)"],{stdio:['ignore',process.stdout,'ignore']});
emit({type:'agent_start'}); setInterval(()=>{},1000);
`);
  const ready = nextEvent(worker);
  let completed = false;
  const running = worker.run("hello").then((report) => {
    completed = true;
    return report;
  });
  await ready;
  await expect(worker.stop()).rejects.toThrow("stop may be retried");
  expect(completed).toBe(false);
  await worker.stop();
  expect(await running).toMatchObject({ interrupted: true });
}, 10000);

test("failed internal termination stays pending and external stop can retry", async () => {
  const { worker } = await setup(`
require('node:child_process').spawn(process.execPath,['-e',"setTimeout(()=>process.exit(0),4500)"],{stdio:['ignore',process.stdout,'ignore']});
emit({type:'agent_start'}); process.stdout.write('{broken}\\n'); setInterval(()=>{},1000);
`);
  const ready = nextEvent(worker);
  let completed = false;
  const running = worker.run("hello").then((report) => {
    completed = true;
    return report;
  });
  await ready;
  // The internal bounded attempt times out while the inherited pipe stays open.
  // Vitest also fails this test if its rejected stop promise goes unhandled.
  await new Promise((resolve) => setTimeout(resolve, 3300));
  expect(completed).toBe(false);
  await worker.stop();
  expect(await running).toMatchObject({
    error: "Invalid native JSON output",
    interrupted: true,
  });
}, 10000);

test.each(["error", "aborted", "length", "toolUse"])(
  "exit zero does not hide native %s",
  async (reason) => {
    const { worker } = await setup(
      `assistant.stopReason=${JSON.stringify(reason)}; append(entry('a',assistant)); emit({type:'message_end',message:assistant});`,
    );
    expect(await worker.run("hello")).toMatchObject({
      text: "new response",
      error: expect.stringContaining(reason),
      interrupted: false,
    });
  },
);

test.each(["{broken}\\n", '{"type":"agent_start"}', "null\\n"])(
  "corrupt or partial JSON output is reported: %s",
  async (output) => {
    const { worker } = await setup(
      `process.stdout.write(${JSON.stringify(output.replaceAll("\\n", "\n"))});`,
    );
    expect((await worker.run("hello")).error).toMatch(/JSON/);
  },
);

test("fatal malformed output terminates internally and drains the final response", async () => {
  const { worker } = await setup(`
process.on('SIGTERM',()=>{
 emit({type:'message_end',message:user});
 emit({type:'message_end',message:assistant});
 setTimeout(()=>process.exit(0),100);
});
process.stdout.write('{broken}\\n');
setInterval(()=>{},1000);
`);
  const report = await worker.run("hello");
  expect(report).toMatchObject({
    error: "Invalid native JSON output",
    interrupted: false,
    inputPersisted: true,
    text: "new response",
  });
}, 10000);

test("oversized live output triggers bounded force kill without reporting interruption", async () => {
  const { worker } = await setup(`
process.on('SIGTERM',()=>{});
process.stdout.write('x'.repeat(16*1024*1024+1));
setInterval(()=>{},1000);
`);
  expect(await worker.run("hello")).toMatchObject({
    error: "Native JSON record exceeds size limit",
    interrupted: false,
  });
}, 10000);

test("partial output at EOF terminates a still-live child", async () => {
  const { worker } = await setup(`
process.stdout.end('{"type":"agent_start"}');
setInterval(()=>{},1000);
`);
  expect(await worker.run("hello")).toMatchObject({
    error: "Incomplete native JSON output at EOF",
    interrupted: false,
  });
}, 10000);

test("explicit interruption tolerates a truncated final progress frame", async () => {
  const { worker } = await setup(`
append(entry('u',user));
emit({type:'agent_start'});
process.stdout.write('{"type":');
setInterval(()=>{},1000);
`);
  const started = nextEvent(worker);
  const running = worker.run("hello");
  await started;
  await worker.stop();
  expect(await running).toMatchObject({
    interrupted: true,
    inputPersisted: true,
  });
  expect((await running).error).toBeUndefined();
});

test("explicit interruption does not hide a damaged native journal", async () => {
  const { worker } = await setup(`
append(entry('u',user));
fs.appendFileSync(file,'{broken}\\n');
emit({type:'agent_start'});
setInterval(()=>{},1000);
`);
  const started = nextEvent(worker);
  const running = worker.run("hello");
  await started;
  await worker.stop();
  expect(await running).toMatchObject({
    interrupted: true,
    error: "Corrupt native session file",
  });
});

test("continuous draining bounds diagnostics without deadlocking", async () => {
  const { worker } = await setup(
    `process.stderr.write('x'.repeat(200000)); process.exitCode=42;`,
  );
  const report = await worker.run("hello");
  expect(report.error).toMatch(/42/);
  expect(report.error!.length).toBeLessThan(17000);
});

test("a new saved user entry proves persistence even when output is lost", async () => {
  const { worker } = await setup(
    `append(entry('u',user)); emit({type:'agent_start'}); setInterval(()=>{},1000);`,
  );
  const ready = nextEvent(worker);
  const running = worker.run("hello");
  await ready;
  await worker.stop();
  expect(await running).toMatchObject({
    interrupted: true,
    inputPersisted: true,
  });
});

test("unrelated new user messages do not acknowledge interrupted execution input", async () => {
  const { worker } = await setup(`
user.content=[{type:'text',text:'unrelated startup or follow-up'}];
append(entry('unrelated',user)); emit({type:'message_end',message:user});
emit({type:'agent_start'}); setInterval(()=>{},1000);
`);
  const ready = nextEvent(worker);
  const running = worker.run("original brief");
  await ready;
  await worker.stop();
  expect(await running).toMatchObject({
    interrupted: true,
    inputPersisted: false,
  });
});

test("no stale restored assistant; cumulative native usage counts every entry once", async () => {
  const { worker, session } = await setup(
    `emit({type:'agent_settled',aborted:false});`,
  );
  const entries = [
    { type: "session", id: "session", version: 3 },
    {
      type: "message",
      id: "a",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "stale" }],
        stopReason: "stop",
        usage,
      },
    },
    { type: "message", id: "t", message: { role: "toolResult", usage } },
    ...["compaction", "branch_summary", "usage"].map((type) => ({
      type,
      id: type,
      usage,
    })),
  ];
  await writeFile(
    session,
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
  const report = await worker.run("hello");
  expect(report).toMatchObject({
    text: "",
    error: "No new assistant response",
    inputPersisted: false,
    usage: {
      input: 50,
      reasoning: 10,
      cacheWrite1h: 5,
      cost: { total: 50, totalFromProvider: true },
    },
  });
});

test("a damaged final journal cannot discard previously confirmed native usage", async () => {
  const { worker, session } = await setup(`
fs.writeFileSync(file,JSON.stringify({type:'session',version:3,id:'session'})+'\\n');
append(entry('new',assistant));
fs.appendFileSync(file,'{broken}\\n');
`);
  await writeFile(
    session,
    [
      { type: "session", version: 3, id: "session" },
      {
        type: "message",
        id: "old",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "old" }],
          stopReason: "stop",
          usage,
        },
      },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n") + "\n",
  );
  expect(await worker.run("hello")).toMatchObject({
    error: "Corrupt native session file",
    usage: { totalTokens: 32, cost: { total: 20 } },
  });
});

test("a damaged preflight ledger is not offered as a smaller replacement snapshot", async () => {
  const { worker, session } = await setup("");
  await writeFile(
    session,
    [
      { type: "session", version: 3, id: "session" },
      {
        type: "message",
        id: "old",
        message: { role: "assistant", content: [], stopReason: "stop", usage },
      },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n") + "\n{broken}\n",
  );
  const report = await worker.run("hello");
  expect(report.error).toBe("Corrupt native session file");
  expect(report.usage).toBeUndefined();
});

test("missing usage is not invented", async () => {
  const { worker } = await setup(
    `delete assistant.usage; append(entry('a',assistant)); emit({type:'message_end',message:assistant});`,
  );
  expect((await worker.run("hello")).usage).toBeUndefined();
});

test("corrupt saved session is not passed to native loader or rewritten", async () => {
  const { worker, session } = await setup(
    `fs.writeFileSync(file,'overwritten');`,
  );
  await writeFile(session, "{broken}\n");
  expect(await worker.run("hello")).toMatchObject({
    error: "Corrupt native session file",
    inputPersisted: false,
  });
  expect(await readFile(session, "utf8")).toBe("{broken}\n");
});

test("missing saved session and spawn failure resolve failure reports", async () => {
  const { worker } = await setup(`fs.unlinkSync(file);`);
  expect((await worker.run("hello")).error).toMatch(/missing/);
  const { worker: failed } = await setup("", {
    cwd: "/nonexistent/pi-worker-test",
  });
  expect((await failed.run("hello")).error).toMatch(/ENOENT/);
});
