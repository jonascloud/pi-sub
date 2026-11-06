# 0004 — A user-confirmed global model ladder

Status: Accepted

## Decision

Keep one short runtime configuration per native Pi profile at `<agent-dir>/pi-sub-config.json`, using public `getAgentDir()` and respecting `PI_CODING_AGENT_DIR`. It maps strength levels 1–10 to exact `provider/model:thinking` references and informational costs. There is no version header, persisted evidence registry, selected model pool or additional ranking policy. There are no project overrides, local fallbacks or automatic repository imports.

Dispatch selects the first currently available, user-confirmed rung at or above the requested minimum. Costs never reorder it. Unknown reference cost is `null`, not invented zero. The operator-confirmed rung is authoritative; no hidden benchmark assessment overrides a manual classification. Recheck native availability and sufficient ladder membership before each retained task executes; parent cycling scope is not delegation authority (see [0005](0005-confirmed-ladder-authorizes-delegation.md)). Actual usage remains the original native usage, never a calculation from ladder costs.

## Human selection

`/sub:models` first opens a native candidate-selection dialog over current availability. The saved ladder supplies preselection, not a separate persisted whitelist. After human selection, it opens a non-modal draft panel and researches with the exact initial parent model/thinking in an ordinary supervised native task. Show the saved-at-start ladder, a plainly uncommitted draft, changes and comparison. Prompts refine the same native session. No parent model cleanup turn or custom agent loop is needed.

Only explicit operator acceptance publishes a finished, revision-bound draft. Capture the shown revision before asynchronous input preparation; a newly arriving result cannot retroactively satisfy an early acceptance. Only normal input explicitly identified as interactive or RPC user input can confirm. Slash commands cannot confirm, because native command dispatch does not expose the originating input source; extensions can invoke commands through expanded messages. Model text and extension-generated inputs are not confirmation. Cancellation closes the workflow; failures preserve the file unless publication already completed. Native research and receipts remain governed by ordinary task ownership.

A proposal contains only a ladder and human-readable comparison. Research new assignments only within the human-selected native candidates. Unavailable global rows may remain unchanged, not be regraded or have their cost changed implicitly. Available models deliberately deselected by the user cannot retain assignments in the new draft. Evidence, sources, dates, suitability judgments and uncertainty stay in the comparison and native session rather than bloating the configuration. Historical calibration anchors guide suggestions, not automatic routing. No paid benchmarks run implicitly.

The research profile disables built-in shell, editing, writing and codemode tools. It loads normal provider/search resources; trusted custom tools are not a security sandbox. Child permission dialogs retain native headless denial, never model approval.

## Publication and lifetime

Keep the ready research task controllable until publication. Serialize writes with `proper-lockfile`; compare the exact saved-at-start bytes inside the lock and again after asynchronous file preparation. Verify shown draft, current authorization, task readiness and the interruption epoch immediately before `renameSync`, without yielding. A competing edit requires a new review, not an implicit merge.

Explicit acceptance replaces the whole ladder, unlike the previous per-candidate assessment merge: the user confirmed the complete visible choice. Empty configuration disables delegation. Invalid files fail explicitly but can be deliberately repaired through a reviewed replacement. Private files and ignore rules are retained. Legacy evidence catalogs require an explicit one-time conversion, not runtime compatibility logic.

A paused research task can continue through native history. New user input resumes only the parent unless it explicitly refines selection or continues that task. Reload/shutdown discards drafts and terminates owned executions; it does not restore an interactive selection job.

## Rationale

The cheapest weighted benchmark result does not capture brevity, response time, reasoning overhead or task suitability. Adding opaque weights or cost tolerances would not make those judgments objective. The model advises, the user chooses, and execution performs a transparent lookup. A short hand-editable ladder is enough.
