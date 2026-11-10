import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type AgentBeforeSettleEvent,
  type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  Coordinator,
  type TaskView,
  type TaskResult,
} from "./src/coordinator.ts";
import {
  availableExecutions,
  availableModels,
  ladderPath,
  loadLadder,
  parseReference,
  selectExecution,
} from "./src/models.ts";
import { Workspace } from "./src/workspace.ts";
import { taskToolRenderers } from "./src/tool-view.ts";
import { mountWidget } from "./src/widget.ts";
import {
  SUBAGENT_GUIDANCE,
  renderReply,
  renderFailures,
  renderStopped,
} from "./src/messages.ts";
import { pendingReplyBatch, deliveredReplies } from "./src/replies.ts";
import { reportResult, type Reports } from "./src/reports.ts";

const reason = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export default function piSub(pi: ExtensionAPI): void {
  // Children load normal Pi resources, but must not recursively install their coordinator.
  if (process.env.PI_SUB_CHILD === "1") return;
  pi.registerMessageRenderer("pi-sub:response", renderReply);
  pi.registerMessageRenderer("pi-sub:failures", renderFailures);
  pi.registerMessageRenderer("pi-sub:stopped", renderStopped);
  const workspace = new Workspace();
  let context: ExtensionContext | undefined;
  let coordinator: Coordinator | undefined;
  let unmount: (() => void) | undefined;
  const signals = new WeakSet<AbortSignal>();
  let runInterrupted = false;
  let dialogOpen = false;
  const lifetime = new AbortController();
  let idleDelivery: ReturnType<typeof setImmediate> | undefined;

  const replyBatchFor = (ctx: ExtensionContext, messages?: AgentMessage[]) =>
    lifetime.signal.aborted || !coordinator?.runnable
      ? undefined
      : pendingReplyBatch(
          coordinator.list(),
          ctx.sessionManager,
          messages,
          workspace,
        );
  const scheduleReplies = () => {
    if (idleDelivery || lifetime.signal.aborted || !coordinator?.runnable)
      return;
    // Coalesce this event-loop turn; never debounce, poll or queue a follow-up
    // behind an active parent that may read or supersede these replies itself.
    idleDelivery = setImmediate(() => {
      idleDelivery = undefined;
      const ctx = context;
      if (
        !ctx?.isIdle() ||
        dialogOpen ||
        lifetime.signal.aborted ||
        !coordinator?.runnable
      )
        return;
      try {
        const batch = replyBatchFor(ctx);
        if (batch) pi.sendMessage(batch, { triggerTurn: true });
      } catch (error) {
        notify(
          `Could not deliver subagent responses: ${reason(error)}`,
          "error",
        );
      }
    });
  };

  const notify = (text: string, type: "info" | "error" = "info") => {
    text = stripTerminalSequences(text).replace(
      /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,
      "",
    );
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
        if (lifetime.signal.aborted) return;
        if (task.outcome === "error") {
          notify(`${task.description} · failed\n${task.error}`, "error");
          return;
        }
        scheduleReplies();
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
  const preparePrompt = async () => {
    const prepared = await manager().prompt((failures: TaskResult[]) => {
      if (!failures.length) return;
      const result = reportResult(failures, workspace);
      pi.sendMessage(
        {
          customType: "pi-sub:failures",
          display: true,
          content: result.content[0]!.text,
          details: result.details,
        },
        { triggerTurn: false },
      );
    });
    if (prepared) scheduleReplies();
    return prepared;
  };
  const authorizeTask = (task: TaskView, ctx: ExtensionContext) => {
    const execution = task.execution;
    if (
      !availableModels(ctx).some(
        (model) =>
          model.provider === execution.provider &&
          model.model === execution.model &&
          model.thinking.includes(execution.thinking),
      )
    ) {
      throw new Error(
        "The retained execution is no longer available. Stop this subagent instead.",
      );
    }
    const retained = Object.entries(loadLadder(ladderPath())).some(
      ([level, entry]) => {
        const ref = parseReference(entry);
        return (
          Number(level) >= task.level &&
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
  };
  const authorized = (id: string, ctx: ExtensionContext) =>
    authorizeTask(manager().get(id), ctx);
  const response = (value: Reports, error = false) => {
    const result = reportResult(value, workspace);
    const usage = coordinator?.drainUsage();
    return {
      ...result,
      ...(error ? { isError: true } : {}),
      ...(usage ? { usage } : {}),
    };
  };

  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    if (ctx.mode === "tui") {
      unmount?.();
      unmount = mountWidget(ctx.ui, manager());
    }
  });
  pi.on("ui_prompt_start", () => {
    dialogOpen = true;
  });
  pi.on("ui_prompt_end", () => {
    dialogOpen = false;
    scheduleReplies();
  });
  pi.on("input", async (event, ctx) => {
    if (event.source !== "interactive" && event.source !== "rpc") return;
    context = ctx;
    try {
      if (!(await preparePrompt())) return { action: "handled" };
    } catch (error) {
      notify(`Could not prepare user input: ${reason(error)}`, "error");
      return { action: "handled" };
    }
  });
  // Only complete model-visible context acknowledges a reply. Announcements
  // and boundary proposals alone must not collapse its outstanding widget row.
  pi.on("context", (event) => {
    if (lifetime.signal.aborted || !coordinator) return;
    for (const message of event.messages)
      for (const reply of deliveredReplies(message))
        coordinator.markDelivered(reply.id, reply.replyId);
  });
  const deliverAtBoundary = (
    event: TurnEndEvent | AgentBeforeSettleEvent,
    ctx: ExtensionContext,
  ) => {
    context = ctx;
    if (event.outcome !== "completed" || ctx.signal?.aborted || dialogOpen)
      return;
    const batch = replyBatchFor(ctx, [
      ...event.context.contextMessages,
      ...event.context.pendingMessages,
    ]);
    if (!batch) return;
    return {
      entries: [
        ...event.entries,
        { type: "custom_message" as const, ...batch },
      ],
      // Natural tool/queue continuation satisfies this request; Pi does not add
      // another turn on top of it.
      continue: true,
    };
  };
  pi.on("turn_end", deliverAtBoundary);
  pi.on("agent_before_settle", deliverAtBoundary);
  pi.on("turn_start", (_event, ctx) => {
    context = ctx;
    observe(ctx.signal);
  });
  pi.on("agent_start", (_event, ctx) => {
    observe(ctx.signal);
    if (manager().interrupted) ctx.abort();
  });
  pi.on("agent_settled", (event, ctx) => {
    context = ctx;
    if (event.aborted) {
      if (!runInterrupted) interrupt();
    } else scheduleReplies(); // Includes replies arriving after the final boundary.
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
    let availability: string;
    try {
      const max = availableExecutions(
        loadLadder(ladderPath()),
        availableModels(ctx),
      ).at(-1)?.power;
      availability = `Available ladder levels (snapshot): ${max ? (max === 1 ? "1" : `1–${max}`) : "none"}.`;
    } catch (error) {
      availability = `Delegation unavailable: ${reason(error)}`;
    }
    const tasks = manager()
      .list()
      .map(({ id, description, status, outcome }) => ({
        id,
        description,
        status,
        outcome,
      }));
    event.systemPromptOptions.sections.pi_sub =
      `${SUBAGENT_GUIDANCE}\n\n${availability}` +
      (tasks.length ? `\n\nOpen tasks: ${JSON.stringify(tasks)}` : "");
  });
  pi.on("session_shutdown", async () => {
    lifetime.abort();
    if (idleDelivery) clearImmediate(idleDelivery);
    unmount?.();
    await coordinator?.dispose();
    workspace.dispose();
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
            if (!tasks.length) notify("No paused tasks.");
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
            if (results.length) {
              const result = reportResult(results, workspace);
              pi.sendMessage(
                {
                  customType: "pi-sub:stopped",
                  display: true,
                  content: result.content[0]!.text,
                  details: result.details,
                },
                { triggerTurn: false },
              );
            } else notify("No tasks to stop.");
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
      ...taskToolRenderers("sub_task"),
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
          const execution = selectExecution(
            loadLadder(ladderPath()),
            args.level,
            availableModels(ctx),
          );
          const id = manager().start({
            prompt: args.prompt,
            description: args.description || args.prompt.slice(0, 80),
            level: args.level,
            worker: {
              ...execution,
              cwd: ctx.cwd,
              name: args.description || "Pi subagent",
              sessionDir: workspace.sessions,
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
      ...taskToolRenderers("sub_message"),
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
      ...taskToolRenderers("sub_result"),
      label: "Subagent response",
      exposure: "model-only",
      executionMode: "sequential",
      description:
        "Read or wait for a response; the task stays available for follow-up. finish:true accepts/removes it, not merely acknowledges it. A timeout only ends the wait.",
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
      ...taskToolRenderers("sub_control"),
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
