# 0005 — The configured ladder authorizes delegation

Status: Accepted

## Decision

The effective ladder is the sole declaration of delegation intent. Do not persist an additional enabled-model list or inherit the main session's cycling scope as a subagent permission boundary. Pi availability, credentials, supported thinking and project trust remain hard limits. Each configured rung authorizes its exact execution at task creation. Ladder changes affect new tasks, not revocation of existing tasks; native execution capability can still fail.

The runtime validates the effective settings and the execution, not who authored or approved them. User review belongs to the normal agent conversation, as described in [0006](0006-agent-authored-ladder.md).

## Rationale and consequences

An independent cycling whitelist would duplicate delegation intent and conflate it with the parent's model scope. The ladder expresses delegation intent directly while the parent remains free to use its own scope. Availability is a runtime capability check, not another persisted authorization catalog.

Native Pi history remains independent; process boundaries, native transcript ownership, permission denial and original usage accounting are unchanged.
