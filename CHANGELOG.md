# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The project is in 0.x development and has not published a stable release. Entries
below describe development milestones; the first tagged `0.1.0` release note is
written only when that version is actually released.

## [Unreleased]

### Added

- Installable DSH Host bundle with a single `MemoryService` and `memory` service registration.
- Memory domain: six storage tables, zod record schemas and `contentDigest`.
- `MemoryStore` CRUD, `contentRevision` optimistic concurrency, scope isolation and audit.
- Crash-recoverable `OperationRunner` with the design's operation matrix, request dedupe and `dream.undo` continuation.
- Capacity rules, retention, secret redaction, export/import, `rebuild` and `PURGE <scopeKey>`.
- Minimal audit records for permanent delete, purge and rebuild so deleted content is not retained.
- Plugin-internal tokenizer (Latin words plus CJK unigram/bigram) and a BM25 retrieval index that only covers `active`, non-expired memories in the current workspace or global `preference`.
- Explicit model tools `memory_search`, `memory_read`, `memory_write` and `memory_forget`, registered through `defineTool` on the Host tool registry and disposed with the service.
- `MemoryService` retrieval API (`search` / `read` / `write` / `forget` / `restore`) with workspace identity derived from `ctx.workingDirectory.ensure(agent)`.
- Explicit writes redact secrets in title, body, tags and source-reference quotes before persistence; `scope='global'` is limited to `preference`.
- Search hits increment `matchCount` only; `memory_read` increments `useCount`, keeping statistics separate from content revisions.
- Recall index injection: a new session receives one durable, replayable baseline (global preferences, high-priority workspace lessons, request-relevant BM25 candidates and recent daily work) rendered inside `indexMaxBytes`, with memory text escaped and marked as untrusted background knowledge.
- Optional `refreshIndexOnChange` delta refresh using the persistent `add` / `replace` / `remove` / `reset` source protocol; removes are preserved, an over-budget or accumulated delta becomes a full reset, and non-urgent updates wait in the inbox without waking the agent.
- Index state is rebuilt from the durable session surface across resume, compaction and workspace switches; an incompatible scope, protocol or budget identity produces a reset rather than guessing the old state.
- Episode capture over `session/event` and `tools/result`: whitelisted, redacted turn/tool-failure/tool-recovery/user-correction episodes; `autoCaptureEpisodes=false` disables every automatic write.
- Conditional `worklog(turn)` generation for completed turns with a file change, delivery, correction or explicit completion result; system-derived, active, and not part of the initial resident index (recent turn worklogs may still fill the recent-work slot).
- Dreaming engine: serial queue, fixed or follow-session model selection with reasoning override, one repair retry, strict JSON validation, and all lesson/wiki/worklog(daily) outputs written as `pending` derived records.
- Stable `proposalKey` dedupe plus semantic duplicate linking (update an existing pending proposal, never overwrite active/archived) and body-hash/Jaccard ordinary merge.
- Manual `memory_dream` tool and `/memory` command (`status`, `search`, `dream`, `forget`, `export`), plus per-dream undo that skips user-edited records and stats-only changes.
- Automatic dreaming behind `autoDream=true`: per-workspace debounce and minimum interval on a global serial queue, plus cold-session cursor backfill that advances only after a completed dream.
- Settings → Memory management page with `settings.section` and `settings.section.icon`: list/filter by type and status, paging, detail/edit, accept/reject/edit-before-accept review, a new-memory dialog, `Dream now`, run status with cancel/undo, export/import with workspace mapping and a visible import report, and a config sub-page, with zh/en copy and theme tokens only.
- `memoryUsage` read-only session projection (`stateVersion=1`), surfaced as a small session-memory note in `conversation.chat.assistant-actions` beside the token-usage/time metadata. The memory tools keep DSH's native tool-call rows (like `memory_read`) instead of custom `tool.call.toolview` cards.
- `memory/undoDream` Remote endpoint so the management page can undo one dream run through the same `dream.undo` operation the Host already used.
- DSH compatibility declared through `engines.dsh` (`^0.2.2-rc.5`) with range peers, a `prepack` build hook and a `pack:check` CI step.
- Full-store organization (`memory_organize` and `/memory organize`): reads up to 60 active memories in the current scope, asks the model for merge/replacement proposals that must cite a non-empty `supersedes` list of supplied ids, writes every output as `pending`, and archives every superseded active record when the proposal is accepted.
- Spoken "remember" requests: when the user explicitly asks the agent to remember something and the model did not call `memory_write` in that turn, capture now writes an `active` memory directly (`preference` for stable-preference wording, `lesson` otherwise), reuses an existing active record with the same title, and ignores negated forms such as "不要记住".
- CI on Windows, macOS and Ubuntu with Node 24.x; MIT license and repository documentation.
- Host-agnostic shared memory core (`src/core/`) with abstract storage contracts, canonical configuration validation, pure index folding/refresh protocol, and `MemoryEngine` supporting two-stage Dreaming and Organize (`prepare` / `commit`).
- Antigravity (AGY) native plugin adapter (`src/agy/`): cross-process file-locked JSON persistence (`${PLUGIN_DATA}/memory.json` with atomic writes, corruption-tier backups, and mtime/hash reload), hot-reloaded `config.json`, and 30-day expiring session state cache.
- Authoritative AGY workspace resolver (verified `PreToolUse` host context nonce, MCP `roots/list`, and session anchor with strict global-only degradation) and 20 tiered MCP memory tools (12 regular + 8 sensitive management tools) served over a zero-dependency Stdio JSON-RPC 2.0 MCP server.
- Unified AGY Hook CLI for `PreInvocation` (baseline index injection with fast-skip and optional delta refresh), `Stop` (whitelisted incremental capture from `transcript.jsonl`), and `PreToolUse` (`force_ask` confirmation gate for sensitive tools and cross-workspace/`scope: 'all'`/`outputPath` escalations, fail-closed on errors).
- Self-contained AGY plugin build (`pnpm build:agy` -> `dist/agy-plugin/` with `plugin.json`, `mcp_config.json`, `hooks.json`, bundled `bin/mcp-server.mjs` and `bin/hook.mjs`, rules, and `memory` / `memory-dream` / `memory-review` skills), bundle validator (`pnpm pack:agy:check`), and AGY plugin guide (`docs/agy.md`).

