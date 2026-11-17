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
async function setup(
  body: string,
  options: Partial<WorkerOptions> = {},
  continues = false,
) {
  const dir = await mkdtemp(join(tmpdir(), "worker-process-"));
  dirs.push(dir);
  const cliPath = join(dir, "child.cjs");
  await writeFile(cliPath, prelude + body);
  const session = join(dir, "session.jsonl");
  const worker = createWorker(
    {
      cwd: dir,
      sessionDir: join(dir, "sessions"),
      provider: "test",
      model: "fake",
      thinking: "off",
      name: "test",
      cliPath,
      ...options,
    },
    session,
    continues,
  );
  workers.push(worker);
  return { worker, session, dir };
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
const saved = (entries: object[]) =>
  [{ type: "session", version: 3, id: "session" }, ...entries]
    .map((entry) => JSON.stringify(entry))
    .join("\n") + "\n";
const holdPipes = `require('node:child_process').spawn(process.execPath,['-e',"setTimeout(()=>{},6000)"],{stdio:['ignore','inherit','inherit'],detached:true}).unref();`;

test("launch sends the prompt on stdin with fixed native options and reports the saved reply", async () => {
  const { worker, dir } = await setup(`
let input=''; process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
 fs.writeFileSync(file+'.launch', JSON.stringify({args:process.argv,input,env:process.env}));
 append(entry('u',user)); emit({type:'message_end',message:user});
 assistant.content[0].text = 'ä\\u2028middle\\u2029end'; append(entry('a',assistant));
 const bytes=Buffer.from(JSON.stringify({type:'message_end',message:assistant})+'\\r\\n');
 const split=bytes.indexOf(Buffer.from('ä'))+1;
 process.stdout.write(bytes.subarray(0,split));
 setTimeout(()=>process.stdout.write(bytes.subarray(split)),10);
});
`);
  const events: string[] = [];
  worker.onEvent((event) => events.push(event.type));
  const prompt = " \nprivate prompt\nwith lines \t";
  expect(await worker.run(prompt)).toEqual({
    text: "ä\u2028middle\u2029end",
    interrupted: false,
    inputPersisted: true,
    saved: true,
    sessionLost: false,
    usage,
  });
  const launch = JSON.parse(
    await readFile(join(dir, "session.jsonl.launch"), "utf8"),
  );
  expect(spawn).toHaveBeenLastCalledWith(
    process.execPath,
    expect.any(Array),
    expect.any(Object),
  );
  expect(launch.input).toBe(prompt);
  expect(launch.args).not.toContain(prompt);
  for (const [flag, value] of [
    ["--mode", "json"],
    ["--provider", "test"],
    ["--model", "fake"],
    ["--thinking", "off"],
    ["--session", join(dir, "session.jsonl")],
    ["--exclude-tools", "sub_task,sub_message,sub_result,sub_control"],
  ])
    expect(launch.args[launch.args.indexOf(flag) + 1]).toBe(value);
  expect(launch.args).toContain("--print");
  expect(launch.args).not.toContain("--approve");
  expect(launch.env).toMatchObject({
    PI_SUB_CHILD: "1",
    PI_SUB_EXPECTED_PROVIDER: "test",
    PI_SUB_EXPECTED_MODEL: "fake",
    PI_SUB_EXPECTED_THINKING: "off",
  });
  expect(events).toEqual(["message_end", "message_end"]);
});

test("the child guard aborts a model or thinking level other than the assigned one", () => {
  vi.stubEnv("PI_SUB_CHILD", "1");
  vi.stubEnv("PI_SUB_EXPECTED_PROVIDER", "test");
  vi.stubEnv("PI_SUB_EXPECTED_MODEL", "fake");
  vi.stubEnv("PI_SUB_EXPECTED_THINKING", "off");
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const handlers = new Map<
      string,
      (event: unknown, ctx: ExtensionContext) => unknown
    >();
    childGuard({
      on: (
        name: string,
        handler: (event: unknown, ctx: ExtensionContext) => unknown,
      ) => handlers.set(name, handler),
    } as unknown as ExtensionAPI);
    const abort = vi.fn();
    const ctx = {
      model: { provider: "test", id: "fake" },
      thinkingLevel: "off",
      abort,
    } as unknown as ExtensionContext;
    const event = {
      systemPromptOptions: { sections: {} as { pi_sub?: string } },
    };
    handlers.get("before_agent_start")!(event, ctx);
    expect(abort).not.toHaveBeenCalled();
    expect(event.systemPromptOptions.sections.pi_sub).toContain(
      "smallest sufficient handoff",
    );
    Object.assign(ctx, { thinkingLevel: "minimal" }); // A native clamp.
    handlers.get("before_provider_request")!({}, ctx);
    expect(abort).toHaveBeenCalledOnce();
    expect(diagnostic).toHaveBeenCalledWith(
      "Worker model mismatch: expected test/fake thinking=off, got test/fake thinking=minimal",
    );
  } finally {
    diagnostic.mockRestore();
    vi.unstubAllEnvs();
  }
});

