import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Coordinator } from "./coordinator.ts";
import {
  catalogPath,
  parseCatalog,
  saveCatalog,
  type ApprovedModel,
  type Catalog,
} from "./models.ts";
import type { WorkerOptions } from "./worker.ts";

/** Native Pi scoping is authoritative. Without a scope, use only the current model. */
export function approvedModels(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry" | "scopedModels">,
): ApprovedModel[] {
  const available = new Set(
    ctx.modelRegistry
      .getAvailable()
      .map((model) => `${model.provider}/${model.id}`),
  );
  const scoped = ctx.scopedModels.length
    ? ctx.scopedModels
    : ctx.model
      ? [{ model: ctx.model, thinkingLevel: undefined }]
      : [];
  const models = new Map<string, ApprovedModel>();
  for (const entry of scoped) {
    const key = `${entry.model.provider}/${entry.model.id}`;
    if (!available.has(key)) continue;
    const supported = getSupportedThinkingLevels(entry.model);
    const thinking = entry.thinkingLevel
      ? supported.filter((level) => level === entry.thinkingLevel)
      : supported;
    if (!thinking.length) continue;
    const previous = models.get(key);
    models.set(key, {
      provider: entry.model.provider,
      model: entry.model.id,
      thinking: [...new Set([...(previous?.thinking ?? []), ...thinking])],
    });
  }
  return [...models.values()].sort((a, b) =>
    `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`),
  );
}

function snapshot(models: readonly ApprovedModel[]): string {
  return JSON.stringify(
    models
      .map((model) => ({ ...model, thinking: [...model.thinking].sort() }))
      .sort((a, b) =>
        `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`),
      ),
  );
}

export interface SetupOptions {
  coordinator: Coordinator;
  cwd: string;
  worker: WorkerOptions;
  approved: () => ApprovedModel[];
  signal?: AbortSignal;
  onStarted?: (id: string) => void;
}

/** Research is an ordinary supervised task; only a validated complete proposal replaces the catalog. */
export async function setupModels(
  options: SetupOptions,
): Promise<{ id: string; catalog: Catalog; path: string }> {
  options.signal?.throwIfAborted();
  const approved = options.approved();
  if (!approved.length)
    throw new Error(
      "No approved models are available. Select a model or configure /scoped-models first.",
    );
  const instructions = await readFile(
    new URL("../instructions/model-capabilities.md", import.meta.url),
    "utf8",
  );
  options.signal?.throwIfAborted();
  const directory = dirname(catalogPath(options.cwd));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, ".gitignore"), "*\n", {
    flag: "wx",
    mode: 0o600,
  }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  options.signal?.throwIfAborted();
  const id = options.coordinator.start({
    description: "Build model capabilities",
    worker: options.worker,
    prompt: `${instructions}\n\nApproved snapshot (copy exactly into approved):\n${JSON.stringify(approved, null, 2)}\n\nReturn only the catalog JSON. Do not write or activate configuration files.`,
  });
  options.onStarted?.(id);
  let response = "";
  try {
    const task = await options.coordinator.wait(id, options.signal);
    if (
      !("status" in task) ||
      task.status !== "ready" ||
      task.outcome !== "reply"
    )
      throw new Error(task.error ?? "Setup stopped or failed.");
    response = task.response;
    const catalog = parseCatalog(response, approved);
    if (!catalog.candidates.some((candidate) => candidate.selected))
      throw new Error("Research produced no supported, evidenced selection.");
    const verify = () => {
      options.signal?.throwIfAborted();
      if (snapshot(approved) !== snapshot(options.approved()))
        throw new Error(
          "Model approval changed during research; run /sub:models again.",
        );
    };
    verify();
    // Capture the final response and original usage, then close its process before activation.
    await options.coordinator.collect(id);
    verify();
    const path = catalogPath(options.cwd);
    await saveCatalog(path, catalog, verify);
    return { id, catalog, path };
  } catch (error) {
    try {
      if (options.coordinator.get(id).outcome !== "error")
        await options.coordinator.stop(id);
    } catch {
      /* shutdown or prompt cleanup already removed the task */
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${reason}${response ? `\nResearch response: ${response.slice(0, 1600)}` : ""}\nPrevious catalog was not replaced.`,
    );
  }
}

export function workerDirectory(cwd: string): string {
  return join(cwd, ".pi", "pi-sub", "sessions");
}