### Changed

- Renamed the project from `dsh-memory` to `memloom` (Memloom) to reflect multi-host support across DSH and Antigravity, while keeping backward compatibility for legacy `dsh-memory` export JSON, session index sources, local-storage keys, and `DSH_MEMORY_*` environment variables.
- Extracted host-agnostic memory logic from `src/host/` into `src/core/` with ESLint import boundaries forbidding `@deepseek-ai/*` in `src/shared/`, `src/core/`, and `src/agy/`, while preserving `src/host/` exports, DSH behavior, and strict DSH `.tgz` bundle isolation in `scripts/pack-check.mjs`.

- Tightened `memory_write` tool description and dreaming system prompt rules to forbid copying or summarizing already auto-loaded docs (`AGENTS.md`, `CLAUDE.md`, `README`, or injected skills lists), keep each memory concise on a single independent topic, and avoid filling the store when given a broad memory request with no new findings.
- Made `memory_search` parameter `query` optional: omitting `query` or passing whitespace lists visible active, unexpired memories ordered by `pinned`, `importance` descending, and `updatedAt` descending without incrementing `matchCount` or `useCount`, and marked `memory_search` and `memory_read` concurrency-safe (`isConcurrencySafe`).
- Added an opt-in `autoAcceptProposals` setting (default `false`) so dream/organize proposals can be applied immediately while keeping `ownership='derived'`, superseding archive order, redaction, and per-run undo; exposed `dreamIdleDelayMs` and `autoDreamMinIntervalMs` in seconds in the Settings UI.
- Reorganized the Settings → Memory UI into a four-tab layout (`Memories`, `Review`, `Import & Export`, `Settings`) with a stable header action bar, clickable overview counts and an index-budget meter; added server-side keyword search (`ListRequest.query`), pill filters, user-tag display, unified centered modals with pinned footers and inline unsaved-change confirmation, line-level proposal diff comparison with sequential review and save-and-accept, drag-and-drop import preview, grouped horizontal settings with minute/KB units, boundary-aware `Select` popovers, and non-zero session memory usage notes.
- Standardized distribution as a GitHub plugin (GitHub repository and GitHub Releases carrying the packed `.tgz` bundle) with no npm package publication (`private: true` retained in `package.json`).
- Retarget the plugin to DSH `0.2.2-rc.5`: the peer range is `^0.2.2-rc.5`, `engines.dsh` declares the same range, and the development dependencies pin that
  release. The suite, typecheck, lint and build pass on it, and a fresh `remove_bundle` → `install_bundle` cycle loads the
  Host service and every Client registration.
