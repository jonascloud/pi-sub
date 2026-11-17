import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  defineTool,
  type AgentBeforeSettleEvent,
  type ExtensionAPI,
  type ExtensionContext,
  type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Coordinator, isSettled, type TaskView } from "./src/coordinator.ts";
import {
  availableExecutions,
  availableModels,
  ladderPath,
  loadLadder,
  selectExecution,
  STRENGTH_GUIDANCE,
} from "./src/models.ts";
import {
  errorResult,
  readReport,
  replyBatch,
  sanitize,
  stoppedNotice,
  toolResult,
} from "./src/reports.ts";
import { REPORT_READ_BYTES } from "./src/report-store.ts";
import { renderReplies, taskToolRenderers } from "./src/views.ts";
import { mountWidget } from "./src/widget.ts";

/** One stable instruction section; replies carry observations, not a manual. */
const guidance = `Delegate bounded work when it justifies briefing and integration. Give the goal, scope, constraints, success criteria and decisive context. Prefer paths to copied content. Children share files and native instructions, not your conversation or UI.
Choose the minimum sufficient level, not the nearest available one. The ladder selects the execution.
${STRENGTH_GUIDANCE}
Replies may be questions. Read only needed report pages; preserve material findings before eviction or session change. A message continues a failed task with unsent input unless its session is lost. Do not repeat a retry that failed the same way.
Interrupting you leaves children running. Do not resume children the user paused without their direction. Use reports internally; surface only material results, blockers or user decisions. No acknowledgement is needed.`;

