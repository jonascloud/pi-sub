import { expect, test } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RpcClient, getPackageDir } from "@earendil-works/pi-coding-agent";

/** Real parent Pi + real child Pi; only the model provider is synthetic. */
test("loads the extension, bootstraps a catalog and attributes child usage exactly once", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-sub-extension-"));
  const agentDir = join(cwd, "agent");
  await mkdir(agentDir);
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      extensions: [resolve("test/fixtures/provider.js"), resolve("index.ts")],
    }),
  );
  const client = new RpcClient({
    cliPath: join(getPackageDir(), "dist/cli.js"),
    cwd,
    provider: "worker-test",
    model: "fake",
    args: ["--thinking", "off", "--approve"],
    env: {
      PI_CODING_AGENT_DIR: agentDir,
      PI_SUB_CHILD: "",
      WORKER_TEST_INTEGRATION: "1",
    },
  });
  try {
    await client.start();
    await client.getState();
    expect(
      (await client.getCommands()).some(
        (command) => command.name === "sub:models",
      ),
    ).toBe(true);
    expect(await client.prompt("/sub:models")).toBe("handled");
    const path = join(cwd, ".pi/pi-sub/models.json");
    const deadline = Date.now() + 20000;
    let catalog: { candidates: { selected: boolean }[] } | undefined;
    while (Date.now() < deadline) {
      try {
        catalog = JSON.parse(await readFile(path, "utf8"));
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    expect(catalog, client.getStderr()).toBeDefined();
    expect(
      catalog!.candidates.filter((candidate) => candidate.selected),
    ).toHaveLength(1);

    await client.promptAndWait("integration:delegate", undefined, 20000);
    const messages = await client.getMessages();
    const results = messages.filter((message) => message.role === "toolResult");
    expect(
      results.some(
        (message) =>
          message.role === "toolResult" &&
          message.toolName === "sub_task" &&
          !message.isError,
      ),
    ).toBe(true);
    const final = results.find(
      (message) =>
        message.role === "toolResult" && message.toolName === "sub_result",
    );
    expect(final && final.role === "toolResult" && final.isError).toBe(false);
    const stats = await client.getSessionStats();
    // One setup child + one task child, plus the parent's own synthetic responses.
    expect(stats.cost).toBe(stats.assistantMessages * 10 + 20);
    expect(stats.tokens.input).toBe(stats.assistantMessages * 10 + 20);

    await client.promptAndWait("integration:repeat", undefined, 20000);
    const repeated = await client.getSessionStats();
    expect(repeated.cost).toBe(repeated.assistantMessages * 10 + 20);

    const created = Promise.withResolvers<void>();
    const timer = setTimeout(
      () => created.reject(new Error("Parent did not create the child")),
      10000,
    );
    const unsubscribe = client.onEvent((event) => {
      if (event.type === "tool_execution_end" && event.toolName === "sub_task")
        created.resolve();
    });
    try {
      await client.prompt("integration:pause");
      await created.promise;
      await client.abort();
    } finally {
      clearTimeout(timer);
      unsubscribe();
    }
    await client.promptAndWait("integration:inspect", undefined, 20000);
    const pausedResult = (await client.getMessages()).findLast(
      (message) =>
        message.role === "toolResult" && message.toolName === "sub_result",
    );
    if (!pausedResult || pausedResult.role !== "toolResult")
      throw new Error("Missing paused response");
    const paused = JSON.parse(
      pausedResult.content.find((part) => part.type === "text")!.text,
    );
    expect(paused.status).toBe("paused"); // A new parent prompt did not resume the child.
    await client.promptAndWait("integration:continue", undefined, 20000);
    await client.promptAndWait("integration:accept", undefined, 20000);
    const acceptedResult = (await client.getMessages()).findLast(
      (message) =>
        message.role === "toolResult" && message.toolName === "sub_result",
    );
    if (!acceptedResult || acceptedResult.role !== "toolResult")
      throw new Error("Missing accepted response");
    expect(
      JSON.parse(
        acceptedResult.content.find((part) => part.type === "text")!.text,
      ),
    ).toMatchObject({ status: "closed", collected: true });
  } finally {
    await client.stop();
    await rm(cwd, { recursive: true, force: true });
  }
}, 60000);