- Dreaming prompts now apply evidence grading and recording rules: user-stated content is evidence with an episode citation, unsupported assistant claims are marked unverified or omitted, one memory covers one topic, and only what the environment cannot give back is recorded. Pre-computed health checks (pending episodes, duplicate tool failures, pending proposals, duplicate titles, missing daily worklogs) are included as prompt hints without changing the output JSON.
- The recent-work index now prefers daily worklogs and, when fewer than three exist, fills the remainder with recent turn worklog records (`worklog(turn)`) created in the current workspace within the last 7 days, at most three entries in total, titles and dates only (approved design D1, v2.4).

- The `memory_write` tool description now states when to write: only durable knowledge the environment cannot give back, never task progress or code/config values, and search first then update an existing memory instead of duplicating it.
- Dream related memories are now ranked by BM25 over the claimed batch, falling back to the visible active set only when the batch has no text, and rendered with their ids and importance so `supersedes` can reference real records.
- The Settings page resolves its initial workspace from the last explicit choice (persisted in browser storage), then the most recently active session's workspace (the current project, via a new `memory/activeWorkspace` Remote call), then the registry's most recently updated row; stale choices fall back to the next candidate.
- Active-capacity overflow archives the lowest-importance non-pinned **derived** record first, breaking ties by the oldest `updatedAt`; user-owned and pinned records are never archived automatically, so a full active set refuses the write instead of demoting user data.
- The management page filters by type and status, pages the list, loads pending proposals independently of the visible page, and maps file workspaces to local workspaces before a replace import.
- Remote management failures now use stable `memory/conflict`, `memory/not-found`, `memory/invalid`, `memory/forbidden`, `memory/capacity` and `memory/unavailable` codes with the domain code in `details.code`, so the Client can localize them and detect concurrent edits.
- `rebuild` now replays the scope's recent cold sessions within `rebuildLookbackDays` (or `since`) after resetting derived data, and queues a `rebuild` dream when it captured anything.
- `redactSecrets` now names its exact scope: explicit writes, dreaming and import honour it, while capture and worklog text are always redacted.
- The recent-work index takes at most 5 global preferences and 3 high-priority workspace lessons, matching the implementation.
- Search applies type weights: preferences outrank lessons and wiki entries, and worklogs rank below durable knowledge at equal BM25 relevance.
- Time-based retention also runs every six hours while the service stays loaded, not only at startup.

### Fixed

