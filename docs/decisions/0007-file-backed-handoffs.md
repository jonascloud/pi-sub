# 0007 — File-backed handoffs

Status: Accepted

## Decision

A complete handoff is either the report text or a reference to its fully published, immutable file. Delivery means that exact handoff reached the parent's model context, not that the parent read every detail. The parent chooses what to read. Acceptance, stopping and follow-up keep their existing meanings.

Never truncate serialized task reports. Bound the entire model-facing envelope, including metadata and file references. An oversized batch uses one file rather than an unbounded list of paths or additional notification turns. Preserve response text, errors and pending input in readable UTF-8, with full original diagnostics in native message details.

Keep artifacts private and ignored alongside project session data. Publish before returning a reference, never overwrite an earlier artifact, and fail explicitly if publication fails. Identical reports can reuse the same content-addressed file. Do not remove artifacts when tasks close or sessions stop: persisted parent history still refers to them.

## Rationale and consequences

Line-based truncation of compact JSON can erase the entire report, including identity and state. A file reference retains access without forcing large output into the model context. No new reading tool, read tracking or second delivery ledger is needed; native history retains the exact handoff and its reply identities.

Synchronous local publication keeps delivery-boundary snapshots consistent without adding asynchronous coordination. It can delay the event loop for large reports or slow storage. File growth and cleanup are explicit ownership costs, like retained session journals; external deletion can invalidate old references. See the [delivery contract](../../README.md#replies-and-delivery) for limits and native result shapes.
