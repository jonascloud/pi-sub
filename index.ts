import { getSupportedThinkingLevels, StringEnum } from "@earendil-works/pi-ai";
import {
  defineTool,
  truncateHead,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, stripTerminalSequences } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  Coordinator,
  type TaskView,
  type TaskResult,
} from "./src/coordinator.ts";
import {
  catalogPath,
  describeLevels,
  hasEvidence,
  loadCatalog,
  REFERENCE_COST,
  selectExecution,
} from "./src/models.ts";
import { approvedModels, setupModels, workerDirectory } from "./src/setup.ts";
import { mountWidget } from "./src/widget.ts";

const reason = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export default function piSub(pi: ExtensionAPI): void {
  // Children load normal Pi resources, but must not recursively install their coordinator.
  if (process.env.PI_SUB_CHILD === "1") return;
  let context: ExtensionContext | undefined;
  let coordinator: Coordinator | undefined;
  let unmount: (() => void) | undefined;
  let detachInput: (() => void) | undefined;
  const signals = new WeakSet<AbortSignal>();
  let runInterrupted = false;
  let dialogOpen = false;
  let settingUp = false;
  const lifetime = new AbortController();

  const notify = (text: string, type: "info" | "error" = "info") => {
    if (!lifetime.signal.aborted && context?.hasUI)
      context.ui.notify(text, type);
  };
  const manager = () =>
    (coordinator ??= new Coordinator({
      beforeStart(task) {
        if (!context) throw new Error("No active parent context");
        checkContext(context);
        authorizeTask(task, context);
      },
      onReady(task) {
        if (lifetime.signal.aborted || task.level === undefined) return;
        if (task.outcome === "error") {
          notify(
            `Subagent ${task.id} failed: ${task.error}. It will be collected before the next user prompt.`,
            "error",
          );
          return;
        }
        if (!coordinator?.runnable) return;
        const text = stripTerminalSequences(task.error ?? task.response);
        pi.sendMessage(
          {
            customType: "pi-sub:response",
            display: true,
            content: truncateHead(
              `Subagent ${task.id} (${task.description}) has a response:\n${text}\n\nThis may be a question, not a final result. Use sub_message to answer or sub_result with finish:true to accept and remove the task.`,
              { maxBytes: 8000, maxLines: 100 },
            ).content,
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
      },
    }));
  const checkContext = (ctx: ExtensionContext) => {
    if (lifetime.signal.aborted)
      throw new Error("This Pi session is shutting down.");
    if (!ctx.isProjectTrusted())
      throw new Error(
        "Trust this project before using project-local subagent configuration.",
      );
    context = ctx;
  };
  const interrupt = () => {
    if (lifetime.signal.aborted) return Promise.resolve();
    runInterrupted = true;
    const pending = manager()
      .interrupt()
      .catch((error) =>
        notify(
          `Could not confirm subagent interruption: ${reason(error)}`,
          "error",
        ),
      );
    return pending;
  };
  const observe = (signal: AbortSignal | undefined, compaction = false) => {
    if (!signal || signals.has(signal)) return;
    signals.add(signal);
    const aborted = () => {
      if (compaction || !runInterrupted) interrupt();
    };
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  };
  const preparePrompt = () =>
    manager().prompt((failures: TaskResult[]) => {
      if (!failures.length) return;
      pi.sendMessage(
        {
          customType: "pi-sub:failures",
          display: true,
          content: `Failed subagents were closed and removed before this user input. No cleanup tool call is needed. Decide only how to continue the work.\n${
            truncateHead(
              JSON.stringify(
                failures.map((report) => ({
                  ...report,
                  response: truncateHead(report.response, {
                    maxBytes: 1600,
                    maxLines: 30,
                  }).content,
                  pendingInput: report.pendingInput?.map(
                    (text) =>
                      truncateHead(text, { maxBytes: 1600, maxLines: 30 })
                        .content,
                  ),
                })),
                null,
                2,
              ),
              { maxBytes: 16000, maxLines: 160 },
            ).content
          }\nFull reports remain in message details and native session artifacts.`,
          details: failures,
        },
        { triggerTurn: false },
      );
    });
  const authorizeTask = (task: TaskView, ctx: ExtensionContext) => {
    const execution = task.execution;
    if (
      task.level === undefined &&
      ctx.model?.provider === execution.provider &&
      ctx.model.id === execution.model &&
      (ctx.thinkingLevel ?? "off") === execution.thinking &&
      ctx.modelRegistry
        .getAvailable()
        .some(
          (model) =>
            model.provider === execution.provider &&
            model.id === execution.model,
        )
    )
      return;
    if (
      !approvedModels(ctx).some(
        (model) =>
          model.provider === execution.provider &&
          model.model === execution.model &&
          model.thinking.includes(execution.thinking),
      )
    ) {
      throw new Error(
        "The retained execution is no longer approved or available. Stop this subagent instead.",
      );
    }
    if (task.level !== undefined) {
      const rating = loadCatalog(catalogPath()).candidates.find(
        (candidate) =>
          candidate.provider === execution.provider &&
          candidate.model === execution.model &&
          candidate.thinking === execution.thinking,
      );
      if (!rating || !hasEvidence(rating) || rating.power < task.level)
        throw new Error(
          "The retained execution no longer meets the task's minimum level. Stop this subagent instead.",
        );
    }
  };
  const authorized = (id: string, ctx: ExtensionContext) =>
    authorizeTask(manager().get(id), ctx);
  const response = (value: unknown, error = false) => {
    const raw =
      typeof value === "string" ? value : JSON.stringify(value, null, 2);
    const clipped = truncateHead(raw);
    const usage = coordinator?.drainUsage();
    return {
      content: [
        {
          type: "text" as const,
          text:
            clipped.content +
            (clipped.truncated
              ? "\n[Truncated; full response is in the subagent session file.]"
              : ""),
        },
      ],
      details: value,
      ...(error ? { isError: true } : {}),
      ...(usage ? { usage } : {}),
    };
  };

  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    if (ctx.mode === "tui") {
      unmount?.();
      detachInput?.();
      unmount = mountWidget(ctx.ui, manager());
      detachInput = ctx.ui.onTerminalInput((data) => {
        if (!dialogOpen && matchesKey(data, "escape")) {
          interrupt();
          ctx.abort();
        }
        return undefined;
      });
    }
  });
  pi.on("ui_prompt_start", () => {
    dialogOpen = true;
  });
  pi.on("ui_prompt_end", () => {
    dialogOpen = false;
  });
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return;
    context = ctx;
    try {
      if (!(await preparePrompt())) return { action: "handled" };
    } catch (error) {
      notify(`Could not prepare user input: ${reason(error)}`, "error");
      return { action: "handled" };
    }
  });
  pi.on("turn_start", (_event, ctx) => {
    context = ctx;
    observe(ctx.signal);
  });
  pi.on("agent_start", (_event, ctx) => {
    observe(ctx.signal);
    if (manager().interrupted) ctx.abort();
  });
  pi.on("agent_settled", (event) => {
    if (event.aborted && !runInterrupted) interrupt();
  });
  pi.on("session_before_compact", (event) => {
    observe(event.signal, true);
  });
  pi.on("before_agent_start", (event, ctx) => {
    context = ctx;
    if (manager().interrupted) {
      ctx.abort();
      return;
    }
    runInterrupted = false;
    let table: string;
    try {
      const approved = approvedModels(ctx);
      const catalog = loadCatalog(catalogPath());
      const self = catalog.candidates.find(
        (candidate) =>
          candidate.provider === ctx.model?.provider &&
          candidate.model === ctx.model.id &&
          candidate.thinking === (ctx.thinkingLevel ?? "off"),
      );
      table =
        `Your reviewed power: ${self?.power === undefined ? "unknown" : `${self.power}/10`}.\n` +
        describeLevels(catalog, approved)
          .map((row) =>
            row.execution
              ? `lvl ${row.level}: power ${row.execution.power}, relative reference cost ${(row.execution.cost / REFERENCE_COST).toFixed(3)}×`
              : `lvl ${row.level}: unavailable`,
          )
          .join("\n");
    } catch (error) {
      table = reason(error);
    }
    event.systemPromptOptions.sections.pi_sub = `A subagent is a task with a native Pi session. Each execution uses a fresh short-lived Pi process; ready and paused tasks hold no process. Start bounded tasks with sub_task at the minimum sufficient level; count briefing, research, verification and integration overhead. All tasks are asynchronous. Ordinary replies can be questions: inspect before accepting a final result. Use sub_message for answers/corrections, sub_control for pause/continue/stop, and sub_result finish:true only to accept a final response and remove the task. Redirecting active work interrupts its process, waits for exit and starts a new process on the same session with the correction. Parent interruption pauses children; a new user prompt does not resume them. No child UI dialogs, custom roles or conversation inheritance.\nReference cost is weighted USD per AA Intelligence Index v5.0.1 task including thinking and cache, not a task-cost forecast or subscription price. The 1× baseline is fixed independently of approvals.\nFinal errors are automatically closed, delivered and removed before the next real user prompt, without a cleanup tool call.\nOpen subagents: ${JSON.stringify(
      manager()
        .list()
        .map((task) => ({
          id: task.id,
          description: task.description,
          status: task.status,
          outcome: task.outcome,
        })),
    )}\nCurrent routing (rechecked on admission; not a reservation):\n${table}`;
  });
  pi.on("session_shutdown", async () => {
    lifetime.abort();
    detachInput?.();
    unmount?.();
    await coordinator?.dispose();
  });

  pi.registerCommand("sub:models", {
    description:
      "Update global model ratings for Pi's scoped models (or only the current model when unscoped).",
    handler: async (_args, ctx) => {
      try {
        checkContext(ctx);
        if (settingUp)
          throw new Error(
            "Model setup is already running; inspect or stop its subagent first.",
          );
        const model = ctx.model;
        if (!model)
          throw new Error("Select the setup model with /model first.");
        const thinking = ctx.thinkingLevel ?? "off";
        if (!getSupportedThinkingLevels(model).includes(thinking))
          throw new Error("Unsupported setup thinking level.");
        settingUp = true;
        let sessionDir: string;
        try {
          if (!(await preparePrompt())) {
            settingUp = false;
            return;
          }
          sessionDir = await workerDirectory(ctx.cwd);
        } catch (error) {
          settingUp = false;
          throw error;
        }
        void setupModels({
          coordinator: manager(),
          worker: {
            cwd: ctx.cwd,
            provider: model.provider,
            model: model.id,
            thinking,
            name: "pi-sub model setup",
            sessionDir,
            args: ["--approve"],
          },
          approved: () => approvedModels(context ?? ctx),
          signal: lifetime.signal,
          onStarted(id) {
            notify(
              `Model research started: ${id}. Use /sub:pause or /sub:stop to interrupt it.`,
            );
          },
        })
          .then((result) => {
            notify(`Global model ratings updated: ${result.path}`);
            pi.sendMessage({
              customType: "pi-sub:models",
              display: true,
              content: `Global model ratings updated: ${result.path}. ${result.catalog.candidates.filter(hasEvidence).length} variants have complete evidence. Current Pi availability and scope still govern routing; ratings grant no authorization. Original setup usage will be reported with the next subagent tool result.`,
            });
          })
          .catch((error) =>
            notify(`Model setup failed: ${reason(error)}`, "error"),
          )
          .finally(() => {
            settingUp = false;
          });
      } catch (error) {
        notify(reason(error), "error");
      }
    },
  });
  for (const action of ["pause", "continue", "stop"] as const) {
    pi.registerCommand(`sub:${action}`, {
      description: `${action} one subagent by ID, or all when no ID is supplied.`,
      handler: async (args, ctx) => {
        try {
          checkContext(ctx);
          const id = args.trim();
          if (action === "pause") {
            if (id) await manager().pause(id);
            else {
              const pending = interrupt();
              ctx.abort();
              await pending;
            }
          }
          if (action === "continue") {
            if (!(await preparePrompt())) return;
            const tasks = id
              ? [manager().get(id)]
              : manager()
                  .list()
                  .filter((task) => task.status === "paused");
            for (const task of tasks) authorized(task.id, ctx);
            for (const task of tasks) await manager().continue(task.id);
          }
          if (action === "stop") {
            const results = await Promise.all(
              (id
                ? [id]
                : manager()
                    .list()
                    .map((task) => task.id)
              ).map((taskId) => manager().stop(taskId)),
            );
            if (results.length)
              pi.sendMessage(
                {
                  customType: "pi-sub:stopped",
                  display: true,
                  content: JSON.stringify(results, null, 2),
                },
                { triggerTurn: false },
              );
          }
        } catch (error) {
          notify(reason(error), "error");
        }
      },
    });
  }

  pi.registerTool(
    defineTool({
      name: "sub_task",
      label: "Subagent",
      exposure: "model-only",
      executionMode: "sequential",
      description:
        "Start an asynchronous task with its own native Pi session. Executions use short-lived processes. Requires a capability catalog from /sub:models; level is a minimum, never an inferred default.",
      parameters: Type.Object(
        {
          level: Type.Number({ minimum: 1, maximum: 10, multipleOf: 1 }),
          prompt: Type.String({ minLength: 1 }),
          description: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
      async execute(_call, args, signal, _update, ctx) {
        try {
          checkContext(ctx);
          signal?.throwIfAborted();
          const approved = approvedModels(ctx);
          const execution = selectExecution(
            loadCatalog(catalogPath()),
            args.level,
            approved,
          );
          const sessionDir = await workerDirectory(ctx.cwd);
          signal?.throwIfAborted();
          const id = manager().start({
            prompt: args.prompt,
            description: args.description || args.prompt.slice(0, 80),
            level: args.level,
            worker: {
              ...execution,
              cwd: ctx.cwd,
              name: args.description || "Pi subagent",
              sessionDir,
              args: ["--approve"],
            },
          });
          return response(manager().get(id));
        } catch (error) {
          return response(reason(error), true);
        }
      },
    }),
  );
  pi.registerTool(
    defineTool({
      name: "sub_message",
      label: "Message subagent",
      exposure: "model-only",
      executionMode: "sequential",
      description:
        "Answer or redirect a task in its native session. Active execution is interrupted and fully terminated before a fresh process receives the correction. Paused work resumes only explicitly; ordinary replies are not automatically final results.",
      parameters: Type.Object(
        { id: Type.String(), message: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
      async execute(_call, args, signal, _update, ctx) {
        try {
          checkContext(ctx);
          signal?.throwIfAborted();
          authorized(args.id, ctx);
          await manager().message(args.id, args.message);
          return response(manager().get(args.id));
        } catch (error) {
          return response(reason(error), true);
        }
      },
    }),
  );
  pi.registerTool(
    defineTool({
      name: "sub_result",
      label: "Subagent response",
      exposure: "model-only",
      executionMode: "sequential",
      description:
        "Inspect a task without removing it. Optional wait observes execution completion, not semantic task completion. Timeout never stops work. finish:true accepts a final response and removes the task; its process has already exited. Final errors are collected automatically before the next user prompt. Full history remains in the native session.",
      parameters: Type.Object(
        {
          id: Type.String(),
          wait: Type.Optional(Type.Boolean()),
          timeout: Type.Optional(Type.Number({ minimum: 0, maximum: 3600 })),
          finish: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
      async execute(_call, args, signal, _update, ctx) {
        try {
          checkContext(ctx);
          const task = args.wait
            ? await manager().wait(args.id, signal, (args.timeout ?? 30) * 1000)
            : manager().inspect(args.id);
          return response(
            args.finish ? await manager().collect(task.id) : task,
          );
        } catch (error) {
          return response(reason(error), true);
        }
      },
    }),
  );
  pi.registerTool(
    defineTool({
      name: "sub_control",
      label: "Control subagent",
      exposure: "model-only",
      executionMode: "sequential",
      description:
        "Explicitly pause, continue or stop one subagent by ID. Omitting the ID controls all applicable tasks. Continue does not change the task or its model.",
      parameters: Type.Object(
        {
          id: Type.Optional(Type.String()),
          action: StringEnum(["pause", "continue", "stop"] as const),
        },
        { additionalProperties: false },
      ),
      async execute(_call, args, signal, _update, ctx) {
        try {
          checkContext(ctx);
          signal?.throwIfAborted();
          if (args.action === "stop" && args.id)
            return response(await manager().stop(args.id));
          const tasks = args.id
            ? [manager().get(args.id)]
            : manager()
                .list()
                .filter(
                  (task) =>
                    args.action !== "continue" || task.status === "paused",
                );
          if (args.action === "continue")
            for (const task of tasks) authorized(task.id, ctx);
          const results = await Promise.all(
            tasks.map(async (task) =>
              args.action === "stop"
                ? manager().stop(task.id)
                : (await (args.action === "pause"
                    ? manager().pause(task.id)
                    : manager().continue(task.id)),
                  manager().get(task.id)),
            ),
          );
          return response(results);
        } catch (error) {
          return response(reason(error), true);
        }
      },
    }),
  );
}
