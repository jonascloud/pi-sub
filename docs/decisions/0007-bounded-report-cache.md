# 0007 — Bounded report cache

Status: Accepted

## Decision

Each completed execution produces an immutable report with its own ID. A parent runtime owns one FIFO cache with a 16 MiB budget for serialized UTF-8 payloads; reading does not refresh eviction order. This budget is not a bound on JavaScript heap, native history, pending input or journals. A single serialized report larger than 16 MiB spills to a private temporary file retained until runtime teardown.

Acceptance or stop removes the task, not its cached reports. First delivery includes the inline result or preview and reference; accepting a previously delivered result returns only the task ID, status and available report ID. Operator stop notifications include final report IDs. There are no idempotent task receipts. Evicted reports fail explicitly with “Report no longer available”; they are not silently recreated. Reports and spill files expire at runtime teardown. Full reports are not retained unbounded in the coordinator or native message details.

A serialized report of at most 2 KiB is inline. Larger reports carry a reference, a response preview of at most 512 bytes and an error preview of at most 240 bytes. The entire model-facing result or batch is at most 8 KiB; an oversized batch is itself cached as a report and delivered as a summary and reference. If inserting the envelope would evict a referenced report, spill the envelope without changing the FIFO. This protects the handoff, not subsequent reads. Delivery of an inline report or reference is independent of reading and task acceptance.

`sub_result` accepts either `{id, wait?, timeout?, finish?}` for task observation and acceptance, or `{report, offset?, limit?}` for report paging, never both. Paging returns plain text and the next offset without starting a child execution. Offsets are zero-based UTF-8 byte boundaries; the limit is in bytes, defaults to 4096 and is between 4 and 4096 inclusive.

Child journals remain volatile native files in a private temporary workspace; the root session uses its direct session files. On session switch, fork/clone, reload or orderly shutdown, owned processes close and final usage is captured before workspace disposal. Reopening a saved conversation does not restore tasks or reports. Delivered inline text remains ordinary conversation history. Hard crashes may leave temporary files.

## Rationale

Bounded handoffs keep model context and report payload retention predictable without discarding access to full reports while cached. Explicit expiration makes the cache a working-data mechanism, not an archive. Spill files avoid rejecting a single report larger than the memory budget; they can grow until teardown.
