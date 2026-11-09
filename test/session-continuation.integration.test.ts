import { expect, test } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorker, type WorkerOptions } from "../src/worker.ts";

type ApiMessage = {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: { id: string }[];
};

/** Actual native OpenAI-compatible conversion, not a synthetic provider accepting invalid history. */
test("native CLI resumes an interrupted real tool call with valid provider history", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-sub-tool-resume-"));
  const session = join(cwd, "task.jsonl");
  const marker = join(cwd, "tool-started");
  const requests: { messages: ApiMessage[] }[] = [];
  let invalidHistory = false;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body) as { messages: ApiMessage[] };
    requests.push(parsed);
    const outstanding = new Set<string>();
    for (const message of parsed.messages) {
      if (message.role === "tool") outstanding.delete(message.tool_call_id!);
      else {
        if (outstanding.size) invalidHistory = true;
        for (const call of message.tool_calls ?? []) outstanding.add(call.id);
      }
    }
    if (outstanding.size) invalidHistory = true;
    if (invalidHistory) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { message: "Unpaired tool call in restored request" },
        }),
      );
      return;
    }
    const first = requests.length === 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (
      delta: unknown,
      finishReason: string | null,
      usage?: unknown,
    ) => {
      response.write(
        `data: ${JSON.stringify({ id: "local-test", object: "chat.completion.chunk", created: 1, model: "fake", choices: [{ index: 0, delta, finish_reason: finishReason }], ...(usage ? { usage } : {}) })}\n\n`,
      );
    };
    chunk(
      first
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "sleep-call",
                type: "function",
                function: {
                  name: "bash",
                  arguments: JSON.stringify({
                    command: `printf started > ${JSON.stringify(marker)}; sleep 30`,
                  }),
                },
              },
            ],
          }
        : {
            role: "assistant",
            content: "Continued after the interrupted tool.",
          },
      null,
    );
    chunk({}, first ? "tool_calls" : "stop", {
      prompt_tokens: 10,
      completion_tokens: 2,
      total_tokens: 12,
    });
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("No test server address");
  const extension = join(cwd, "provider.ts");
  await writeFile(
    extension,
    `export default pi => pi.registerProvider('resume-test', {
    baseUrl:'http://127.0.0.1:${address.port}/v1',apiKey:'test',api:'openai-completions',
    models:[{id:'fake',name:'Local resume test',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:100000,maxTokens:1000}]
  });`,
  );
  const options: WorkerOptions = {
    cwd,
    sessionDir: join(cwd, "sessions"),
    provider: "resume-test",
    model: "fake",
    thinking: "off",
    name: "resume test",
    env: { PI_CODING_AGENT_DIR: join(cwd, "agent") },
    args: ["--no-extensions", "-e", extension, "--tools", "bash"],
  };
  const first = createWorker(options, session);
  const second = createWorker(options, session);
  try {
    const running = first.run("Start the long-running tool.");
    const deadline = Date.now() + 15000;
    while (true) {
      try {
        await readFile(marker);
        break;
      } catch {
        if (Date.now() >= deadline) throw Error("Native tool did not start");
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    }
    await first.stop();
    expect(await running).toMatchObject({
      interrupted: true,
      inputPersisted: true,
    });
    const continued = await second.run(
      "Do not repeat the tool. Explain that execution was interrupted.",
    );
    expect(continued.error).toBeUndefined();
    expect(continued.text).toBe("Continued after the interrupted tool.");
    expect(requests).toHaveLength(2);
    expect(invalidHistory).toBe(false);
    expect(JSON.stringify(requests[1]!.messages)).toContain(
      "Start the long-running tool.",
    );
    expect(JSON.stringify(requests[1]!.messages)).toContain(
      "Do not repeat the tool.",
    );
  } finally {
    await Promise.all([first.stop(), second.stop()]);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(cwd, { recursive: true, force: true });
  }
}, 30000);
