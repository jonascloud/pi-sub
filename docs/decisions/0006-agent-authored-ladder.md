# 0006 — Agents author the ladder; pi-sub consumes it

Status: Accepted

## Decision

Create and revise the ladder in the normal agent conversation using [one setup guide](../../instructions/create-model-ladder.md). The agent discovers available executions, compares useful candidates, discusses the complete proposal with the user, and edits the configuration with ordinary tools.

pi-sub only reads, validates and routes from that file. Remove `/sub:models`, its candidate picker, research task, draft panel, input interception and publication machinery. Every delegated task has a required minimum level. Missing or unusable configuration points to the guide instead of starting a setup workflow. Keep the existing file format and execution checks; no configuration migration is needed.

## Rationale and consequences

Model choice is an occasional advisory task. A separate setup mode duplicates conversation capabilities and couples configuration editing to task lifetime, interruption and reply delivery. Native agent tools already support research and file editing, including before delegation is configured.

Approval is now an instruction to the agent, not an extension-enforced, revision-bound authorization step. pi-sub no longer provides a configuration writer, cross-process publication lock, private file creation or profile ignore-rule management. The guide requests approval, change checks and safe editing; it does not claim those are runtime guarantees.

Existing configuration remains active until externally edited. Changes affect subsequent admission, including continuations, but do not interrupt an already running execution. The configured execution remains independent of the parent model's cycling scope, with native availability and sufficient ladder membership checked before execution.

This replaces the setup-specific portions of [0004](0004-on-demand-model-capabilities.md) and [0005](0005-confirmed-ladder-authorizes-delegation.md).