test("stop before run prevents spawning", async () => {
  const { worker, session } = await setup(`process.exit(99)`);
  const spawned = vi.mocked(spawn).mock.calls.length;
  await Promise.all([worker.stop(), worker.stop()]);
  expect(await worker.run("hello")).toMatchObject({
    text: "",
    interrupted: true,
    inputPersisted: false,
    saved: false,
  });
  expect(vi.mocked(spawn).mock.calls.length).toBe(spawned);
  await expect(readFile(session)).rejects.toMatchObject({ code: "ENOENT" });
});

test("stopping a continuation during preflight preserves usage, not old input or replies", async () => {
  const { worker, session } = await setup("process.exit(99)", {}, true);
  await writeFile(
    session,
    saved([
      {
        type: "message",
        id: "old-u",
        message: { role: "user", content: "old instruction" },
      },
      {
        type: "message",
        id: "old-a",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "old reply" }],
          stopReason: "stop",
          usage,
        },
      },
    ]),
  );
  const spawned = vi.mocked(spawn).mock.calls.length;
  const run = worker.run("new instruction");
  await worker.stop(); // readSession has yielded, but no child has started.
  expect(await run).toEqual({
    text: "",
    interrupted: true,
    inputPersisted: false,
    saved: true,
    sessionLost: false,
    usage,
  });
  expect(vi.mocked(spawn).mock.calls.length).toBe(spawned);
});

