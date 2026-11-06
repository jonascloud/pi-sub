# 0005 — The confirmed ladder authorizes delegation

Status: Accepted

## Decision

Keep only the compact confirmed ladder in `<agent-dir>/pi-sub-config.json`. Do not persist an additional enabled-model list or inherit the main session's cycling scope as a subagent permission boundary. Pi availability, credentials, supported thinking and project trust remain hard limits. The confirmed rung authorizes its exact execution; retained tasks must still match a sufficient rung before each admission.

`/sub:models` offers a native candidate-selection dialog over current availability. Preselect physical models from the saved ladder, or the current parent model when no file exists. An empty saved ladder does not silently select models. Mark unavailable saved references explicitly. Candidate selection is temporary: it neither changes the ladder nor rewrites Pi settings. The same native `select` loop works in TUI and RPC without a custom screen or headless approval bridge.

Only selected candidates can receive new or changed assignments. Deliberately deselected available models cannot keep assignments in a draft. Unavailable entries may remain exactly unchanged; removals are visible in the proposed whole-ladder replacement. Bound thinking variants by the offered snapshot and recheck selected variants at acceptance. Only rows already unavailable in the opening snapshot may remain unchanged without that availability check. Cancellation, interruption and late dialog responses cannot start research or publish a stale workflow.

The final shown revision still requires identifiable interactive/RPC user acceptance. Research output, model suggestions and extension-generated messages cannot confirm it. The research execution remains the parent model/thinking captured when the operator opens the command; choosing candidates does not silently change the model conducting research.

## Rationale and consequences

A ladder and an independent cycling whitelist created two overlapping declarations of intent: an explicitly configured Terra rung could silently dispatch Sol because only Sol was in the parent scope. The ladder now expresses delegation intent directly while the parent remains free to use its own scope. Availability is a runtime capability check, not another persisted authorization catalog.

The flat file keeps extension configuration together without embedding it in native settings or introducing private settings APIs. Publication retains locking, exact-byte optimistic replacement, private files and final synchronous checks. Ignore only the configuration filename, never the whole Pi profile.

Legacy paths are not runtime inputs or automatic migration sources. Move confirmed data through an explicit backed-up migration; preserve unrelated native settings and history. Reload running sessions after migration. Process boundaries, native transcript ownership, permission denial and original usage accounting are unchanged.
