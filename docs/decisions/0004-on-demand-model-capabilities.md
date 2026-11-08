# 0004 — A global model ladder

Status: Accepted; authoring workflow superseded by [0006](0006-agent-authored-ladder.md).

## Decision

Keep one short runtime configuration per native Pi profile at `<agent-dir>/pi-sub-config.json`, using public `getAgentDir()` and respecting `PI_CODING_AGENT_DIR`. It maps strength levels 1–10 directly to exact `provider/model:thinking` strings. There is no version header, persisted evidence registry, selected model pool or additional ranking policy. There are no project overrides, local fallbacks or automatic repository imports. An empty object disables delegation; missing or malformed configuration fails explicitly.

Strength is an approximate local capability judgment using shared workload anchors, not a benchmark score, pool-relative rank or equally spaced numerical scale. Compare candidates on the same kinds of work and against the saved ladder; adding a candidate does not silently rescale existing assignments. Leave levels unused rather than inventing distinctions. Evidence and rationale belong in the agent conversation, not runtime configuration.

Dispatch selects the first currently available configured rung at or above the requested minimum. Recheck native availability and sufficient ladder membership before each retained task executes; parent cycling scope is not delegation authority (see [0005](0005-confirmed-ladder-authorizes-delegation.md)). Actual usage remains the original native usage. Configuration contains no prices or reference costs.

## Rationale

A frozen benchmark baseline ages independently of the available models and does not establish task suitability. The agent compares and advises, the user chooses, and execution performs a transparent lookup. A short hand-editable ladder is enough.
