# pi-sub

A small coordinator for native [Pi](https://pi.dev) subprocesses. Pi owns conversation history, tools, compaction and retries; pi-sub owns model selection, task/process lifetime and compact presentation.

A **task** owns a native Pi session. Each **execution** is a fresh `pi --mode json --print` process on that session. A reply may be a question: follow-up continues the session, while explicit acceptance removes the task. Complete delivery folds its widget row without accepting it. Ready and paused tasks hold no process.

## Install

Requires Pi 1.5-compatible host packages and Node.js 22.19 or newer:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pi install /absolute/path/to/pi-sub
```

Remove any old `pi-subagents` installation first (`pi list`, then `pi remove <source>`). Use `/reload` after installation or source changes. This repository does not rewrite Pi settings or remove old checkouts.

## Model ladder

The only runtime configuration is **`<agent-dir>/pi-sub-config.json`**, normally `~/.pi/agent/pi-sub-config.json`. Pi's `PI_CODING_AGENT_DIR` selects another profile. There are no project overrides, fallback files or automatic imports.

```json
{
  "6": { "model": "openai-codex/gpt-6.1-terra:low", "cost": 0.07134 },
  "7": { "model": "openai-codex/gpt-6.1-terra:medium", "cost": 0.1688 },
  "8": { "model": "openai-codex/gpt-6.1-terra:high", "cost": 0.25928 },
  "9": { "model": "openai-codex/gpt-6.1-sol:high", "cost": 0.59099 }
}
```

This is a format example, not bundled defaults. Keys are operator-confirmed strengths from 1 to 10. Each row contains an exact `provider/model:thinking` reference and a nonnegative reference cost, or `null` when unknown. `{}` disables delegation. The illustrated costs are rounded AA Intelligence Index v5.0.1 USD/task references, **not live task prices or Codex quota consumption**.

Dispatch walks upward from the requested minimum and chooses the first natively available rung. It never sorts by cost or infers unlisted variants. The confirmed ladder authorizes delegation independently of the parent session's `enabledModels`, cycling scope and thinking pins. Availability, credentials, supported thinking, project trust and sufficient ladder membership are checked before execution, including continuations. If none qualifies, delegation fails explicitly.

### Review, refine, accept

1. Run `/sub:models` in a TUI or persistent RPC session. Choose candidates in the native dialog, then **Review selected models**. This writes nothing; cancelling starts no research.
2. Research uses the exact parent model/thinking captured when the command opened. Review the unsaved proposal and comparison in the transcript; the TUI also shows a non-modal panel above the editor.
3. Type normal prompts to refine the same research session. Type **`accept`** to publish the finished draft that was shown, or **`cancel`** to discard it. `/sub:models cancel` also closes selection. `/sub:pause` interrupts research; a refinement or explicit continuation can resume it.

**The saved ladder remains active until acceptance.** Saved models are preselected; without a file, the current parent model is suggested. An existing empty file selects nothing. Unavailable saved references are labelled, not silently dropped. Only selected variants may receive new or changed assignments; deselected available models cannot remain in the draft. Unavailable saved entries may remain exactly unchanged. Removals require confirmation, and native availability is rechecked before publication. Changing candidates requires a new selection.

During selection, ordinary text prompts are refinements, not parent-model turns. Background replies remain visible without waking the parent; unrelated native commands remain available. Repeating `/sub:models` redisplays the current proposal. Early or stale acceptance is refused. Only identifiable interactive/RPC user input can confirm: slash commands, extension-generated input and model output cannot. Print mode requires direct file editing. Reload/shutdown discards unconfirmed drafts, not saved configuration.

Research needs normally configured web/search tools. The [review instructions](instructions/model-capabilities.md) retain calibration anchors and require sources, uncertainty and a distinction between observations and judgment. Evidence stays in the comparison/native session, not a runtime benchmark catalog. No paid benchmarks run implicitly; research itself can incur ordinary model usage. Built-in shell, write, edit and codemode tools are disabled for research. Trusted custom tools remain available; this is not a filesystem sandbox.

Acceptance replaces the whole ladder under a cross-process lock. An exact-byte baseline check rejects concurrent changes instead of merging them. Final authorization, interruption and revision checks immediately precede synchronous atomic publication. Cancellation cannot undo a committed file. Post-commit cleanup failures are reported as warnings, not failed saves.

Configuration is private (`0600`); a final rule for its exact filename is appended to `<agent-dir>/.gitignore` when needed, preserving existing rules and the rest of the profile. Project task sessions are separately protected by `<cwd>/.pi/pi-sub/.gitignore`. Keep benchmark-derived material private unless redistribution rights have been reviewed.

For migration, back up and explicitly move an already confirmed compact ladder to `pi-sub-config.json`, then reload running sessions. Historical assessment catalogs need deliberate conversion, not renaming. Old paths are never read automatically. Native Pi settings, credentials, provider catalogs and session histories are not pi-sub configuration.

## Parent tools

| Tool | Contract |
| --- | --- |
| `sub_task` | Start bounded work with required `level` (integer 1–10) and `prompt`, plus optional `description`. Returns an ID immediately. |
| `sub_message` | Send `{ id, message }`. Updates queued input or stops active execution, waits for closure, then continues the same session with the correction. Also answers ready or paused tasks. |
| `sub_result` | Inspect `{ id }`. Optional `wait` and timeout in seconds only observe. `finish: true` explicitly accepts/removes a ready task. |
| `sub_control` | `pause`, `continue` or `stop`, with optional `id`; omit it to control all applicable tasks. Stopping never rolls back side effects. |

```text
sub_task({ level: 3, prompt: "Inspect the authentication entry points without modifying files.", description: "Review auth" })
sub_result({ id: "<task-id>", wait: true, timeout: 30 })
sub_message({ id: "<task-id>", message: "Use the production schema, then continue." })
sub_result({ id: "<task-id>", finish: true })
```

A wait timeout does not stop work. Reading a question does not accept it. Complete delivery clears outstanding attention but preserves follow-up; `finish: true` is not needed to acknowledge a report. Accepted/stopped tasks cannot resume. Their complete result receipts remain retrievable for the coordinator's lifetime, without workers, listeners, timers or slots; receipt memory therefore grows with removed tasks and their report sizes.

### Replies and delivery

Live tasks are the inbox; native history records announcements. At the next safe native turn boundary, after tools finish and before the next model request, pi-sub batches current unannounced replies into one bounded message. Complete tool returns and prior announcements suppress duplicates. Accepted, stopped and superseded replies are excluded; overflow stays eligible at the next boundary. Natural continuation carries the batch without an extra acknowledgement turn. Idle arrivals are coalesced once per event-loop turn and may wake the parent once. There are no per-worker follow-ups queued behind its work.

Delivery is distinct from announcement and acceptance. Only a complete notification or tool return in parent context acknowledges that exact reply; a delayed delivery cannot acknowledge its successor. Truncated notifications point to `sub_result`, remain outstanding and are not announced repeatedly. TUI expansion can show full preserved reports even when model-facing content was truncated. Rendering never changes delivery or task lifetime.

Routine reports are for the parent's internal use; only material results, blockers and user decisions should be surfaced. Operating guidance lives once in the system prompt and tool contracts, not underneath each report. Final failures appear in the widget and are collected before the next real user prompt without a model cleanup turn.

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

Before forwarding real user input or explicit operator continuation, failure cleanup closes failed workers, transfers their reports and undelivered input into native parent history, then removes the failed tasks. An intervening interrupt cancels forwarding and retains reports until delivery. The parent chooses how to proceed, not how to release failed processes.

Four executions run concurrently by default. Only executions occupy slots, including termination and final capture; queued tasks wait without processes. Ready replies, paused tasks and closed failures use no slot. Control tools are model-only and sequential; child execution remains concurrent.

Shutdown, reload and session replacement terminate owned executions. Pending work is not restored on restart. Native sessions remain under `.pi/pi-sub/sessions` for inspection.

## Views and usage

Tool and transcript rows show task names and confirmed outcomes, with compact response previews and visible failure causes. Timeouts are observations, not cancellation or success. Expand through Pi's configured tool-expansion control for full requests, reports, IDs, session paths, minimum level, actual execution and usage. Tool renderers also support native HTML export; RPC/print retain structured data.

The above-editor widget shows outstanding attention: active, paused, failed and undelivered ready tasks, newest first. Completely delivered replies fold into a `delivered` count, not a completion count. Follow-up creates a new outstanding reply. Accepted/stopped tasks disappear; final errors disappear after user-prompt cleanup. Completion and token totals survive removal. Task names and current detail take priority on narrow terminals; tokens appear only in the summary.

There are no spinners or worker heartbeats. Native events update progress immediately; visible active elapsed time refreshes once per second. The widget does not poll while idle or fully hidden. Model review keeps unsaved state, empty-ladder consequences and repair warnings prominent; omitted rows point to the transcript comparison.

After process closure, each execution reads the saved native journal, including late shutdown usage. A valid whole-session snapshot replaces the previous snapshot so continuation does not charge earlier executions again. An unreadable, corrupt or identity-mismatched final journal cannot replace confirmed accounting. Unpersisted provider usage cannot be reconstructed.

Acceptance, explicit stop or automatic failure collection transfers original assistant, tool, compaction, branch-summary and native usage. Delivery changes visibility only, not billing. Captured usage is aggregated until the next subagent tool result reports it once, including setup usage. Commands and notifications alone cannot add it to native parent tool-result totals; uncollected work at shutdown is not charged through this extension. Costs are never repriced through the parent model or ladder estimates. Streamed widget tokens reconcile with the confirmed saved snapshot after execution.

## Native boundaries

- Task states are `queued`, `active`, `paused` and `ready`; reply/error/stopped are outcomes. Pausing and closing are temporary operations. Process closure is not proof of success or semantic completion: native provider errors can accompany exit code zero, and an old restored answer is not a new reply.
- At most one execution owns a task's journal. Continuation validates readability, structure and the observed native session identity; it does not prove unchanged history. Valid edits or truncation retaining that identity are outside this continuity check. Pi owns restoration; pi-sub does not reconstruct transcripts.
- Only a new saved user entry confirms exact input persistence. Streamed events precede journal writes. Input transformations may make persistence unverifiable; failed/interrupted work then conservatively replays the instruction. Neither interruption nor replay guarantees exactly-once external effects.
- Children load normal Pi resources in the same trusted working directory. `--approve` conveys project trust, **not** approval of individual tools. Parent-only runtime registrations and process-local tool filters are not replayed; configure providers and tools as normal resources. Child stdout must remain valid native JSON; diagnostics belong on stderr. Own and known legacy delegation tools are excluded to prevent recursion.
- Child widgets, titles and editor changes are not forwarded. Native headless UI returns `false` for `confirm` and `undefined` for `select`, `input` and `editor`. Extensions must honor denial/cancellation and `ctx.hasUI`; the parent model cannot grant human authorization. Not every headless UI attempt is observable. Dialog-only input without a new assistant response fails explicitly. Separate processes and trusted extensions are not a filesystem sandbox.

## Development

```sh
pnpm run check
pnpm test
pnpm run format:check
```

Tests include real parent/child Pi processes with a synthetic local provider and no paid model calls. They cover routing, review/publication, interruption, continuation, reply delivery, collection and native usage.

See the [architectural decisions](docs/decisions/) and [source terms](NOTICE.md). Code is [MIT licensed](LICENSE).
