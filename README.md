# pi-sub

A small coordinator for native [Pi](https://pi.dev) subprocesses. Pi owns conversation history, tools, compaction and retries; pi-sub owns ladder-based routing, task/process lifetime and compact presentation.

A **task** owns a native Pi session. Each **execution** is a fresh `pi --mode json --print` process on that session. A reply may be a question: follow-up continues the session, while explicit acceptance removes the task. Complete delivery folds its widget row without accepting it. Ready and paused tasks hold no process.

## Install

Requires Pi 1.5-compatible host packages and Node.js 22.19 or newer:

```sh
pi install git:github.com/jonascloud/pi-sub
```

Use `/reload` after installation or source changes.

## Model ladder

The only runtime configuration is **`<agent-dir>/pi-sub-config.json`**, normally `~/.pi/agent/pi-sub-config.json`. Pi's `PI_CODING_AGENT_DIR` selects another profile. There are no project overrides, fallback files or automatic imports.

```json
{
  "3": "provider/fast-model:off",
  "6": "provider/reasoning-model:medium",
  "8": "provider/reasoning-model:high"
}
```

This is a format example, not bundled defaults. Keys are configured strengths from 1 to 10; values are exact `provider/model:thinking` references. `{}` disables delegation.

Strength is a rough local capability scale: 1–2 for narrow mechanical work, 3–4 for bounded routine implementation, 5–6 for multi-file changes and moderate analysis, 7–8 for complex design and debugging, and 9–10 for the hardest, highly uncertain work. These are workload anchors, not benchmark scores, equal numerical steps or guarantees. The agent setup guide and parent delegation use the same anchors. Compare candidates against the saved ladder rather than rescaling to whichever models are available. Unused levels can remain empty.

Dispatch walks upward from the requested minimum and chooses the first natively available rung. It never infers unlisted variants. The configured ladder authorizes delegation independently of the parent session's `enabledModels`, cycling scope and thinking pins. Availability, credentials, supported thinking, project trust and sufficient ladder membership are checked before execution, including continuations. If none qualifies, delegation fails explicitly.

### Create the ladder with an agent

Ask your normal coding agent to follow [the ladder setup guide](instructions/create-model-ladder.md). It discovers your available models, compares useful candidates, proposes a compact ladder, and writes the configuration after you approve it. No working delegation setup is needed.

From this checkout, start an interactive conversation with:

```sh
pi @instructions/create-model-ladder.md "Help me create or revise my pi-sub model ladder."
```

The guide is also usable in an existing conversation: ask the agent to read it. It uses ordinary agent tools; approval and safe editing are instructions, not a separate enforced workflow.

pi-sub reads configuration but never creates, repairs or writes it. File changes apply to subsequent execution admission without a reload; already running executions are not changed. Missing or invalid configuration fails explicitly and points to the guide. Keep the file private (`0600`) and ignored in the profile repository. Subagent working data uses a private system-temporary workspace, not the project directory.

## Parent tools

| Tool          | Contract                                                                                                                                                                            |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sub_task`    | Start bounded work with required `level` (integer 1–10) and `prompt`, plus optional `description`. Returns an ID immediately.                                                       |
| `sub_message` | Send `{ id, message }`. Updates queued input or stops active execution, waits for closure, then continues the same session with the correction. Also answers ready or paused tasks. |
| `sub_result`  | Inspect `{ id }`. Optional `wait` and timeout in seconds only observe. `finish: true` explicitly accepts/removes a ready task.                                                      |
| `sub_control` | `pause`, `continue` or `stop`, with optional `id`; omit it to control all applicable tasks. Stopping never rolls back side effects.                                                 |

```text
sub_task({ level: 3, prompt: "Inspect the authentication entry points without modifying files.", description: "Review auth" })
sub_result({ id: "<task-id>", wait: true, timeout: 30 })
sub_message({ id: "<task-id>", message: "Use the production schema, then continue." })
sub_result({ id: "<task-id>", finish: true })
```

A wait timeout does not stop work. Reading a question does not accept it. Complete delivery clears outstanding attention but preserves follow-up; `finish: true` is not needed to acknowledge a report. Accepted/stopped tasks cannot resume. Their complete result receipts remain retrievable for the active parent session, without workers, listeners, timers or slots. Receipt memory grows with removed tasks and their report sizes until session disposal.

### Replies and delivery

Live tasks are the inbox; native history records announcements. At the next safe native turn boundary, after tools finish and before the next model request, pi-sub batches current unannounced replies into one bounded message. Complete tool returns and prior announcements suppress duplicates. Accepted, stopped and superseded replies are excluded. An oversized batch is handed off through one file, not split into repeated wakeups. Natural continuation carries the batch without an extra acknowledgement turn. Idle arrivals are coalesced once per event-loop turn and may wake the parent once. There are no per-worker follow-ups queued behind its work.

Delivery is distinct from announcement, reading and acceptance. A complete notification or tool return in parent context acknowledges that exact reply, whether it contains the report text or the exact published file reference. The parent decides how much of a file to read; no read tracking or extra acknowledgement is required. A delayed delivery cannot acknowledge its successor. TUI expansion shows delivered inline text or the temporary file reference, plus compact diagnostics; it does not load or archive file contents. Rendering never changes delivery or task lifetime.

Aim for the smallest sufficient handoff for the next decision or action, not the shortest message. Briefings carry the goal, scope, constraints, success criteria and decisive context. Child replies carry results or blocking questions, relevant paths, verification, decisive reasons and material uncertainty. Prefer references over copied content without hiding evidence needed to judge correctness. Follow-ups add new information with enough context to interpret it. Omit redundant instructions, acknowledgements and routine progress narration. This is guidance, not an enforced word limit.

Routine reports are for the parent's internal use; only material results, blockers and user decisions should be surfaced. Operating guidance lives once in each agent's system prompt and in tool contracts, not underneath each report. The parent sees a snapshot of the available ladder-level range, not a self-rating or model routing table. Because dispatch routes upward, the highest available rung supports every minimum level from 1 through that rung. Never lower a task's required strength just to fit availability; admission still rechecks configuration and native availability. Stale reports alone do not warrant revisiting accepted/stopped tasks; their receipts remain available for deliberate review. Final failures appear in the widget and are collected before the next real user prompt without a model cleanup turn.

Small tool results contain task identity, state, reply identity, response, errors and pending input directly. Oversized handoffs—tool results, notifications, failure reports and operator stop results—are written in full to private UTF-8 files in the active parent session's system-temporary workspace. Report text keeps its actual line breaks instead of becoming a giant JSON string. A single-report reference retains task identity and state; a batch reference contains its task count. Both include an error count and one file path. The whole reference must fit the output budget (50 KiB/2,000 lines, or 24,000 bytes/300 lines for reply notifications). Serialized reports are never clipped.

Reports are written synchronously to unique files before a reference is returned. The active session caches successful writes by content, so repeated reads need no new writes. There is no shared file cache or integrity monitoring. Reports remain readable after task acceptance or stop, but expire on session switch, fork/clone, reload or orderly shutdown. Preserve relevant findings in the parent conversation or project before leaving the session. External edits or deletion can also invalidate references.

If report storage fails, the response preserves the confirmed task state instead of implying rollback. Removed tasks are marked `archived: true` (or counted for batches). Compact diagnostics remain in native details; the full report remains in the active coordinator's task or receipt. Retry `sub_result` after fixing storage, before leaving this session. This state-only fallback never acknowledges a reply. Automatic failure cleanup uses the same fallback without blocking the next user prompt. Ready-reply notifications still require a complete handoff.

Native `details` retain compact task-state/execution metadata, bounded previews, counters and delivery hashes—not complete response bodies or pending instructions. Tool/stop/failure results use `{ report }` with metadata for each task, adding `handoff: { file, digest }` for files or `reportError` on storage failure. Reply notifications keep metadata in `details.replies` and add the same handoff shape. Inline text remains ordinary parent conversation content; removing redundant copies from details does not erase that history.

## Interrupt and continue

An **interrupt** aborts the parent, pauses children and closes admission, including for newly requested tasks. A new **user prompt** resumes only the parent; it decides which children to continue.

Escape also interrupts while the TUI parent is idle, except when an extension dialog owns Escape. Operator commands need no model call:

```text
/sub:pause [task-id]
/sub:continue [task-id]
/sub:stop [task-id]
```

No ID means all applicable tasks. `/sub:pause` without an ID is the global interrupt and also aborts the parent. In RPC, use `prompt("/sub:pause")` for an idle global interrupt: bare idle RPC `abort` emits no public extension event. Active-run, retry-backoff and compaction aborts are observed through native hooks.

The coordinator requests SIGTERM, escalates to SIGKILL if necessary, and waits for process closure, drained output and final capture. Failed termination retains ownership and its slot so cleanup can be retried. Corrections remain owned until sent; interruption during redirection cancels restart and retains them. Pausing does not freeze a provider request or undo writes and external effects.

Before forwarding real user input or explicit operator continuation, failure cleanup closes failed workers, hands off their reports and undelivered input as text or a temporary file reference, then removes the failed tasks while retaining receipts for this session. Report-storage errors are reported but do not block input; failure to confirm process closure still does. An intervening interrupt cancels forwarding and retains reports. The parent chooses how to proceed, not how to release failed processes.

Four executions run concurrently by default. Only executions occupy slots, including termination and final capture; queued tasks wait without processes. Ready replies, paused tasks and closed failures use no slot. Control tools are model-only and sequential; child execution remains concurrent.

Shutdown, reload and session replacement close owned executions and capture final usage before deleting the temporary workspace, including child journals and reports. Receipts and report reuse are session-scoped; reopening saved parent history starts fresh, and historical file references may have expired without changing the recorded task outcome. Parent history and project changes are never deleted. Hard crashes can leave temporary files; there is no background collector or deletion deadline. Existing project-local artifacts from older versions are not migrated or automatically removed.

## Views and usage

Tool and transcript rows show task names and confirmed outcomes, with compact response previews and visible failure causes. Timeouts are observations, not cancellation or success. Expand through Pi's configured tool-expansion control for requests, delivered text or temporary references, IDs, session paths, minimum level, actual execution and usage. Tool renderers also support native HTML export; RPC/print retain structured data.

The above-editor widget shows outstanding attention: active, paused, failed and undelivered ready tasks, newest first. Completely delivered replies fold into a `delivered` count, not a completion count. Follow-up creates a new outstanding reply. Accepted/stopped tasks disappear; final errors disappear after user-prompt cleanup. Completion and token totals survive removal. Task names and current detail take priority on narrow terminals; tokens appear only in the summary as `↑input ↓output`, formatted like Pi's footer. These are native input/output counts; cache-read/write tokens are not folded into either arrow.

There are no spinners or worker heartbeats. Native events update progress immediately; visible active elapsed time refreshes once per second. The widget does not poll while idle or fully hidden.

After process closure, each execution reads the saved native journal, including late shutdown usage. A valid whole-session snapshot replaces the previous snapshot so continuation does not charge earlier executions again. An unreadable, corrupt or identity-mismatched final journal cannot replace confirmed accounting. Unpersisted provider usage cannot be reconstructed.

Acceptance, explicit stop or automatic failure collection transfers original assistant, tool, compaction, branch-summary and native usage. Delivery changes visibility only, not billing. Captured usage is aggregated until the next subagent tool result reports it once. Commands and notifications alone cannot add it to native parent tool-result totals; uncollected work at shutdown is not charged through this extension. Costs are never repriced through the parent model. Streamed widget tokens reconcile with the confirmed saved snapshot after execution.

## Native boundaries

- Task states are `queued`, `active`, `paused` and `ready`; reply/error/stopped are outcomes. Pausing and closing are temporary operations. Process closure is not proof of success or semantic completion: native provider errors can accompany exit code zero, and an old restored answer is not a new reply.
- At most one execution owns a task's journal. Continuation validates readability, structure and the observed native session identity; it does not prove unchanged history. Valid edits or truncation retaining that identity are outside this continuity check. Pi owns restoration; pi-sub does not reconstruct transcripts.
- Only a new saved user entry confirms exact input persistence. Streamed events precede journal writes. Input transformations may make persistence unverifiable; failed/interrupted work then conservatively replays the instruction. Neither interruption nor replay guarantees exactly-once external effects.
- Children load normal Pi resources in the same profile and trusted working directory, including the global `<agent-dir>/AGENTS.md` and project context files on every execution. Pi's native same-directory `AGENTS.override.md` precedence applies. This relies on native loading, not enforcement against extensions that replace context or provider prompts. pi-sub neither copies these instructions into task messages nor transfers the parent's conversation. `--approve` conveys project trust, **not** approval of individual tools. Parent-only runtime registrations and process-local tool filters are not replayed; configure providers and tools as normal resources. Child stdout must remain valid native JSON; diagnostics belong on stderr. The extension's delegation tools are excluded to prevent recursion.
- Child widgets, titles and editor changes are not forwarded. Native headless UI returns `false` for `confirm` and `undefined` for `select`, `input` and `editor`. Extensions must honor denial/cancellation and `ctx.hasUI`; the parent model cannot grant human authorization. Not every headless UI attempt is observable. Dialog-only input without a new assistant response fails explicitly. Separate processes and trusted extensions are not a filesystem sandbox.

## Development

Clone the repository and install its dependencies. To load the local checkout in Pi, run `pi install /absolute/path/to/pi-sub`.

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run format:check
```

Tests include real parent/child Pi processes with a synthetic local provider and no paid model calls. They cover read-only configuration, routing, interruption, continuation, reply delivery, collection and native usage. They do not establish instruction compliance or end-to-end token savings with real models.

See the [architectural decisions](docs/decisions/). Code is [MIT licensed](LICENSE).
