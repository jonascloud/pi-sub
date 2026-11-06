# 0004 — Global ratings, contextual authorization

Status: Accepted

## Decision

Store model assessments once per native Pi profile in `<agent-dir>/pi-sub/models.json`, using the public `getAgentDir()` path and respecting `PI_CODING_AGENT_DIR`. Do not write benchmark data into native provider definitions or settings. There are no project overrides, local fallbacks or automatic repository imports.

Ship assessment instructions and reference-scale rules, not a preselected runtime catalog. `/sub:models` starts a dedicated native-session task using the current parent model and thinking setting, without requiring existing ratings. Research only the operator-approved snapshot and its supported thinking variants. The snapshot validates proposal coverage; it is not persisted as global authorization.

Record every reviewed tuple, including incomplete assessments. Keep sourced measurements, capability judgments, uncertainty and missing-data reasons distinct. Missing evidence is never invented. Research comparable existing evidence; do not run paid model benchmarks implicitly.

Global schema 2 stores ratings without `approved` or `selected`. Assessment method 1, strength anchors and the fixed relative-cost baseline remain unchanged. Complete evidence establishes routing eligibility, not permission. At delegation time intersect it with native availability and current scope, then choose the cheapest sufficiently strong execution. Recheck authorization and the assigned execution's minimum strength before every admission. A variant must not become globally ineligible merely because a cheaper variant exists elsewhere.

Validated research replaces its reviewed tuples while preserving unrelated ratings. Negative reassessment clears old routing eligibility. Serialize read/merge/atomic replacement with a cross-process file lock, read the latest catalog inside the lock and check approval/cancellation immediately before commit. Invalid existing files or method mismatches fail explicitly, never become empty catalogs. Failed or interrupted research before commit preserves existing ratings.

## Rationale and consequences

Assessments describe model capabilities, not repository-specific preferences. Persisting an economical subset from one scope would wrongly prevent a different scope from using its only approved, fully assessed variant. Project-specific rating overrides would reintroduce priority rules and ambiguous routing, so they are deliberately unsupported.

Concurrent Pi sessions must not lose each other's updates. The established `proper-lockfile` library supplies bounded lock acquisition and stale-lock recovery instead of a custom lease protocol. Temporary files and locks are released on failure. A storage cleanup error after commit can still require inspection; do not falsely claim every reported setup failure left the file unchanged.

Version-1 catalogs can be explicitly validated and converted once; they are not runtime compatibility inputs. Preserve evidence and remove historical authorization/selection fields without changing numeric assessments. Native task sessions remain project-local artifacts, not global rating configuration or automatic job recovery.

Generated evidence is ignored by default and remains subject to source terms. The [versioned instructions](../../instructions/model-capabilities.md) retain calibration without bundling routable choices. Research is explicit maintenance, not part of ordinary delegation.
