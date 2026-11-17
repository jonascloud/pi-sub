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
import { Coordinator, type TaskView } from "./src/coordinator.ts";
import {
  availableExecutions,
  availableModels,
  checkRetained,
  ladderPath,
  loadLadder,
  selectExecution,
} from "./src/models.ts";
import { Workspace } from "./src/workspace.ts";
import { taskToolRenderers } from "./src/tool-view.ts";
import { mountWidget } from "./src/widget.ts";
import {
  SUBAGENT_GUIDANCE,
  renderReply,
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
  pi.registerMessageRenderer("pi-sub:stopped", renderStopped);
  const workspace = new Workspace();
  let context: ExtensionContext | undefined;
  let unmount: (() => void) | undefined;
  // Aborting the parent stops the parent, not its children. Their replies
  // then wait for the user instead of waking what was just stopped.
  let held = false;
  let dialogOpen = false;
  const lifetime = new AbortController();
  let idleDelivery: ReturnType<typeof setImmediate> | undefined;
  // Steering messages reach the parent only after its current tool calls, so
  // observing a child must not hold them back.
  let steers = 0;
  const waits = new Set<AbortController>();
  let steerWatch: ReturnType<typeof setInterval> | undefined;
  // Pi queues a steering message once every input handler has returned and
  // announces that to no extension: look while one is expected and a wait is open.
  const yieldToSteering = () => {
    if (steers && context?.hasPendingMessages())
      for (const wait of waits) wait.abort();
    const expected = steers > 0 && waits.size > 0;
    if (expected && !steerWatch) steerWatch = setInterval(yieldToSteering, 100);
    if (!expected && steerWatch) {
      clearInterval(steerWatch);
      steerWatch = undefined;
    }
  };

  const replyBatchFor = (ctx: ExtensionContext, messages?: AgentMessage[]) =>
    lifetime.signal.aborted
      ? undefined
      : pendingReplyBatch(
          coordinator.list(),
          ctx.sessionManager,
          messages,
          workspace,
        );
  const scheduleReplies = () => {
    if (idleDelivery || held || lifetime.signal.aborted) return;
    // Coalesce this event-loop turn; never debounce, poll or queue a follow-up
    // behind an active parent that may read or supersede these replies itself.
    idleDelivery = setImmediate(() => {
      idleDelivery = undefined;
      const ctx = context;
      if (!ctx?.isIdle() || dialogOpen || held || lifetime.signal.aborted)
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
  const coordinator = new Coordinator({
    beforeStart(task) {
      if (!context) throw new Error("No active parent context");
      checkContext(context);
      authorizeTask(task, context);
    },
    onReady: scheduleReplies,
  });
  const checkContext = (ctx: ExtensionContext) => {
    if (lifetime.signal.aborted)
      throw new Error("This Pi session is shutting down.");
    if (!ctx.isProjectTrusted())
      throw new Error("Trust this project before starting native subagents.");
    context = ctx;
  };
  const authorizeTask = (task: TaskView, ctx: ExtensionContext) =>
    checkRetained(
      loadLadder(ladderPath()),
      task.level,
      task.execution,
      availableModels(ctx),
    );
  const authorized = (id: string, ctx: ExtensionContext) =>
    authorizeTask(coordinator.get(id), ctx);
  const observeTask = async (
    id: string,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    ctx: ExtensionContext,
  ) => {
    if (steers && ctx.hasPendingMessages()) return coordinator.inspect(id);
    const yielded = new AbortController();
    waits.add(yielded);
    yieldToSteering();
    try {
      return await coordinator.wait(
        id,
        signal ? AbortSignal.any([signal, yielded.signal]) : yielded.signal,
        timeoutMs,
      );
    } catch (error) {
      if (yielded.signal.aborted && !signal?.aborted)
        return coordinator.inspect(id);
      throw error;
    } finally {
      waits.delete(yielded);
    }
  };
  const response = (value: Reports, error = false) => {
    const result = reportResult(value, workspace);
    const usage = coordinator.drainUsage();
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
      unmount = mountWidget(ctx.ui, coordinator);
    }
  });
  pi.on("ui_prompt_start", () => {
    dialogOpen = true;
  });
  pi.on("ui_prompt_end", () => {
    dialogOpen = false;
    scheduleReplies();
  });
  pi.on("input", (event, ctx) => {
    if (event.source !== "interactive" && event.source !== "rpc") return;
    context = ctx;
    held = false;
    if (event.streamingBehavior !== "steer") return;
    steers++;
    setImmediate(yieldToSteering);
  });
  pi.on("message_start", (event) => {
    if (event.message.role === "user" && steers) steers--;
  });
  // Only complete model-visible context acknowledges a reply. Announcements
  // and boundary proposals alone must not collapse its outstanding widget row.
  pi.on("context", (event) => {
    if (lifetime.signal.aborted) return;
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
  });
  pi.on("agent_settled", (event, ctx) => {
    context = ctx;
    steers = 0;
    if (event.aborted) held = true;
    else scheduleReplies(); // Includes replies arriving after the final boundary.
  });
  pi.on("before_agent_start", (event, ctx) => {
    context = ctx;
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
    // Providers cache the prompt as a prefix and some resend the whole
    // conversation when it changes: task state never belongs here.
    event.systemPromptOptions.sections.pi_sub = `${SUBAGENT_GUIDANCE}\n\n${availability}`;
  });
  pi.on("session_shutdown", async () => {
    lifetime.abort();
    if (idleDelivery) clearImmediate(idleDelivery);
    clearInterval(steerWatch);
    unmount?.();
    await coordinator.dispose();
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
            if (id) await coordinator.pause(id);
            else {
              // The one command that stops everything: children, then the parent.
              held = true;
              const pausing = Promise.all(
                coordinator.list().map((task) => coordinator.pause(task.id)),
              );
              ctx.abort();
              await pausing;
            }
          }
          if (action === "continue") {
            held = false;
            const tasks = id
              ? [coordinator.get(id)]
              : coordinator.list().filter((task) => task.status === "paused");
            for (const task of tasks) authorized(task.id, ctx);
            for (const task of tasks) await coordinator.continue(task.id);
            if (!tasks.length) notify("No paused tasks.");
            scheduleReplies();
          }
          if (action === "stop") {
            const results = await Promise.all(
              (id ? [id] : coordinator.list().map((task) => task.id)).map(
                (taskId) => coordinator.stop(taskId),
              ),
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
          level: Type.Integer({ minimum: 1, maximum: 10 }),
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
          const id = coordinator.start({
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
          return response(coordinator.get(id));
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
          await coordinator.message(args.id, args.message);
          return response(coordinator.get(args.id));
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
        "Read or wait for a response; the task stays available for follow-up. finish:true accepts/removes it, not merely acknowledges it. A timeout, pause or user message only ends the wait.",
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
            ? await observeTask(
                args.id,
                signal,
                (args.timeout ?? 30) * 1000,
                ctx,
              )
            : coordinator.inspect(args.id);
          // A wait that ended early has nothing to accept yet.
          const open = "status" in task && task.status !== "ready";
          return response(
            args.finish && !(args.wait && open)
              ? await coordinator.collect(task.id)
              : task,
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
            return response(await coordinator.stop(args.id));
          const tasks = args.id
            ? [coordinator.get(args.id)]
            : coordinator
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
                ? coordinator.stop(task.id)
                : (await (args.action === "pause"
                    ? coordinator.pause(task.id)
                    : coordinator.continue(task.id)),
                  coordinator.get(task.id)),
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
