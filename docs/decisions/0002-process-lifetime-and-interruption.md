# 0002 — One process per subagent

Status: Accepted

## Decision

A subagent is one Pi process serving one task. Keep its process and session while working, paused or awaiting an answer. When the parent accepts the final result, capture the result, usage and session path, then close the process. Repeated retrieval uses the captured result without reporting the same usage again. Parent shutdown closes owned children.

Do not pool processes or reuse completed subagents for unrelated follow-up tasks. Pausing, steering and answering within the original task are not reuse. Saved Pi sessions remain artifacts; they do not imply automatic job recovery.

On parent interruption, prevent queued work from starting, clear each child's queued inputs before aborting its current operation, and retain the cleared input for the parent's decision. Confirm quiescence rather than claiming an immediate freeze. Preserve the task and session; interruption does not roll back side effects.

A new user prompt restarts only the parent. Children remain paused until the parent explicitly continues them, sends a correction and continues, or closes them.

## Rationale and consequences

This gives ownership and release an explicit boundary without a retention subsystem. Reuse would require stronger guarantees about context, configuration and extension state; consider it only if measured startup cost justifies that complexity. Continuation is another prompt in the retained session, not resumption of an interrupted model request.
