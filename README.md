# pi-sub

A small coordinator for native [Pi](https://pi.dev) subagents. Pi owns conversation history, tools, compaction and retries; pi-sub owns model routing, task and process lifetime, and compact presentation.

A **task** owns a native Pi session. Each **execution** is a fresh `pi --mode json --print` process on that session. A reply may be a question: a follow-up continues the session, and explicit acceptance removes the task. Ready and paused tasks hold no process.

## Install

Requires Pi 1.5-compatible host packages and Node.js 22.19 or newer:

```sh
pi install git:github.com/jonascloud/pi-sub
```

Use `/reload` after installation or source changes.

## Model ladder

The only configuration is `<agent-dir>/pi-sub-config.json`, normally `~/.pi/agent/pi-sub-config.json` (`PI_CODING_AGENT_DIR` selects another profile). It maps strengths 1–10 to exact `provider/model:thinking` references. This is a format example, not a default:

```json
{
  "3": "provider/fast-model:off",
  "6": "provider/reasoning-model:medium",
  "8": "provider/reasoning-model:high"
}
```

Strength is a rough local scale with workload anchors, not a benchmark score: 1–2 narrow mechanical work, 3–4 bounded routine implementation, 5–6 multi-file changes and moderate analysis, 7–8 complex design and debugging, 9–10 the hardest, highly uncertain work. Unused levels stay empty; `{}` disables delegation.

Each task requests a minimum level. Dispatch picks the first natively available rung at or above it and fails explicitly if there is none. The ladder authorizes delegation independently of the parent's model scope; availability, credentials, supported thinking, project trust and ladder membership are rechecked before every execution, including continuations. Edits apply to the next execution without a reload.

pi-sub reads the file but never writes it. To create or revise it, ask your coding agent to follow [the ladder setup guide](instructions/create-model-ladder.md), for example from this checkout:

```sh
pi @instructions/create-model-ladder.md "Help me create or revise my pi-sub model ladder."
```

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

A wait timeout does not stop work. Reading a reply does not accept it, and a delivered reply needs no acknowledgement: the task stays open for follow-up until accepted or stopped. Accepted and stopped tasks cannot resume, but their results remain retrievable in the active parent session.

Replies arrive on their own. At the next safe turn boundary, or once when the parent is idle, pi-sub batches unannounced replies into one message; a complete tool return already counts as delivery. Large reports and batches are handed off as a reference to a private temporary file instead of being clipped. These files expire on session switch, fork, reload or shutdown, so preserve relevant findings before leaving the session.

## Interrupt and continue

An **interrupt** pauses all children and closes admission until the next user prompt. Aborting an active parent run, for example with Escape, is an interrupt. While the parent is idle, Escape keeps its native meaning; use `/sub:pause`. A new user prompt resumes only the parent, which decides which children to continue.

```text
/sub:pause [task-id]
/sub:continue [task-id]
/sub:stop [task-id]
```

No ID means all applicable tasks; `/sub:pause` without an ID is the global interrupt. In RPC, send `prompt("/sub:pause")`: an idle RPC `abort` emits no extension event.

Pausing terminates the process (SIGTERM, then SIGKILL) and continuation restarts it on the same session. It does not undo writes or external effects. Failed tasks are closed and their reports handed to the parent before the next user prompt, without a model cleanup turn.

Up to four executions run concurrently. Queued, paused and ready tasks hold no process. Shutdown, reload and session replacement close all executions and delete the temporary workspace; reopening a saved conversation starts without tasks.

## Views and usage

Tool rows and transcript messages show task names, confirmed outcomes and compact previews; expand them for requests, full delivered text, IDs, execution and usage. The widget above the editor shows outstanding work: active, paused, failed and undelivered tasks. Delivered replies fold into a count; the summary shows native `↑input ↓output` tokens of all subagents.

Usage is read from each child's saved journal after every execution and charged to the parent session with the next subagent tool result, independent of acceptance. Pi offers extensions no other way into session totals, so work confirmed after a session's last subagent tool result is missing from them.

## Boundaries

- Children load normal Pi resources from the same profile and working directory, including `AGENTS.md` and project context, but not the parent's conversation, runtime-only registrations or tool filters. The delegation tools are excluded to prevent recursion.
- `--approve` conveys project trust, **not** approval of individual tools. Children have no interactive UI: `confirm` returns `false` and other dialogs return `undefined`. The parent model cannot grant human authorization.
- Separate processes are not a filesystem sandbox. Interruption and replay do not guarantee exactly-once external effects.
- Process exit is not success: a reply requires a new saved assistant response. Continuations check the journal's identity and structure, not that its history is unchanged.

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
