# 0004 — An effective model ladder

Status: Accepted

## Decision

Use `piSub.ladder` in native effective Pi settings. Profile `<agent-dir>/settings.json` supplies defaults; trusted project `.pi/settings.json` overrides or adds individual rungs. The ladder maps strength levels 1–10 to exact `provider/model:thinking` strings. An empty object inherits; `false` and `null` are invalid, and there is no delete or off switch. If the effective ladder has no rungs, report it as unconfigured. Reject malformed ladders rather than guessing a route. pi-sub has no fallback configuration or writer. There is no persisted evidence registry, selected model pool or additional ranking policy.

Strength is an approximate local capability judgment using shared workload anchors, not a benchmark score, pool-relative rank or equally spaced numerical scale. Compare candidates on the same kinds of work and against the saved ladder; adding a candidate does not silently rescale existing assignments. Leave levels unused rather than inventing distinctions. Evidence and rationale belong in the agent conversation, not runtime configuration.

Task creation uses the effective settings snapshot and selects the first natively available configured rung at or above the requested minimum. Manual edits follow Pi's settings reload lifecycle; `/reload` disposes open tasks. Model and thinking remain fixed for the task lifetime, including queueing and continuations; native execution capability can still fail. Parent cycling scope is not delegation authority (see [0005](0005-confirmed-ladder-authorizes-delegation.md)). Actual usage remains the original native usage. Configuration contains no prices or reference costs.

## Rationale

A frozen benchmark baseline ages independently of the available models and does not establish task suitability. The agent compares and advises, the user chooses, and execution performs a transparent lookup. A short hand-editable ladder is enough.