- Upgraded all six memory model tools (`memory_search`, `memory_read`, `memory_write`, `memory_forget`, `memory_dream`, `memory_organize`) from raw JSON string output schemas to strict DSH structured object schemas (`additionalProperties: false`) with JSON text rendering in `output.render`, preventing `TypeError` when PTC (`run_code`) callers access result properties directly.
- Filtered `memory_*` tool failures/recoveries and `run_code` wrapper errors out of episode capture, added PTC sub-dispatch (`tool/ptc-dispatch`) capture for real business file edits, deliveries, completions, failures and recoveries with whitelisted-key redaction, and skipped `turn` episodes on pure memory-maintenance turns.
- Added `autoAcceptProposals` and `dreamIdleDelayMs` to `EDITABLE_CONFIG_FIELDS` in `MemoryService.updateConfig` so saving Settings changes no longer fails with `memory/invalid`, and removed the inline secondary confirmation when enabling `autoAcceptProposals`.
- Preserved `this` binding when invoking host `locale.subscribe` and `ctx.effect` in the Client bundle, preventing slot crashes against class-backed DSH host services.
- Hid the Archive action and confirmation bar in `MemoryDetail` when inspecting an already archived memory, leaving only Restore.
- A failed permanent-delete operation strips its content snapshots, so an aborted delete cannot retain the body it was removing.
- Pending and archived creates no longer consume an active-capacity slot, and an Accept checks the freed superseded records before archiving anything, so a failed Accept leaves no partial side effects.
- The Host declares the `typert` registry in its inject set, so the Remote descriptor registration has an explicit dependency instead of silently skipping a service that is not ready yet.
- Plugin warnings (dropped captures, failed spoken-memory writes, failed worklogs) go through the Host logger when one is available, and the Client bundle id is read from `package.json`.

- A replace import refuses to run when any file entry is unmapped or when it would delete a scope without writing a replacement, restores rows it already deleted if a later step fails, and reports per-item failures instead of committing over an emptied scope.
- A failed or cancelled dream marks its `dream.run` operation `failed` instead of leaving a permanent `planned` row that a restart would misreport as an interrupted process.
- Audit pruning keeps a 30-day undo window, so a recent dream run stays reversible even above `maxAuditRecords`.
- Imported `supersedes` ids are limited to the record's own scope and an Accept only archives same-scope records, so one imported proposal cannot archive another workspace's memory.
- Imported episodes are stored under an `import:` session namespace with no sequence positions, so a foreign row cannot move the cold-backfill cursor past real events.
- Recovery fails one damaged operation row and continues instead of leaving the whole service unready.
- `restore`, Accept and an explicit status change refuse to exceed the active cap, and purge resets the scope's session cursors so a cleared scope can still be regenerated from session history.
- `archivePurgePolicy='after-export'` purges the just-exported scope (pinned records excluded) instead of never running.
- A retried tool call reuses its `callId` to replay the committed result, and a reused `requestId` must name the same memory.
- The management page no longer sticks on the loading skeleton after a silent refresh, keeps a typed tag comma, ignores stale detail responses, and confirms a close with unsaved edits.
- `rebuild()`, `purgeAll()` and `remoteImport()` now always rebuild the in-memory `SearchIndex` after completing (including rollback), so deleted records never stay searchable.
- `replace` import now runs preflight, deletion, creation and rollback atomically inside a single serialized store batch; on failure it removes partially inserted rows and restores original snapshots directly (preserving `contentRevision`, timestamps and stats without triggering capacity eviction).
- Retrying `create` with a `requestId` whose operation was scrubbed by permanent delete now fails with `MEMORY_CONFLICT` instead of creating a ghost record, and permanent delete with `requestId` is now idempotent while rejecting mismatched target ids.
- Scope matching in `findActiveByTitle`, `findSemanticProposal` and `findSimilarProposal` now compares workspaces by key (`sameScope`) rather than raw `JSON.stringify(scope)`, preventing duplicate records when workspace roots differ.
- `remoteImport` now honours `redactSecrets` consistently with explicit writes and dreaming; `merge` import deduplicates on post-redaction digests; imported episodes redact `failureMessage`, `outcome`, `lastError` and `files` and reset `processing` status to `new`.
- `validateCreateBatch` now checks post-batch totals without off-by-one rejection and only checks `maxArchivedMemories` when archived records are added; `store.update` enforces field length/count bounds; malformed `ZodError` and non-object RPC payloads map cleanly to `memory/invalid`.
- `acceptProposal` deduplicates `supersedes` before checking active capacity; `contentDigest` covers `type`, `confidence` and `sourceRefs`; `pruneAudit` also prunes old `undone` audit rows outside the 30-day undo window.
- `memory_dream` and `enqueueDream` validate `maxEpisodes >= 1` and ISO `since` timestamps; `MemoryService` cleans up all resources on startup failure and immediately closes external entry points on shutdown.
- `MemoryService.write()` rejects modifying `archived`/`pending` records and serializes `requestId` replay + title dedupe atomically; mid-turn compaction (`step > 1`) recovers the memory index even when `refreshIndexOnChange=false`; `memoryUsage` deduplicates `totalInjected` across turns and clears `writeCalls` on error; `/memory status` and `/memory search` catch service errors; index rendering escapes `</system-reminder >` whitespace variants and collapses multiline titles.
- Dreaming and organize strictly enforce global preference scope isolation, never expose global preferences to workspace `organize`, prevent cancelled dreams from being resurrected by `startDream`, fail `DreamRun` on pre-execution throws, trigger 1-shot repair retry on malformed organize JSON, include `supersedes` in `proposalKey` and `update-pending`, pause cold backfill while auto-dream is paused, and advance cursors on 0-episode scans.
- Capture now wires `explicitCompletion` for worklog eligibility, suppresses spoken "remember" after `memory_write` during cold replay, expands negated remember phrases, and skips tool results without a workspace `cwd`; worklog redacts before title splitting, places list truncation on its own line, and emits the first episode-overflow warning on low synthetic clocks.
- Settings UI fixes: numeric inputs allow typing freely before blur/commit, silent refresh never leaves the list stuck loading, `Escape` inside `Select` no longer closes parent `Modal`, `Modal` focus trap skips disabled/hidden elements and captures outside focus, `TransferPanel` guards async file reads and resets stale replace confirmations, create dialog prompts on unsaved drafts, review modal fetches and displays superseded memories for old-vs-new comparison, disabling `redactSecrets` requires explicit in-UI confirmation, client `$mount` disposer and live `locale.subscribe` updates are wired properly, workspace fallback re-resolves once workspaces load, Refresh retries failed config/catalog loads, `MemoryDetail` keeps drafts when conflict reload fails, `rpc()` and `Select` clear timers cleanly, and ESLint covers `.tsx` files.
- Concurrent-edit conflicts are detected from the `memory/conflict` Remote failure, keep the draft, and offer a reload action instead of a generic save failure.
- Client locale and slot registrations are fiber-owned, so a hot replacement or same-page re-enable no longer fails on a duplicate namespace.
- The dead `memory/changed` subscription was removed: DSH does not forward that event to the Client, and the page refreshes on a visible-page interval instead.
- The memory page uses theme tokens for the modal backdrop and shadow, restores focus rings, traps focus in dialogs, and keeps the file picker keyboard reachable.
- Row dates are rendered in the local timezone, long tags ellipsize, and the usage note is labelled as session totals rather than "this turn".

