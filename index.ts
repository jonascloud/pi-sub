import { getSupportedThinkingLevels, StringEnum } from "@earendil-works/pi-ai";
import {
  defineTool,
  truncateHead,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, stripTerminalSequences } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Coordinator, type TaskView } from "./src/coordinator.ts";
import {
  catalogPath,
  describeLevels,
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
  let detachSignal: (() => void) | undefined;
  let latchedSignal: AbortSignal | undefined;
  let interrupted = false;
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
        const text = stripTerminalSequences(task.error ?? task.response);
        pi.sendMessage(
          {
            customType: "pi-sub:response",
            display: true,
            content: truncateHead(
              `Subagent ${task.id} (${task.description}) has a response:\n${text}\n\nThis may be a question, not a final result. Use sub_message to answer or sub_result with finish:true to accept and close it.`,
              { maxBytes: 8000, maxLines: 100 },
            ).content,
          },
          interrupted
            ? { deliverAs: "nextTurn" }
            : { deliverAs: "followUp", triggerTurn: true },
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
  const pauseAll = () => {
    interrupted = true;
    void coordinator
      ?.pauseAll()
      .catch((error) =>
        notify(
          `Could not confirm subagent interruption: ${reason(error)}`,
          "error",
        ),
      );
  };
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
        if (!dialogOpen && matchesKey(data, "escape")) pauseAll();
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
  pi.on("turn_start", (_event, ctx) => {
    context = ctx;
    if (ctx.signal === latchedSignal) return;
    detachSignal?.();
    latchedSignal = ctx.signal;
    if (!ctx.signal) {
      detachSignal = undefined;
      return;
    }
    const signal = ctx.signal;
    signal.addEventListener("abort", pauseAll, { once: true });
    detachSignal = () => signal.removeEventListener("abort", pauseAll);
    if (signal.aborted) pauseAll();
  });
  pi.on("before_agent_start", (event, ctx) => {
    context = ctx;
    if (event.messageType === "user") interrupted = false;
    let table: string;
    try {
      const approved = approvedModels(ctx);
      const catalog = loadCatalog(catalogPath(ctx.cwd), approved);
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
    event.systemPromptOptions.sections.pi_sub = `Subagents are independent native Pi processes. Start bounded tasks with sub_task at the minimum sufficient level; count briefing, research, verification and integration overhead. All tasks are asynchronous. Ordinary replies can be questions: inspect before accepting a final result. Use sub_message for answers/corrections, sub_control for pause/continue/stop, and sub_result finish:true only to accept a final response and close its process. Parent interruption pauses children; a new user prompt does not resume them. No child UI dialogs, custom roles or conversation inheritance.\nReference cost is weighted USD per AA Intelligence Index v5.0.1 task including thinking and cache, not a task-cost forecast or subscription price. The 1× baseline is fixed independently of approvals.\nCurrent routing (rechecked on admission; not a reservation):\n${table}`;
  });
  pi.on("session_shutdown", async () => {
    lifetime.abort();
    detachSignal?.();
    detachInput?.();
    unmount?.();
    await coordinator?.dispose();
  });

  pi.registerCommand("sub:models", {
    description:
      "Research and build capabilities for Pi's scoped models (or only the current model when unscoped).",
    handler: async (_args, ctx) => {
      try {
        checkContext(ctx);
        if (settingUp)
          throw new Error(
            "Model setup is already running; inspect or stop its subagent first.",
          );
        if (!ctx.model)
          throw new Error("Select the setup model with /model first.");
        const thinking = ctx.thinkingLevel ?? "off";
        if (!getSupportedThinkingLevels(ctx.model).includes(thinking))
          throw new Error("Unsupported setup thinking level.");
        settingUp = true;
        void setupModels({
          coordinator: manager(),
          cwd: ctx.cwd,
          worker: {
            cwd: ctx.cwd,
            provider: ctx.model.provider,
            model: ctx.model.id,
            thinking,
            name: "pi-sub model setup",
            sessionDir: workerDirectory(ctx.cwd),
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
            notify(`Model catalog activated: ${result.path}`);
            pi.sendMessage({
              customType: "pi-sub:models",
              display: true,
              content: `Model catalog activated with ${result.catalog.candidates.filter((candidate) => candidate.selected).length} selected variants. Original setup usage will be reported with the next subagent tool result.`,
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
              interrupted = true;
              await manager().pauseAll();
            }
          }
          if (action === "continue") {
            const tasks = id
              ? [manager().get(id)]
              : manager()
                  .list()
                  .filter((task) => task.status === "paused");
            for (const task of tasks) authorized(task.id, ctx);
            interrupted = false;
            for (const task of tasks) await manager().continue(task.id);
          }
          if (action === "stop") {
            if (id) await manager().stop(id);
            else
              await Promise.all(
                manager()
                  .list()
                  .map((task) => manager().stop(task.id)),
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
        "Start an asynchronous task in a native Pi process. Requires a capability catalog from /sub:models; level is a minimum, never an inferred default.",
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
            loadCatalog(catalogPath(ctx.cwd), approved),
            args.level,
            approved,
          );
          const id = manager().start({
            prompt: args.prompt,
            description: args.description || args.prompt.slice(0, 80),
            level: args.level,
            worker: {
              ...execution,
              cwd: ctx.cwd,
              name: args.description || "Pi subagent",
              sessionDir: workerDirectory(ctx.cwd),
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
        "Answer or redirect an existing task. Running work is steered; paused work resumes with the correction; ready replies are not automatically final results.",
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
        "Read a task response without closing it. Optional wait observes only; timeout or wait interruption does not itself stop the child. finish:true accepts a final ready/error result, captures usage and closes its process. Large output is truncated; the native session file retains it.",
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
          const task: TaskView = args.wait
            ? await manager().wait(args.id, signal, (args.timeout ?? 30) * 1000)
            : manager().get(args.id);
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
          await Promise.all(
            tasks.map((task) =>
              args.action === "pause"
                ? manager().pause(task.id)
                : args.action === "continue"
                  ? manager().continue(task.id)
                  : manager().stop(task.id),
            ),
          );
          return response(tasks.map((task) => manager().get(task.id)));
        } catch (error) {
          return response(reason(error), true);
        }
      },
    }),
  );
}
