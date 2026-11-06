# pi-sub

A small coordinator for native [Pi](https://pi.dev) subprocesses. Pi owns conversation history, tools, compaction and retries. This extension selects executions by minimum strength, coordinates their work, and shows a compact widget.

A subagent is a task with a native Pi session, not a permanently living process. Each execution uses a fresh, short-lived `pi --mode json --print` process. A ready response may be a question: answering starts another process on the same session; accepting removes the task. A complete reply delivered to the parent context folds its widget row without accepting or removing the task. Ready and paused tasks hold no process.

## Install

Requires Pi 1.5-compatible host packages and Node.js 22.19 or newer. Load this local checkout:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pi install /absolute/path/to/pi-sub
```

Remove the old `pi-subagents` package from Pi's configuration before loading this replacement. Use `pi list` to find its configured source and `pi remove <source>` to remove it. This repository does not alter the old checkout or your Pi configuration automatically. Use `/reload` after installation or source changes.

## Choose the model ladder

The only runtime model configuration is **`<agent-dir>/pi-sub-config.json`**, normally `~/.pi/agent/pi-sub-config.json`. Pi's `PI_CODING_AGENT_DIR` selects a different profile. There are no project overrides, local fallbacks or automatic imports.

The file is deliberately short and directly editable:

```json
{
  "6": { "model": "openai-codex/gpt-6.1-terra:low", "cost": 0.07134 },
  "7": { "model": "openai-codex/gpt-6.1-terra:medium", "cost": 0.1688 },
  "8": { "model": "openai-codex/gpt-6.1-terra:high", "cost": 0.25928 },
  "9": { "model": "openai-codex/gpt-6.1-sol:high", "cost": 0.59099 }
}
```

This illustrates the format, not bundled defaults or authorization. Each key is an operator-confirmed strength from 1 to 10. Each row contains only an exact `provider/model:thinking` reference and a nonnegative reference cost, or `null` when unknown. `{}` disables delegation. Costs shown here are rounded AA Intelligence Index v5.0.1 USD/task references, **not live task prices or Codex quota consumption**.

The confirmed ladder authorizes subagent execution independently of the main session\'s model scope. Pi\'s `enabledModels`, cycling scope and thinking pins remain main-session preferences, not a second delegation whitelist. Dispatch walks upward from the required minimum and takes the first natively available rung. It never sorts by cost, infers an unlisted variant or requires a separate benchmark database. Native availability, credentials, supported thinking and sufficient confirmed ladder membership are rechecked before each retained execution. If no listed rung qualifies, delegation fails explicitly.

### Review, refine, accept

Run `/sub:models` in a TUI or persistent RPC session. A native dialog lets you choose candidates from current Pi availability, regardless of the main session\'s scope. Models in the saved ladder are preselected; with no saved file, the current parent model is the initial suggestion. An existing empty ladder does not implicitly select models. Unavailable saved references are labelled, not silently dropped. Toggle models and choose **Review selected models**; this selection is temporary and writes no configuration. Cancelling the dialog starts no research.\n\nA research task then uses the exact current parent model/thinking captured when the command opened, without requiring an existing ladder. New or changed assignments are limited to the selected candidates. Available models you deselect must not remain in the draft; unavailable saved entries may remain unchanged, not be silently regraded or repriced. Proposed removals remain visible and require final confirmation. In the TUI, the proposal appears in a non-modal panel above the editor and a transcript comparison. RPC clients use the same native `select` request/response protocol and receive the same comparison messages. **The saved ladder remains active; choosing candidates and starting research never activate a draft.**

Type normal prompts to refine the proposal. These inputs go to the same native research session through fresh executions, not a separate parent model turn. Background task replies remain visible but do not trigger a new parent model turn while selection is open. During selection, text prompts are reserved for refinements; unrelated native commands remain available. Use:

- Type `accept` in the normal prompt to publish the finished draft that was shown. The slash-command form deliberately cannot confirm: native commands do not identify the input source.
- `cancel` or `/sub:models cancel` to close selection and stop its task.
- `/sub:pause` to interrupt work; a refinement or explicit continuation can resume the research.

Early or stale acceptance is refused. Repeating `/sub:models` while selection is open redisplays it rather than discarding edits. After closing, run it again whenever you want another comparison. Print mode cannot maintain this interactive review; edit the file directly instead. Reload/shutdown discards unconfirmed drafts, not the saved ladder.

Research needs normally configured web/search tools. The [review instructions](instructions/model-capabilities.md) retain calibration anchors, require honest uncertainty and separate observations from qualitative judgments. Research uses existing evidence rather than paid model benchmarks; the research model itself can incur ordinary usage. Evidence and reasons stay in the comparison/native session, not in a runtime assessment catalog. Only user-selected variants can receive new authority, and native availability is rechecked at publication. Changing the candidate models requires a new selection; ordinary refinements do not silently widen it.

Research disables built-in shell, write, edit and codemode tools. Other configured tool extensions remain trusted; this is not a filesystem sandbox. Model output, extension-generated input and words such as “accept” inside a comparison cannot confirm a draft.

Explicit acceptance replaces the whole ladder under a cross-process lock. A byte-for-byte baseline check prevents overwriting concurrent manual edits or another session's accepted choice. Final authorization, interruption and revision checks run immediately before synchronous atomic publication. Interrupting or cancelling does not roll back an already committed file. A storage cleanup error can require inspection before retrying.

The configuration is private (`0600`). Its exact filename is appended to `<agent-dir>/.gitignore` without replacing existing content or ignoring the entire Pi profile. Project-native task sessions remain separately protected by `<cwd>/.pi/pi-sub/.gitignore`. Keep benchmark-derived material private unless source redistribution rights have been reviewed.\n\nThere is no compatibility fallback to `<agent-dir>/pi-sub/models.json`, project-local ladders or old assessment catalogs. When upgrading, explicitly back up and move an already confirmed compact ladder to `pi-sub-config.json`; historical assessment catalogs require a deliberate conversion, not a rename. Archive obsolete configuration separately from session histories, and reload running Pi sessions after migration. Pi settings, authentication, provider catalogs and saved session histories are not pi-sub configuration and are not rewritten.

## Parent tools

| Tool          | Meaning                                                                                                                                                                                                                            |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sub_task`    | Start a bounded task with required `level` (integer 1–10) and `prompt`; optional `description`. Returns its ID immediately.                                                                                                        |
| `sub_message` | Send `{ id, message }`: stop active execution, wait for termination, then start a fresh process on the same session with the correction. Also updates queued work or answers/resumes a retained response.                          |
| `sub_result`  | Inspect `{ id }` without removing it. Optional `wait` and timeout in seconds observe only. Complete delivery folds the widget row and keeps follow-up available. `finish: true` explicitly accepts/removes the task. A small receipt supports repeated retrieval. |
| `sub_control` | Explicit action `pause`, `continue` or `stop`, with optional `id`; omit it to control all applicable tasks.                                                                                                                        |

```text
sub_task({ level: 3, prompt: "Inspect the authentication entry points without modifying files.", description: "Review auth" })
sub_result({ id: "<task-id>", wait: true, timeout: 30 })
sub_message({ id: "<task-id>", message: "Use the production schema, then continue." })
sub_result({ id: "<task-id>", finish: true })
```

A wait timeout does not stop work. Reading a question does not accept it. After final acceptance, repeated retrieval returns the captured result, not a restarted process. A removed task cannot be resumed; create a new task for unrelated work. `finish: true` is not needed to acknowledge a delivered report or clean up its widget row.

The parent receives asynchronous replies in bounded batches at the next safe native turn boundary, after tool calls finish and before the next model request. A natural continuation carries the batch without an extra acknowledgement turn. Idle arrivals are coalesced in the next event-loop turn and may wake the parent once; interruption blocks automatic wakeups. There are no per-worker follow-ups waiting behind the parent's work. Before batching, current reply identities are checked against complete tool returns and prior native announcements, excluding accepted, stopped and superseded replies. Overflow remains pending for the next boundary.

Notifications are observations rather than automatic acceptance. Each reply has a distinct identity. It is marked delivered only when its complete notification or tool return appears in the parent's native context, not when a batch is proposed or announced. A delayed delivery cannot acknowledge a successor reply. Truncated notifications explicitly point to `sub_result` and leave that reply outstanding until complete delivery or explicit acceptance; they are not repeatedly announced. TUI batches show a two-line preview per reply and expand to the full reports. Operating guidance lives once in the system-prompt section and operation-specific tool contracts, not underneath each report. The parent is instructed to handle routine reports internally and surface only material results, blockers or user decisions. Final failures are shown in the widget and collected automatically before the next real user prompt; they do not wake an interrupted parent or require a cleanup tool call. Control tools are model-only and sequential; child execution remains concurrent. Four executions are allowed concurrently by default. Only active executions occupy slots, including their termination and final capture. Ready replies, paused tasks and retained failures use no process or execution slot; additional tasks wait without a process.

## Interrupt and continue

The controller has two user inputs: **prompt** and **interrupt**. An interrupt aborts the parent, pauses children and prevents queued or newly requested tasks from starting. The coordinator requests native shutdown with SIGTERM, escalates to SIGKILL if needed, and waits for process closure and drained output. Corrections remain coordinator-owned until sent; an interrupt during redirection cancels restart and retains them. Failed termination retains ownership and its slot so cleanup can be retried. Before forwarding a real user prompt, the coordinator captures remaining failure reports and undelivered inputs, ensures failed workers are closed, transfers the reports into native parent history and removes the failed tasks. This happens without calling the model. An interrupt during this handoff cancels forwarding; reports are retained until delivered. A new user prompt starts only the parent, not its children. The parent decides only how to continue the work, not how to release failed processes.

In the terminal, Escape also pauses children while the parent is idle; dismissing an extension dialog does not. Operator commands work without a model call:

```text
/sub:pause [task-id]
/sub:continue [task-id]
/sub:stop [task-id]
```

No ID means all applicable tasks; `/sub:pause` without an ID is the global interrupt and also aborts the parent. Explicit operator start/continue commands pass through the same failure cleanup before starting work. In RPC mode, use `prompt("/sub:pause")` for a global interrupt while the parent is idle: bare RPC `abort` emits no public extension event in that situation. Active run aborts, retry-backoff aborts and compaction signals are observed through native lifecycle hooks. Pause retains the original task and session. It does not freeze a model request or undo file writes and external side effects. Parent shutdown, reload or session replacement terminates owned executions; it does not restore pending work on restart. Native Pi session files remain under `.pi/pi-sub/sessions` for inspection.

## Views

Native tool rows show the task name and confirmed action or outcome: delegated, queued, instruction updated, response, accepted, paused, resumed or stopped. A reply is not labelled done merely because execution ended. Reads preview the answer; acceptance does not repeat it. A wait timeout is ordinary feedback, not cancellation. Batch actions summarize confirmed results and expose failures rather than claiming universal success.

Expand a row through Pi's configured tool-expansion control to inspect the original request, full response, ID, session path, required minimum level, actual model/thinking, elapsed time and usage counters. Running calls also expose their request when expanded. Tool renderers use native row-local state and support native HTML exports; they do not inspect or restart workers. Model-facing tool content and original usage attribution are unchanged.

Reply notifications, collected failures, stop acknowledgements and model comparisons use matching compact transcript views. Causes remain visible on failures. Full structured reports remain available when expanded; long replies and comparisons come from their preserved metadata without repeating the same proposal inside diagnostic JSON. Normal previews omit IDs, model names and JSON. RPC/print consumers retain structured data rather than TUI formatting.

The non-modal model panel marks drafts as unsaved, labels costs as AA USD/task references and compares changes with the opening snapshot, not a live read of the saved file. Empty-draft and repair warnings take priority over rows when space is limited. Publication errors remain visible; a saving state does not promise that an already committed change can still be cancelled.

## Widget and usage

The above-editor tree has stable newest-first rows with aligned level, short activity, turns, tools and time fields. Counter columns fit three digits plus their symbol and expand only when necessary; stopped elapsed clocks are dimmed. Task names and response previews share unused space up to a six-column right inset, reclaimed on narrow terminals. Tokens appear only in the bottom summary. Task and current detail have priority at narrow widths. Active, paused, failed and undelivered ready tasks have rows. Completely delivered replies collapse into a `delivered` count while their tasks remain available for follow-up; this is not a `done` or acceptance count. A new reply becomes outstanding again. Accepted replies and stopped tasks are removed immediately. Final errors remain visible until the next user-prompt cleanup, then disappear without leaving an open-error counter. Completion totals and tokens survive task removal. Activity includes `thk`, `txt`, `cmd`, `rd`, `rdy`, `pse` (paused), `psg` (pausing), `cls` (closing), `err` and `stp`.

There are no spinners. Visible active elapsed time refreshes every second; lifecycle changes render immediately. The widget does not poll while idle or fully hidden. There are no worker heartbeats, RPC state queries or settlement handshakes: native events show progress, and process closure ends execution.

Each execution reads the final saved native session after process closure, including late persisted shutdown usage. Its whole-session usage snapshot replaces the previous snapshot; earlier executions are not charged again on continuation. Final acceptance, an explicit stop or automatic failure collection transfers original assistant, tool, compaction, branch-summary and native usage records. Delivery acknowledgment changes visibility only; it neither transfers billing usage nor closes the retained task. Damaged or missing journals produce errors rather than silently replacing task history; available valid usage is retained, but unpersisted provider usage cannot be reconstructed. Costs are not repriced through the parent model or routing estimates. The next subagent tool result reports captured usage once, including pending setup usage. Setup commands and notifications alone cannot add usage to native parent tool-result totals; uncollected work at shutdown is not charged through this extension.

Widget tokens update from streamed assistant usage while active and reconcile with the complete saved native usage snapshot after execution. Relative routing costs are weighted AA Intelligence Index v5.0.1 costs with a fixed baseline, not predictions of task cost, subscription quota or invoices.

## Boundaries

Live task states are `queued`, `active`, `paused` and `ready`. Reply/error/stopped are outcomes, not additional states. Pausing and closing are temporary operations. Taking an outcome removes the task; a receipt contains no worker, listeners, timers or process slot.

At most one execution may own a task's journal. A new process restores persisted native history, not in-memory extension state or an interrupted provider request. An unpersisted instruction is retained for continuation. Only a new saved user entry confirms input persistence; streamed message events precede native journal writes and are not proof. Once observed, the native journal identity must survive subsequent executions. Input transformations can make exact persistence unverifiable; interrupted work then conservatively replays that instruction. Neither interruption nor replay provides exactly-once external side effects.

Process exit is an execution boundary, not proof of success or semantic completion. Native provider errors can accompany exit code zero. New native output, saved entries and exit information are checked; an old restored answer is never returned as a new response. Pi owns conversation execution and restoration; no replacement agent loop, transcript reconstruction or private-field inspection is used.

Children load normal Pi resources and use the same trusted working directory. The parent's project trust is conveyed through Pi's process-local `--approve` flag; this is **not** approval of individual tool actions. Separate processes are not a filesystem sandbox.

Parent-only runtime registrations and process-local tool filters are not replayed. Configure providers and tools through normal Pi resources so the child can load them independently. Child extensions must keep stdout valid native JSON; use stderr for diagnostics. Own and known legacy delegation tools are excluded in children. Child widgets, titles and editor changes are not forwarded.

There is no interactive child UI. Native print mode returns `false` for `confirm` and `undefined` for `select`, `input` and `editor`; it never grants human approval. Native headless UI calls do not emit observable dialog events, so not every attempt can be diagnosed. Extensions must honor denial/cancellation and `ctx.hasUI`. Dialog-only input without a new assistant response is an execution error. The parent model never substitutes for human authorization.

## Development

```sh
pnpm run check
pnpm test
pnpm run format:check
```

Tests include real parent and child Pi processes with a synthetic local provider: no paid model calls. They exercise setup, routing, interruption, continuation, collection and native usage attribution. No own session engine, public service framework, role system or turn budget is implemented.

See the [architectural decisions](docs/decisions/) and [source terms](NOTICE.md). Code is [MIT licensed](LICENSE).
