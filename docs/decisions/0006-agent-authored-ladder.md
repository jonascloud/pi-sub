# 0006 — Agents author the ladder; pi-sub consumes it

Status: Accepted

## Decision

Create and revise the ladder in the normal agent conversation using [one setup guide](../../instructions/create-model-ladder.md). The agent discovers available executions, compares useful candidates, discusses the complete proposal with the user, and edits the configuration with ordinary tools.

pi-sub only reads, validates and routes from native effective settings; it never writes them. Every delegated task has a required minimum level. Missing or unusable configuration points to the guide instead of starting a setup workflow.

## Rationale and consequences

Model choice is an occasional advisory task. A separate setup mode duplicates conversation capabilities and couples configuration editing to task lifetime, interruption and reply delivery. Native agent tools already support research and file editing, including before delegation is configured.

Approval is an instruction to the agent, not an extension-enforced authorization step. pi-sub provides no configuration writer or publication lock. The guide requests approval, change checks and safe editing; it does not claim those are runtime guarantees.

Routing and authorization are defined in [0004](0004-on-demand-model-capabilities.md) and [0005](0005-confirmed-ladder-authorizes-delegation.md).
