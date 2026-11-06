import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Coordinator } from "./coordinator.ts";
import {
  ladderPath,
  parseReference,
  validateLadder,
  formatLadder,
  readLadderSource,
  saveLadder,
  type AvailableModel,
  type Ladder,
} from "./models.ts";
import type { WorkerOptions } from "./worker.ts";

/** Native availability is a hard limit; the confirmed ladder, not parent scope, authorizes delegation. */
export function availableModels(
  ctx: Pick<ExtensionContext, "modelRegistry">,
): AvailableModel[] {
  const models = new Map<string, AvailableModel>();
  for (const model of ctx.modelRegistry.getAvailable()) {
    const thinking = getSupportedThinkingLevels(model);
    if (thinking.length)
      models.set(`${model.provider}/${model.id}`, {
        provider: model.provider,
        model: model.id,
        thinking,
      });
  }
  return [...models.values()].sort((a, b) =>
    `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`),
  );
}

export interface SetupView {
  phase: "choosing" | "working" | "review" | "saving";
  revision: number;
  id?: string;
  current?: Ladder;
  currentError?: string;
  draft?: Ladder;
  comparison?: string;
  paused: boolean;
}
export interface SetupOptions {
  coordinator: Coordinator;
  available: () => AvailableModel[];
  choose: (
    available: AvailableModel[],
    current: Ladder | undefined,
    signal: AbortSignal,
  ) => Promise<AvailableModel[] | undefined>;
  prepare: () => Promise<boolean>;
  signal?: AbortSignal;
  onChange: (view: SetupView | undefined) => void;
  onReport: (report: { content: string; details?: unknown }) => void;
  onSaved: (path: string) => void;
}
type Session = {
  path: string;
  source?: string;
  current?: Ladder;
  available: AvailableModel[];
  selected: AvailableModel[];
  choice?: AbortController;
  id?: string;
  revision: number;
  response?: string;
  observer?: AbortController;
};
const reason = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Only an explicit, revision-bound acceptance can publish research. */
export class ModelSetup {
  private session?: Session;
  private state?: SetupView;
  private disposed = false;
  private revision = 0;
  private unsubscribe: () => void;
  private abort = () => {
    void this.cancel();
  };
  constructor(private readonly options: SetupOptions) {
    this.unsubscribe = options.coordinator.subscribe(() => {
      const s = this.session;
      if (!s || !this.state) return;
      if (!s.id) {
        if (s.choice && options.coordinator.interrupted) this.close(s);
        return;
      }
      try {
        const paused = options.coordinator.get(s.id).status === "paused";
        if (paused !== this.state.paused) {
          this.state = { ...this.state, paused };
          this.emit();
        }
      } catch {
        /* Task removal is handled by its observer. */
      }
    });
    options.signal?.addEventListener("abort", this.abort, { once: true });
  }
  get active(): boolean {
    return this.session !== undefined;
  }
  get view(): SetupView | undefined {
    return this.state && structuredClone(this.state);
  }
  private notify(callback: () => void) {
    try {
      callback();
    } catch {
      /* Observers do not own resources. */
    }
  }
  private emit() {
    this.notify(() => this.options.onChange(this.view));
  }
  private valid(s: Session) {
    if (this.disposed || this.options.signal?.aborted || this.session !== s)
      throw new Error("Model setup is no longer current");
  }
  private close(s: Session) {
    s.choice?.abort();
    s.observer?.abort();
    if (this.session !== s) return;
    this.session = undefined;
    this.state = undefined;
    this.emit();
  }
  private async stop(s: Session) {
    if (!s.id) return;
    try {
      await this.options.coordinator.stop(s.id);
    } catch (error) {
      this.notify(() =>
        this.options.onReport({
          content: `Model setup task could not stop: ${reason(error)}`,
          details: { id: s.id },
        }),
      );
    }
  }
  private async fail(s: Session, error: unknown) {
    if (this.session !== s || this.disposed) return;
    this.close(s);
    this.notify(() =>
      this.options.onReport({
        content: `Model setup failed: ${reason(error)}`,
        details: { id: s.id },
      }),
    );
    await this.stop(s);
  }
  async open(worker: WorkerOptions): Promise<void> {
    if (this.active) throw new Error("Model setup is already active");
    if (this.disposed || this.options.signal?.aborted)
      throw new Error("Model setup disposed or aborted");
    const s: Session = {
      path: ladderPath(),
      available: [],
      selected: [],
      revision: ++this.revision,
    };
    this.session = s; // Reserve before prepare or any other asynchronous operation.
    this.state = { phase: "choosing", revision: s.revision, paused: false };
    this.emit();
    try {
      if (!(await this.options.prepare())) {
        this.close(s);
        return;
      }
      this.valid(s);
      s.source = readLadderSource(s.path);
      let currentError: string | undefined;
      if (s.source !== undefined) {
        try {
          s.current = validateLadder(JSON.parse(s.source));
        } catch (error) {
          currentError = reason(error);
        }
      }
      s.available = structuredClone(this.options.available());
      this.valid(s);
      if (!s.available.length)
        throw new Error("No native models are currently available");
      s.choice = new AbortController();
      this.state = { ...this.state!, current: s.current, currentError };
      this.emit();
      this.valid(s);
      const epoch = this.options.coordinator.interruptEpoch;
      const chosen = await this.options.choose(
        structuredClone(s.available),
        s.current && structuredClone(s.current),
        s.choice.signal,
      );
      this.valid(s);
      if (
        this.options.coordinator.interrupted ||
        this.options.coordinator.interruptEpoch !== epoch
      ) {
        this.close(s);
        return;
      }
      if (chosen === undefined) {
        this.close(s);
        return;
      }
      if (!chosen.length)
        throw new Error("Select at least one available model");
      const current = this.options.available();
      this.valid(s);
      s.selected = chosen.map((choice) => {
        const found = current.find(
          (model) =>
            model.provider === choice.provider && model.model === choice.model,
        );
        const offered = s.available.find(
          (model) =>
            model.provider === choice.provider && model.model === choice.model,
        );
        if (!found || !offered)
          throw new Error(
            `Selected model is no longer available: ${choice.provider}/${choice.model}`,
          );
        const thinking = found.thinking.filter((level) =>
          offered.thinking.includes(level),
        );
        if (!thinking.length)
          throw new Error(
            `Selected model has no offered thinking level available: ${choice.provider}/${choice.model}`,
          );
        return { ...found, thinking };
      });
      s.choice = undefined;
      this.state = { ...this.state!, phase: "working" };
      this.emit();
      this.valid(s);
      const instructions = await readFile(
        new URL("../instructions/model-capabilities.md", import.meta.url),
        "utf8",
      );
      const sessionDir =
        worker.sessionDir ?? (await workerDirectory(worker.cwd));
      this.valid(s);
      if (
        this.options.coordinator.interrupted ||
        this.options.coordinator.interruptEpoch !== epoch
      ) {
        this.close(s);
        return;
      }
      s.id = this.options.coordinator.start({
        description: "Review model ladder",
        level: undefined,
        worker: { ...worker, sessionDir },
        prompt: `${instructions}\n\nSelected variants (research only):\n${JSON.stringify(s.selected)}\n\nCurrent ladder:\n${JSON.stringify(s.current ?? null)}\n${currentError ? `Current ladder is malformed; propose an explicit repair. ${currentError}\n` : ""}`,
      });
      this.state = {
        phase: "working",
        revision: s.revision,
        id: s.id,
        current: s.current,
        currentError,
        paused: false,
      };
      this.emit();
      this.observe(s);
    } catch (error) {
      await this.fail(s, error);
    }
  }
  private authorize(ladder: Ladder, s: Session, available: AvailableModel[]) {
    const contains = (
      models: AvailableModel[],
      ref: ReturnType<typeof parseReference>,
    ) =>
      models.some(
        (model) =>
          model.provider === ref.provider &&
          model.model === ref.model &&
          model.thinking.includes(ref.thinking),
      );
    for (const [level, row] of Object.entries(ladder)) {
      const ref = parseReference(row.model);
      const old = s.current?.[level];
      const unchanged = old?.model === row.model && old.cost === row.cost;
      const selected = contains(s.selected, ref);
      // An already confirmed unavailable entry may remain unchanged, not silently regraded.
      if (unchanged && !contains(s.available, ref)) continue;
      if (!selected)
        throw new Error(
          `Model selection does not authorize rung ${level}: ${row.model}`,
        );
      if (!contains(available, ref))
        throw new Error(
          `Model is no longer available at rung ${level}: ${row.model}`,
        );
    }
  }
  private observe(s: Session) {
    s.observer?.abort();
    const observer = new AbortController();
    s.observer = observer;
    const revision = s.revision;
    void (async () => {
      try {
        const task = await this.options.coordinator.wait(
          s.id!,
          observer.signal,
        );
        if (
          observer.signal.aborted ||
          this.session !== s ||
          s.revision !== revision ||
          this.disposed
        )
          return;
        if (
          !("status" in task) ||
          task.status !== "ready" ||
          task.outcome !== "reply"
        )
          throw new Error(task.error ?? "Research stopped or failed");
        const source = task.response.trim();
        const fenced = /^```json\r?\n([\s\S]*?)\r?\n```$/.exec(source);
        const raw = JSON.parse(fenced ? fenced[1]! : source);
        if (
          !raw ||
          typeof raw !== "object" ||
          Array.isArray(raw) ||
          Object.keys(raw).sort().join(",") !== "comparison,ladder" ||
          typeof raw.comparison !== "string" ||
          !raw.comparison.trim()
        )
          throw new Error("Expected exactly ladder and a nonempty comparison");
        const draft = validateLadder(raw.ladder);
        this.authorize(draft, s, this.options.available());
        s.response = task.response;
        this.state = {
          ...this.state!,
          phase: "review",
          draft,
          comparison: raw.comparison,
          paused: false,
        };
        this.emit();
        if (
          observer.signal.aborted ||
          this.session !== s ||
          s.revision !== revision ||
          this.disposed
        )
          return;
        this.notify(() =>
          this.options.onReport({
            content: `${raw.comparison}\n\nDRAFT (not saved):\n${formatLadder(draft)}`,
            details: {
              task,
              proposal: {
                ladder: structuredClone(draft),
                comparison: raw.comparison,
              },
            },
          }),
        );
      } catch (error) {
        if (!observer.signal.aborted && s.revision === revision)
          await this.fail(s, error);
      }
    })();
  }
  async revise(text: string): Promise<void> {
    const s = this.session;
    if (!s?.id) throw new Error("Choose models in the dialog before refining");
    this.valid(s);
    if (this.state?.phase === "saving")
      throw new Error("Model setup is busy saving");
    if (!text.trim()) throw new Error("Refinement must not be empty");
    s.observer?.abort();
    s.revision = ++this.revision;
    const revision = s.revision;
    this.state = {
      ...this.state!,
      revision: s.revision,
      phase: "working",
      draft: undefined,
      comparison: undefined,
    };
    this.emit();
    try {
      await this.options.coordinator.message(s.id, text);
      this.valid(s);
      if (s.revision === revision) this.observe(s);
    } catch (error) {
      if (s.revision === revision) await this.fail(s, error);
      throw error;
    }
  }
  async accept(expectedRevision: number): Promise<void> {
    const s = this.session;
    const draft = this.state?.draft;
    if (
      !s?.id ||
      !draft ||
      this.state?.phase !== "review" ||
      s.revision !== expectedRevision
    )
      throw new Error("No finished current draft at that revision");
    const id = s.id;
    const epoch = this.options.coordinator.interruptEpoch;
    const response = s.response;
    const verify = () => {
      const available = this.options.available();
      this.valid(s);
      if (
        s.id !== id ||
        s.revision !== expectedRevision ||
        this.state?.draft !== draft ||
        this.state.phase !== "saving"
      )
        throw new Error("Model setup draft changed");
      if (
        this.options.coordinator.interrupted ||
        this.options.coordinator.interruptEpoch !== epoch
      )
        throw new Error("Model setup interrupted before commit");
      const task = this.options.coordinator.get(id);
      if (
        task.status !== "ready" ||
        task.outcome !== "reply" ||
        task.response !== response
      )
        throw new Error("Research is no longer ready");
      this.authorize(draft, s, available);
    };
    this.state = { ...this.state, phase: "saving" };
    this.emit();
    try {
      verify();
      await saveLadder(s.path, draft, s.source, verify);
    } catch (error) {
      await this.fail(s, error);
      throw error;
    }
    // Publication is final, including when cancel runs during post-commit cleanup.
    this.notify(() => this.options.onSaved(s.path));
    this.close(s);
    try {
      await this.options.coordinator.collect(id);
    } catch {
      await this.stop(s);
    }
  }
  async cancel(): Promise<void> {
    const s = this.session;
    if (!s) return;
    this.close(s);
    await this.stop(s);
  }
  dispose(): void {
    this.disposed = true;
    const s = this.session;
    if (s) this.close(s);
    this.unsubscribe();
    this.options.signal?.removeEventListener("abort", this.abort);
  }
}

export async function workerDirectory(cwd: string): Promise<string> {
  const directory = join(cwd, ".pi", "pi-sub");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, ".gitignore"), "*\n", {
    flag: "wx",
    mode: 0o600,
  }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  return join(directory, "sessions");
}
