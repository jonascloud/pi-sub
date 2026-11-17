# pi-sub

A small coordinator for native [Pi](https://pi.dev) subagents. Pi owns conversation history, tools, compaction and retries; pi-sub owns model routing, task and process lifetime, and compact presentation.

A **task** owns a native Pi session. Each **execution** is a fresh `pi --mode json --print` process on that session. A reply may be a question, and an execution may fail: a follow-up continues the session either way, and explicit acceptance removes the task. Ready and paused tasks hold no process.

## Install

Requires Pi 1.5-compatible host packages and Node.js 22.19 or newer:

```sh
pi install git:github.com/jonascloud/pi-sub
```

Use `/reload` after installation or source changes.

## Model ladder

Configure `piSub.ladder` in native Pi settings. Profile defaults live in `<agent-dir>/settings.json` (normally `~/.pi/agent/settings.json`; `PI_CODING_AGENT_DIR` selects another profile). A trusted project's `.pi/settings.json` can override or add individual rungs. This is a format example, not a default:

```json
{
  "piSub": {
    "ladder": {
      "3": "provider/fast-model:off",
      "6": "provider/reasoning-model:medium",
      "8": "provider/reasoning-model:high"
    }
  }
}
```

Strength is a rough local scale with workload anchors, not a benchmark score: 1–2 narrow mechanical work, 3–4 bounded routine implementation, 5–6 multi-file changes and moderate analysis, 7–8 complex design and debugging, 9–10 the hardest, highly uncertain work. Unused levels stay empty. An empty project ladder `{}` inherits profile rungs; it does not disable delegation. There is no per-rung delete or off switch, and `false` and `null` are invalid. If the effective ladder has no rungs, delegation fails with an explicit unconfigured error.

Each task requests a minimum level. On task creation, routing picks the first natively available rung at or above it and fails explicitly if there is none. The model and thinking level stay fixed for the task's lifetime, including queueing and continuations. New tasks use the effective settings snapshot; existing tasks retain their selection and authorization. Manual edits take effect according to Pi's settings reload lifecycle; `/reload` disposes open tasks. Native execution capability can still fail. The ladder authorizes delegation independently of the parent's model scope.

pi-sub reads effective settings but never writes them or falls back to the old `<agent-dir>/pi-sub-config.json`. To migrate once, manually copy its rung mapping into `piSub.ladder` in the desired settings scope, preserving other settings. To create or revise it, ask your coding agent to follow [the ladder setup guide](instructions/create-model-ladder.md), for example from this checkout:

```sh
pi @instructions/create-model-ladder.md "Help me create or revise my pi-sub model ladder."
```

## Parent tools

| Tool          | Contract                                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sub_task`    | Start bounded work with required `level` (integer 1–10) and `prompt`, plus optional `description`. Returns an ID immediately.                                                               |
| `sub_message` | Send `{ id, message }`. Updates queued input or stops active execution, waits for closure, then continues the same session with the correction. Also answers ready, failed or paused tasks. |
| `sub_result`  | Inspect `{ id, wait?, timeout?, finish? }`, or page `{ report, offset?, limit? }`. `finish: true` explicitly accepts/removes a ready task.                                                              |
| `sub_control` | `pause`, `continue` or `stop`, with optional `id`; omit it to control all applicable tasks. Stopping never rolls back side effects.                                                         |

```text
sub_task({ level: 3, prompt: "Inspect the authentication entry points without modifying files.", description: "Review auth" })
sub_result({ id: "<task-id>", wait: true, timeout: 30 })
sub_message({ id: "<task-id>", message: "Use the production schema, then continue." })
sub_result({ id: "<task-id>", finish: true })
```

A wait only observes. It ends with a reply or failure, when its task pauses, at its timeout, or as soon as the user sends a message, so a waiting parent never holds the user back. None of these stops work. Reading a reply does not accept it, and a delivered reply needs no acknowledgement: the task stays open for follow-up until accepted or stopped. Accepted and stopped tasks cannot resume; cached reports survive task removal until eviction or runtime teardown. If acceptance is the first delivery, it includes the result. Otherwise it confirms only the task ID, accepted status and available report ID. `/sub:stop` also names any final report IDs without repeating replies. There are no idempotent task receipts.

Replies and failures arrive on their own. At the next safe turn boundary, or once when the parent is idle, pi-sub batches unannounced ones into one message; a complete tool return already counts as delivery. Each completed execution has an immutable report ID. Serialized reports up to 2 KiB are inline; larger ones include a reference, a response preview of at most 512 bytes and an error preview of at most 240 bytes. A result or batch is at most 8 KiB; an oversized batch is cached as a report with a summary and reference.

Page a report with `sub_result({ report: "<report-id>", offset: 0, limit: 4096 })`. This returns plain text and the next offset without executing a child. Offsets are zero-based UTF-8 byte boundaries; limits are bytes, default 4096, minimum 4 and maximum 4096. The parent runtime has one 16 MiB FIFO cache of UTF-8 report payloads; reads do not refresh it. Eviction returns “Report no longer available”, without recreating the report. A single report over 16 MiB spills to a private temporary file until runtime teardown. A batch also spills if caching it would evict a report it references; later FIFO eviction is unchanged. The budget excludes JS heap, native history, pending input and journals. Session switch, fork, reload or shutdown tears down the runtime; preserve relevant findings before leaving.

## Pause and continue

Aborting the parent, for example with Escape, stops only the parent. Children keep running; their replies wait and do not wake the parent until your next prompt. To stop children, pause them:

```text
/sub:pause [task-id]
/sub:continue [task-id]
/sub:stop [task-id]
```

No ID means all applicable tasks. `/sub:pause` without an ID stops everything: it pauses every child and aborts the parent. Paused children stay paused until `/sub:continue`, a `sub_control` continue or a message. In RPC, send `prompt("/sub:pause")`.

Pausing terminates the process (SIGTERM, then SIGKILL) and continuation restarts it on the same session. It does not undo writes or external effects.

A failed execution leaves its task open. The parent receives the failure like a reply, and a message continues the session, resending instructions that never reached it. Nothing retries on its own. A lost or corrupt journal can prevent continuation.

Up to four executions run concurrently. Queued, paused and ready tasks hold no process. Shutdown, reload and session replacement close all executions and delete the temporary workspace; reopening a saved conversation starts without tasks.

## Views and usage

Tool rows and transcript messages show task names, confirmed outcomes and compact previews; expand them for requests, full delivered text, IDs, execution and usage. The widget above the editor shows outstanding work: active and paused tasks, and replies or failures the parent has not seen. Delivered ones fold into a count; the summary shows native `↑input ↓output` tokens of all subagents.

Usage is read from each child's saved journal after every execution and charged to the parent session with the next subagent tool result, independent of acceptance. Pi offers extensions no other way into session totals, so work confirmed after a session's last subagent tool result is missing from them.

## Boundaries

- Children load normal Pi resources from the same profile and working directory, including `AGENTS.md` and project context, but not the parent's conversation, runtime-only registrations or tool filters. The delegation tools are excluded to prevent recursion.
- `--approve` conveys project trust, **not** approval of individual tools. Children have no interactive UI: `confirm` returns `false` and other dialogs return `undefined`. The parent model cannot grant human authorization.
- Separate processes are not a filesystem sandbox. Interruption and replay do not guarantee exactly-once external effects.
- Process exit is not success: a reply requires a new saved assistant response.

## Development

Clone the repository and install its dependencies. To load the local checkout in Pi, run `pi install /absolute/path/to/pi-sub`.

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run format:check
```

Tests include real parent/child Pi processes with a synthetic local provider and no paid model calls. They do not establish instruction compliance or token savings with real models.

The [architectural decisions](docs/decisions/) record the contracts behind this behavior. Code is [MIT licensed](LICENSE).
