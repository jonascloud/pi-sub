# 0004 — Generate model capabilities on demand

Status: Accepted

## Decision

Provide one extension command for initial setup and later refreshes. Ship the assessment instructions and reference-scale rules, not a preselected runtime model catalog. Ordinary delegation requires a successfully generated catalog; without one, explain how to run setup rather than guessing a model or level.

The command starts a dedicated RPC subagent with the current parent model and thinking setting. This explicit setup path does not require the level routing it is creating. Give it a snapshot of the operator-approved models and their supported thinking variants; it must not expand approval.

First gather comparable evidence for every candidate, then assess capability and propose an active subset according to the shared instructions. Keep sourced measurements, capability judgments and selection rationale distinct. Retain sources, acquisition dates and missing-data explanations. Research existing evidence; do not run paid model benchmarks implicitly. Missing evidence excludes a candidate rather than becoming an invented value.

Deterministic code performs derived arithmetic and validates the proposal before activation. Retain the full evaluated candidate set alongside the selected projection. The strength scale, cost metric and relative-cost baseline must not be renormalized to whichever models happen to be approved.

Generate locally and activate a complete validated snapshot atomically. An interrupted or failed refresh preserves the previous valid catalog. Configuration changes affect future admissions, not already running children; admission still checks current approval and availability.

## Rationale and consequences

Installation needs no manually maintained model scores. Setup establishes the first catalog, and the same command updates it when models or the approved selection change. Research is explicit maintenance, not a dependency of each delegation. The generated evidence stays local and remains subject to its source terms. The [versioned evaluation instructions](../../instructions/model-capabilities.md) preserve calibration rules without bundling a routable catalog. Setup uses `/sub:models`; local artifacts are ignored by default. Approval is checked again at worker admission and immediately before the catalog commit.