- Memory activity no longer renders as a bespoke card: the memory tools use DSH's native tool-call rows (matching `memory_read`, no custom `tool.call.toolview` views), and the usage summary is a small note in the assistant action row after the token-usage and time metadata.
- Queued dreams persisted before a process restart are resumed with their original dream id instead of remaining queued forever; interrupted running dreams are finalized as failed with their claimed episodes returned to the retryable pool, and startup reconciles recent cold sessions when `autoDream=true` without blocking plugin readiness.
- Worklog titles now prefer the first meaningful sentence of the assistant conclusion over the user prompt, reject bare questions and clearly low-information fragments, and are capped at 80 characters; titles may still be short and need human review. Worklog bodies use a conclusion-first 4096-byte budget that never lets a long request squeeze out `## Result`, bounds request, file and tool-failure sections, and marks every truncated section.
- Explicit `memory_write` calls restore literal `\n` sequences to real newlines only when the text has no real newline, contains at least 3 literal `\n` sequences and at least two `## ` headings, and contains no drive-letter path, code fence or other backslash context; otherwise the text is kept byte-for-byte unchanged.
- Explicit `memory_write` calls refuse private keys, common API keys and tokens that match strong secret shapes, with a fixed message that points to the credential configuration instead of echoing the secret; capture, dream and import paths keep their existing redaction behavior.
- Dream failures are classified as fatal, transient or other: fatal authentication/quota errors pause automatic dreaming immediately, transient rate-limit/timeout/network errors back off for 60 seconds then 180 seconds and pause after three consecutive failures, and other failures skip an episode after three attempts. Pause and backoff are process-local and reset on restart; manual dreams remain available and a successful manual dream clears the pause.
- Replace import now validates every planned record against the store's business rules, identity conflicts and projected capacity before deleting the target scope; a schema-valid but business-invalid document can no longer erase existing memories.
- Permanent delete scrubs its own operation snapshot through a durable `scrub` step, so a crash between the memory delete and operation commit is completed safely on recovery; audit cleanup now follows `before`/`after` snapshots as well as the primary `memoryId`.
- Dreaming output title, body and tags are redacted before persistence and audit, and captured file paths are redacted before entering episodes, worklogs or dream prompts.
- Dreaming cancellation is a commit barrier: a late model answer cannot overwrite a cancelled run as completed, and aborted/claimed episodes are released instead of remaining `processing`.
- Dream undo walks each memory's audit chain in reverse, so a create followed by an in-dream update is fully rolled back.
- `memory_write` now records the calling session as a source reference when it creates a memory; updates keep the record's existing sources instead of replacing them.
- A subagent turn keeps its episode but no longer creates a `worklog(turn)`.
- A failed turn stores the redacted, length-bounded `failureCode` and `failureMessage` from the structured error.
- Explicit `memory_write` with an existing scope, type and normalized title returns the existing record with `duplicate: true` instead of creating a twin; callers that need to change it must pass the id and revision.
- Reaching `maxQueuedEpisodes` now logs a rate-limited warning when a capture is dropped instead of silently discarding it.
- Memory details and pending proposals now open in a focused modal (backdrop click or Escape closes it) instead of a cramped side pane; the list spans the page and proposal cards clamp their preview to two lines.
- Accepting a pending proposal archives every active record named in its `supersedes` list, not only the first.
- Transient storage write failures leave an operation `applying` and recoverable instead of permanently marking already-applied business changes `failed`.
- `autoDream` now wires cold-session backfill into turn start and supplies a real workspace-idle check; scheduler shutdown cancels every dream it enqueued, not only the last one.
- `memory_read` no longer returns archived or expired memories through the model-facing tool; management reads remain available.
- Capture snapshots the turn before queued episode writes, so correction/tool-failure/tool-recovery episodes no longer record turn 0 after a turn reset.
- Import dedupe computes content digests with the mapped local scope, so the same content imported across machines is still recognised after workspace mapping.
- `pinned` memories are excluded from automatic turn-worklog archiving and from `age` / `after-export` archive purging.
- `memory_write` can no longer change an existing memory's scope; widening a workspace memory to global requires an explicit user management action.
- Secret redaction also covers JSON credential pairs (`"password":"..."`), env-prefixed names (`DATABASE_PASSWORD`, `OPENAI_API_KEY`) and quoted values that contain spaces.
- Creating a second record with an existing id but different content now fails with `MEMORY_CONFLICT` instead of reporting success while keeping the old body.
- `memory_search` with `scope='workspace'` no longer returns global records, and snippet windows also consider the final legal window at the end of a body.
- Index injection now recovers from an orphaned delta by folding a later reset, composes the current index for a missing-baseline reset, and persists refresh byte/time accounting in the source so resume keeps the same budget and interval.
- Workspace switches invalidate the previous index even when `refreshIndexOnChange` is disabled; non-urgent refreshes wait for a later pre-step instead of entering a waking inbox or forcing another model step.
- Index refresh anchors BM25 candidates to the first human request across tool continuations, skips an emptied first decision, and never emits a baseline for a request another listener consumed.
- Index rendering escapes `memoryId` in baseline, reset and delta output, and daily worklogs expose only their title and date rather than their body summary.

[Unreleased]: https://github.com/JiaMingWang-CN/memloom/commits/main