test.each([false, true])(
  "stop waits for exit and reports what the session saved; force kill=%s",
  async (force) => {
    const { worker } = await setup(`
process.on('SIGTERM', () => { ${force ? "" : `setTimeout(()=>{ append(entry('a',assistant)); process.exit(0); },100);`} });
append(entry('u',user)); emit({type:'agent_start'});
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
    expect(report).toMatchObject({
      text: force ? "" : "new response",
      interrupted: true,
      inputPersisted: true,
      sessionLost: false,
    });
    expect(report).not.toHaveProperty("error");
    expect(Date.now() - start).toBeGreaterThanOrEqual(force ? 900 : 80);
  },
  10000,
);

test("an input the session never saved is reported as unsent", async () => {
  const { worker } = await setup(`
emit({type:'message_end',message:user}); emit({type:'agent_start'});
setInterval(()=>{},1000);
`);
  const ready = nextEvent(worker);
  const running = worker.run("hello");
  await ready;
  await worker.stop();
  // Streamed events precede the write: only the saved entry is evidence.
  expect(await running).toMatchObject({
    interrupted: true,
    inputPersisted: false,
    saved: true,
  });
});

test("output is progress only: a streamed reply the session never saved is no reply", async () => {
  const { worker } = await setup(
    `append(entry('u',user)); process.stdout.write('{broken}\\nnull\\n'); emit({type:'message_end',message:assistant}); process.stdout.write('{"type":"agent_st');`,
  );
  const events: string[] = [];
  worker.onEvent((event) => events.push(event.type));
  expect(await worker.run("hello")).toMatchObject({
    text: "",
    error: "No new assistant response",
    inputPersisted: true,
  });
  expect(events).toEqual(["message_end"]); // Malformed frames are skipped, not fatal.
});

test.each(["error", "aborted", "length", "toolUse"])(
  "exit zero does not hide native %s",
  async (reason) => {
    const { worker } = await setup(
      `assistant.stopReason=${JSON.stringify(reason)}; append(entry('a',assistant));`,
    );
    expect(await worker.run("hello")).toMatchObject({
      text: "new response",
      error: `Native response ended with ${reason}`,
      interrupted: false,
    });
  },
);

test("a crash after saved work fails the execution but keeps its session", async () => {
  const { worker } = await setup(
    `append(entry('u',user)); assistant.stopReason='toolUse'; append(entry('a',assistant)); console.error('AbortError: The operation was aborted'); process.exit(1);`,
  );
  expect(await worker.run("hello")).toEqual({
    text: "new response",
    error: "Native process exited 1: AbortError: The operation was aborted",
    interrupted: false,
    inputPersisted: true,
    saved: true,
    sessionLost: false,
    usage,
  });
});

test("a descendant holding the pipes cannot keep an exited execution open", async () => {
  const { worker } = await setup(
    `append(entry('u',user)); append(entry('a',assistant)); ${holdPipes} process.exit(0);`,
  );
  const start = Date.now();
  const report = await worker.run("hello");
  expect(report).toMatchObject({ text: "new response", interrupted: false });
  expect(report).not.toHaveProperty("error");
  expect(Date.now() - start).toBeLessThan(3000);
}, 10000);

test("a stop arriving while an exited execution drains does not turn its reply into an interruption", async () => {
  const { worker } = await setup(
    `append(entry('u',user)); append(entry('a',assistant)); emit({type:'agent_settled',aborted:false}); ${holdPipes} process.exit(0);`,
  );
  const settled = nextEvent(worker, "agent_settled");
  const running = worker.run("hello");
  await settled;
  await new Promise((resolve) => setTimeout(resolve, 300));
  await worker.stop();
  const report = await running;
  expect(report).toMatchObject({ text: "new response", interrupted: false });
  expect(report).not.toHaveProperty("error");
}, 10000);

test("stop is bounded by exit, not by a descendant holding the pipes", async () => {
  const { worker } = await setup(
    `${holdPipes} emit({type:'agent_start'}); setInterval(()=>{},1000);`,
  );
  const ready = nextEvent(worker);
  const running = worker.run("hello");
  await ready;
  const start = Date.now();
  await worker.stop();
  expect(await running).toMatchObject({ interrupted: true });
  expect(Date.now() - start).toBeLessThan(3000);
}, 10000);

test("only replies this execution saved count, and usage covers the whole session once", async () => {
  const { worker, session } = await setup(
    `emit({type:'agent_settled',aborted:false});`,
    {},
    true,
  );
  await writeFile(
    session,
    saved([
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
    ]) + "{cut off by a kill",
  );
  expect(await worker.run("hello")).toMatchObject({
    text: "",
    error: "No new assistant response",
    inputPersisted: false,
    saved: true,
    sessionLost: false, // A malformed line is skipped, as the native loader does.
    usage: {
      input: 50,
      reasoning: 10,
      cacheWrite1h: 5,
      cost: { total: 50, totalFromProvider: true },
    },
  });
});

test("a first start that saved nothing may repeat", async () => {
  const { worker } = await setup(`fs.unlinkSync(file);`);
  const report = await worker.run("hello");
  expect(report).toMatchObject({
    error: "Native session file is missing",
    saved: false,
    sessionLost: false,
  });
  expect(report.usage).toBeUndefined();
  const { worker: unstartable } = await setup("", {
    cwd: "/nonexistent/pi-worker-test",
  });
  expect(await unstartable.run("hello")).toMatchObject({
    error: expect.stringMatching(/ENOENT/),
    saved: false,
    sessionLost: false,
  });
});

test("a session that existed and is gone is lost, before or during an execution", async () => {
  const gone = await setup("process.exit(99)", {}, true);
  const spawned = vi.mocked(spawn).mock.calls.length;
  expect(await gone.worker.run("hello")).toMatchObject({
    error: "Native session file is missing",
    inputPersisted: false,
    sessionLost: true,
  });
  expect(vi.mocked(spawn).mock.calls.length).toBe(spawned);

  const removed = await setup(
    `emit({type:'agent_start'}); setInterval(()=>{},1000);`,
    {},
    true,
  );
  await writeFile(removed.session, saved([]));
  const started = nextEvent(removed.worker);
  const running = removed.worker.run("hello");
  await started;
  await rm(removed.session);
  await removed.worker.stop();
  expect(await running).toMatchObject({
    error: "Native session file is missing",
    interrupted: true,
    sessionLost: true,
  });
});