const reason = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export default function piSub(pi: ExtensionAPI): void {
  // Children load normal Pi resources, but must not delegate further.
  if (process.env.PI_SUB_CHILD === "1") return;
  pi.registerMessageRenderer("pi-sub:response", renderReplies);
  let context: ExtensionContext | undefined;
  let unmount: (() => void) | undefined;
  let closed = false;
  /** Child sessions are working data of this parent runtime, not an archive. */
  let sessions: string | undefined;
  // Aborting the parent stops the parent, not its children. Their replies
  // then wait for the user instead of waking what was just stopped.
  let held = false;
  let dialogOpen = false;
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

  const notify = (text: string, type: "info" | "error" = "info") => {
    if (closed) return;
    if (context?.hasUI) context.ui.notify(sanitize(text), type);
    else if (type === "error") console.error(sanitize(text));
  };
  /**
   * Every reply and failure not yet handed to the parent, as one message.
   * Handing it to Pi is delivery: nothing is announced twice.
   */
  const deliver = (hand: (batch: ReturnType<typeof replyBatch>) => void) => {
    const tasks = coordinator
      .list()
      .filter((task) => isSettled(task.status) && !task.delivered);
    if (!tasks.length) return;
    hand(replyBatch(tasks, coordinator.reports));
    for (const task of tasks) coordinator.markDelivered(task.id);
  };
  /** An idle parent is woken once per event-loop turn, however many replies arrived in it. */
  const scheduleReplies = () => {
    if (idleDelivery || held || closed) return;
    idleDelivery = setImmediate(() => {
      idleDelivery = undefined;
      if (!context?.isIdle() || dialogOpen || held || closed) return;
      try {
        deliver((batch) => pi.sendMessage(batch, { triggerTurn: true }));
      } catch (error) {
        notify(`Could not deliver subagent replies: ${reason(error)}`, "error");
      }
    });
  };
  const coordinator = new Coordinator({ onSettled: scheduleReplies });

  /** Tool results carry confirmed child usage into the parent session's totals. */
  const charged = <T extends object>(result: T) => {
    const usage = coordinator.drainUsage();
    return usage ? { ...result, usage } : result;
  };
  const respond = (value: TaskView | TaskView[]) => {
    const result = toolResult(value, coordinator.reports);
    for (const task of [value].flat()) coordinator.markDelivered(task.id);
    return charged(result);
  };
  const failed = (error: unknown) =>
    charged(errorResult(reason(error), coordinator.reports));
  /** Waits for the task, the timeout or the user, whichever comes first. */
  const observe = async (
    id: string,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ) => {
    if (steers && context?.hasPendingMessages()) return coordinator.get(id);
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
        return coordinator.get(id);
      throw error;
    } finally {
      waits.delete(yielded);
    }
  };

  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    if (ctx.mode === "tui") {
      unmount?.();
      unmount = mountWidget(ctx.ui, coordinator);
    }
  });
  pi.on("session_shutdown", async () => {
    closed = true;
    if (idleDelivery) clearImmediate(idleDelivery);
    clearInterval(steerWatch);
    unmount?.();
    await coordinator.dispose();
    if (sessions) rmSync(sessions, { recursive: true, force: true });
  });
  pi.on("before_agent_start", (event, ctx) => {
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
    event.systemPromptOptions.sections.pi_sub = `${guidance}\n\n${availability}`;
  });
  pi.on("input", (event) => {
    if (event.source !== "interactive" && event.source !== "rpc") return;
    held = false;
    if (event.streamingBehavior !== "steer") return;
    steers++;
    setImmediate(yieldToSteering);
  });
  pi.on("message_start", (event) => {
    if (event.message.role === "user" && steers) steers--;
  });
  pi.on("agent_settled", (event) => {
    steers = 0;
    if (event.aborted) held = true;
    else scheduleReplies(); // Replies that arrived after the last boundary.
  });
  pi.on("ui_prompt_start", () => {
    dialogOpen = true;
  });
  pi.on("ui_prompt_end", () => {
    dialogOpen = false;
    scheduleReplies();
  });
  /** A running parent receives replies with the request it makes anyway. */
  const deliverAtBoundary = (
    event: TurnEndEvent | AgentBeforeSettleEvent,
    ctx: ExtensionContext,
  ) => {
    if (event.outcome !== "completed" || ctx.signal?.aborted || dialogOpen)
      return;
    let entries: TurnEndEvent["entries"] | undefined;
    deliver((batch) => {
      entries = [
        ...event.entries,
        { type: "custom_message" as const, ...batch },
      ];
    });
    // Natural tool/queue continuation satisfies this request; Pi does not add
    // another turn on top of it.
    return entries ? { entries, continue: true } : undefined;
  };
  pi.on("turn_end", deliverAtBoundary);
  pi.on("agent_before_settle", deliverAtBoundary);

  const all = (status?: TaskView["status"]) =>
    coordinator
      .list()
      .filter((task) => !status || task.status === status)
      .map((task) => task.id);
  pi.registerCommand("sub:pause", {
    description: "Pause one subagent by ID, or all of them and the parent.",
    handler: async (args, ctx) => {
      const id = args.trim();
      try {
        if (id) return await coordinator.pause(id);
        // The one command that stops everything: children, then the parent.
        held = true;
        const pausing = Promise.all(all().map((id) => coordinator.pause(id)));
        ctx.abort();
        await pausing;
      } catch (error) {
        notify(reason(error), "error");
      }
    },
  });
  pi.registerCommand("sub:continue", {
    description: "Continue one paused subagent by ID, or all of them.",
    handler: async (args) => {
      const id = args.trim();
      held = false;
      try {
        const ids = id ? [id] : all("paused");
        for (const paused of ids) coordinator.continue(paused);
        if (!ids.length) notify("No paused tasks.");
      } catch (error) {
        notify(reason(error), "error");
      }
      scheduleReplies();
    },
  });
  pi.registerCommand("sub:stop", {
    description: "Stop one subagent by ID, or all of them.",
    handler: async (args) => {
      const id = args.trim();
      try {
        const stopped = await Promise.all(
          (id ? [id] : all()).map((task) => coordinator.stop(task)),
        );
        if (!stopped.length) return notify("No tasks to stop.");
        // The parent learns it without a turn of its own.
        pi.sendMessage(stoppedNotice(stopped, coordinator.reports), {
          triggerTurn: false,
        });
      } catch (error) {
        notify(reason(error), "error");
      }
    },
  });

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
          signal?.throwIfAborted();
          if (!ctx.isProjectTrusted())
            throw new Error("Trust this project before starting subagents.");
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
              sessionDir: (sessions ??= mkdtempSync(join(tmpdir(), "pi-sub-"))),
              args: ["--approve"],
            },
          });
          return respond(coordinator.get(id));
        } catch (error) {
          return failed(error);
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
        "Send an answer or correction. Interrupts active work; continues paused and failed tasks.",
      parameters: Type.Object(
        { id: Type.String(), message: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
      async execute(_call, args, signal) {
        try {
          signal?.throwIfAborted();
          await coordinator.message(args.id, args.message);
          return respond(coordinator.get(args.id));
        } catch (error) {
          return failed(error);
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
        "Inspect a task by id; wait only observes, finish accepts/removes. Or read a cached report by report ID, without running a model: offset is a UTF-8 byte offset, limit defaults to 4096 bytes. Reports may expire. Results are at most 8 KiB.",
      parameters: Type.Object(
        {
          id: Type.Optional(Type.String()),
          report: Type.Optional(Type.String()),
          offset: Type.Optional(Type.Integer({ minimum: 0 })),
          limit: Type.Optional(
            Type.Integer({ minimum: 4, maximum: REPORT_READ_BYTES }),
          ),
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
      async execute(_call, args, signal) {
        try {
          signal?.throwIfAborted();
          if (args.report !== undefined) {
            if (
              args.id !== undefined ||
              args.wait !== undefined ||
              args.finish !== undefined ||
              args.timeout !== undefined
            )
              throw new Error(
                "Report reads take report, offset and limit only.",
              );
            return charged(
              readReport(
                coordinator.reports,
                args.report,
                args.offset,
                args.limit,
              ),
            );
          }
          if (
            args.id === undefined ||
            args.offset !== undefined ||
            args.limit !== undefined
          )
            throw new Error(
              "Provide a task id, or a report ID with optional offset and limit.",
            );
          const task = args.wait
            ? await observe(args.id, signal, (args.timeout ?? 30) * 1000)
            : coordinator.get(args.id);
          // A wait that ended early has nothing to accept yet.
          return respond(
            args.finish && (isSettled(task.status) || !args.wait)
              ? coordinator.accept(args.id)
              : task,
          );
        } catch (error) {
          return failed(error);
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
      async execute(_call, args, signal) {
        try {
          signal?.throwIfAborted();
          const act = async (id: string) => {
            if (args.action === "stop") return coordinator.stop(id);
            if (args.action === "pause") await coordinator.pause(id);
            else coordinator.continue(id);
            return coordinator.get(id);
          };
          return respond(
            args.id
              ? await act(args.id)
              : await Promise.all(
                  all(args.action === "continue" ? "paused" : undefined).map(
                    act,
                  ),
                ),
          );
        } catch (error) {
          return failed(error);
        }
      },
    }),
  );
}
