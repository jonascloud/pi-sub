# 0005 — The configured ladder authorizes delegation

Status: Accepted; selection and publication workflow superseded by [0006](0006-agent-authored-ladder.md).

## Decision

The profile ladder is the sole declaration of delegation intent. Do not persist an additional enabled-model list or inherit the main session's cycling scope as a subagent permission boundary. Pi availability, credentials, supported thinking and project trust remain hard limits. Each configured rung authorizes its exact execution; retained tasks must still match a sufficient rung before every admission.

The runtime validates the file and the execution, not who authored or approved the file. User review belongs to the normal agent conversation, as described in [0006](0006-agent-authored-ladder.md).

## Rationale and consequences

A ladder and an independent cycling whitelist created two overlapping declarations of intent: an explicitly configured rung could silently dispatch another model because the first was outside the parent scope. The ladder expresses delegation intent directly while the parent remains free to use its own scope. Availability is a runtime capability check, not another persisted authorization catalog.

Native Pi settings and history remain independent; process boundaries, native transcript ownership, permission denial and original usage accounting are unchanged.
