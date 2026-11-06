import { getSupportedThinkingLevels, StringEnum } from "@earendil-works/pi-ai";
import {
  defineTool,
  truncateHead,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  stripTerminalSequences,
  type Component,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  Coordinator,
  type TaskView,
  type TaskResult,
} from "./src/coordinator.ts";
import {
  ladderPath,
  loadLadder,
  parseReference,
  selectExecution,
} from "./src/models.ts";
import {
  approvedModels,
  ModelSetup,
  workerDirectory,
  type SetupView,
} from "./src/setup.ts";
import { renderModelSelection } from "./src/model-view.ts";
import { mountWidget, availableWidgetHeight } from "./src/widget.ts";
import {
  SUBAGENT_GUIDANCE,
  failureSummary,
  replyNotification,
  renderReply,
  routingSummary,
} from "./src/messages.ts";

const reason = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export default function piSub(pi: ExtensionAPI): void {
  // Children load normal Pi resources, but must not recursively install their coordinator.
  if (process.env.PI_SUB_CHILD === "1") return;
  pi.registerMessageRenderer("pi-sub:response", renderReply);
  let context: ExtensionContext | undefined;
  let coordinator: Coordinator | undefined;
  let unmount: (() => void) | undefined;
  let detachInput: (() => void) | undefined;
  const signals = new WeakSet<AbortSignal>();
  let runInterrupted = false;
  let dialogOpen = false;
  let selection: ModelSetup | undefined;
  const lifetime = new AbortController();

  const notify = (text: string, type: "info" | "error" = "info") => {
    text = stripTerminalSequences(text);
    if (lifetime.signal.aborted) return;
    if (context?.hasUI) context.ui.notify(text, type);
    else if (type === "error") console.error(text);
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
          notify(`${task.description} (${task.id}): ${task.error}`, "error");
          return;
        }
        if (!coordinator?.runnable) return;
        pi.sendMessage(replyNotification(task), {
          deliverAs: "followUp",
          triggerTurn: !selection?.active,
        });
      },
    }));
  const checkContext = (ctx: ExtensionContext) => {
    if (lifetime.signal.aborted)
      throw new Error("This Pi session is shutting down.");
    if (!ctx.isProjectTrusted())
      throw new Error("Trust this project before starting native subagents.");
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
          content: failureSummary(failures),
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
      const retained = Object.entries(loadLadder(ladderPath())).some(
        ([level, entry]) => {
          const ref = parseReference(entry.model);
          return (
            Number(level) >= task.level! &&
            ref.provider === execution.provider &&
            ref.model === execution.model &&
            ref.thinking === execution.thinking
          );
        },
      );
      if (!retained)
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

  const refreshSelection = (view: SetupView | undefined) => {
    if (!context?.hasUI) return;
    context.ui.setWidget(
      "pi-sub:models",
      view
        ? (tui) => {
            const component: Component = {
              render(width) {
                return renderModelSelection(
                  selection?.view,
                  width,
                  availableWidgetHeight(tui, component, width),
                );
              },
              invalidate() {},
            };
            return component;
          }
        : undefined,
      { placement: "aboveEditor" },
    );
  };
  const reportSelection = (report: { content: string; details?: unknown }) => {
    if (lifetime.signal.aborted) return;
    pi.sendMessage(
      {
        customType: "pi-sub:models",
        display: true,
        content: truncateHead(stripTerminalSequences(report.content), {
          maxBytes: 24000,
          maxLines: 300,
        }).content,
        details: report.details,
      },
      { triggerTurn: false },
    );
  };
  const modelSelection = () =>
    (selection ??= new ModelSetup({
      coordinator: manager(),
      approved: () => (context ? approvedModels(context) : []),
      prepare: preparePrompt,
      signal: lifetime.signal,
      onChange: refreshSelection,
      onReport: reportSelection,
      onSaved: (path) =>
        reportSelection({
          content: `Model ladder saved: ${path}`,
        }),
    }));
  const cancelSelection = async () => {
    const setup = selection;
    const shown = setup?.view;
    if (!setup?.active)
      throw new Error("No model selection is open. Run /sub:models.");
    // Invalidate publication immediately, not after unrelated input preparation.
    await setup.cancel();
    reportSelection({
      content: `Model selection ${shown?.revision ?? ""} closed.`,
    });
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
    if (event.source !== "interactive" && event.source !== "rpc") return;
    context = ctx;
    const wasSelecting = selection?.active;
    const shown = selection?.view;
    try {
      if (wasSelecting && event.text.trim().toLowerCase() === "cancel") {
        await selection!.cancel(); // Close the publication gate before asynchronous preparation.
        if (await preparePrompt())
          reportSelection({
            content: `Model selection ${shown?.revision ?? ""} closed.`,
          });
        return { action: "handled" };
      }
      if (!(await preparePrompt())) return { action: "handled" };
      if (wasSelecting || selection?.active) {
        if (!selection?.active)
          throw new Error(
            "Model selection closed while preparing input. Run /sub:models to begin again.",
          );
        if (
          shown?.id
            ? selection.view?.id !== shown.id
            : selection.view?.revision !== shown?.revision
        )
          throw new Error(
            "Model selection changed while preparing input. Please review it before resubmitting.",
          );
        const action = event.text.trim().toLowerCase();
        if (action === "accept") {
          if (shown?.phase !== "review")
            throw new Error(
              "No finished draft was shown to accept. Wait for the proposal.",
            );
          await selection.accept(shown.revision);
        } else {
          if (event.images?.length)
            throw new Error(
              "Model selection accepts text refinements; reference image files by path.",
            );
          await selection.revise(event.text);
        }
        return { action: "handled" };
      }
    } catch (error) {
      notify(`Could not prepare user input: ${reason(error)}`, "error");
      const current = selection?.view;
      if (
        wasSelecting &&
        ctx.hasUI &&
        current &&
        shown &&
        current.revision === shown.revision &&
        current.id === shown.id
      )
        ctx.ui.setEditorText(event.text);
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
      const ladder = loadLadder(ladderPath());
      const self = Object.entries(ladder)
        .filter(([, entry]) => {
          const ref = parseReference(entry.model);
          return (
            ref.provider === ctx.model?.provider &&
            ref.model === ctx.model.id &&
            ref.thinking === (ctx.thinkingLevel ?? "off")
          );
        })
        .map(([level]) => Number(level));
      table =
        `Your configured strength: ${self.length ? Math.max(...self) + "/10" : "unknown"}.\n` +
        "Ladder · reference USD/AA task, not actual price or quota:\n" +
        routingSummary(ladder, approved);
    } catch (error) {
      table = reason(error);
    }
    event.systemPromptOptions.sections.pi_sub = `${SUBAGENT_GUIDANCE}\n\nOpen tasks (snapshot): ${JSON.stringify(
      manager()
        .list()
        .map((task) => ({
          id: task.id,
          description: task.description,
          status: task.status,
          outcome: task.outcome,
        })),
    )}\n\n${table}`;
  });
  pi.on("session_shutdown", async () => {
    lifetime.abort();
    selection?.dispose();
    detachInput?.();
    unmount?.();
    await coordinator?.dispose();
  });

  pi.registerCommand("sub:models", {
    description:
      "Review the global model ladder. Refine by prompt, then accept or cancel explicitly.",
    getArgumentCompletions: (prefix) =>
      ["cancel"]
        .filter((action) => action.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      try {
        checkContext(ctx);
        if (!ctx.hasUI)
          throw new Error(
            "Model selection requires a TUI or RPC session. Edit the global ladder directly in print mode.",
          );
        const action = args.trim().toLowerCase();
        if (action === "accept")
          throw new Error(
            "Type accept in the normal prompt to save the shown draft.",
          );
        if (action === "cancel") {
          await cancelSelection();
          return;
        }
        if (action)
          throw new Error(
            "Use /sub:models to review, type accept to save, or use /sub:models cancel.",
          );
        if (selection?.active) {
          refreshSelection(selection.view);
          return;
        }
        const model = ctx.model;
        if (!model)
          throw new Error("Select the setup model with /model first.");
        const thinking = ctx.thinkingLevel ?? "off";
        if (!getSupportedThinkingLevels(model).includes(thinking))
          throw new Error("Unsupported setup thinking level.");
        await modelSelection().open({
          cwd: ctx.cwd,
          provider: model.provider,
          model: model.id,
          thinking,
          name: "pi-sub model selection",
          args: ["--approve", "--tools", "-write,-edit,-bash,-codemode"],
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
        "Start an asynchronous, self-contained task at the required minimum level.",
      parameters: Type.Object(
        {
          level: Type.Number({ minimum: 1, maximum: 10, multipleOf: 1 }),
          prompt: Type.String({ minLength: 1 }),
          description: Type.Optional(
            Type.String({ description: "Short task label." }),
          ),
        },
        { additionalProperties: false },
      ),
      async execute(_call, args, signal, _update, ctx) {
        try {
          checkContext(ctx);
          signal?.throwIfAborted();
          const approved = approvedModels(ctx);
          const execution = selectExecution(
            loadLadder(ladderPath()),
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
        "Send an answer or correction. Interrupts active work; explicitly resumes paused tasks.",
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
        "Read or wait for a response. finish:true accepts/removes a ready response; a timeout only ends the wait.",
      parameters: Type.Object(
        {
          id: Type.String(),
          wait: Type.Optional(Type.Boolean()),
          timeout: Type.Optional(
            Type.Number({
              minimum: 0,
              maximum: 3600,
              description: "Wait timeout in seconds; default 30.",
            }),
          ),
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
        "Pause, continue or stop tasks; omit id for all applicable tasks. Stopping never rolls back side effects.",
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
