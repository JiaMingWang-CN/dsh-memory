<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-horizontal-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/logo-horizontal-light.svg">
  <img alt="memloom" src="assets/logo-horizontal-light.svg" width="320">
</picture>

### The next session should not start from zero.

**Local-first long-term experience memory for coding agents (Antigravity & DSH): shared memory core, native plugins, and standalone desktop app — formerly `dsh-memory`.**

Remember the projects you worked on, the pitfalls you hit, the rules you settled on, and your preferences.<br>
Recall them when needed; stay quiet when not.

[Overview](#overview) · [Use cases](#use-cases) · [How it works](#how-it-works) · [Management](#management) · [Privacy and security](#privacy-and-security) · [Install](#install) · [Configuration](#configuration) · [Architecture](#architecture) · [FAQ](#faq) · [Release notes](#release-notes)

[![Status](https://img.shields.io/badge/status-0.2.3--dev-blue)](#development-progress)
[![Distribution](https://img.shields.io/badge/distribution-GitHub%20Releases-black)](#install)
![License](https://img.shields.io/badge/license-MIT-green)
[![Local first](https://img.shields.io/badge/data-local--first-brightgreen)](#privacy-and-security)

</div>

> [!NOTE]
> **Currently at `0.2.3` development (0.x), distributed exclusively via GitHub Releases (Antigravity native plugin, DSH bundle, and Memloom Desktop app) — not published to npm.**
>
> This document tracks the implemented capabilities in this repository. Before a stable release, interfaces, configuration and behavior may still change. See [`docs/release-checklist.md`](docs/release-checklist.md) for the release checklist.

---

<p align="center">
  <strong>Sponsor · Thank you for supporting memloom open-source development</strong>
  <br>
  <a href="https://api.lwxiaoye.top/">
    <img src="assets/sponsor-k.png" alt="XiaoyeyeyeyeyeAPI sponsor logo" width="120">
  </a>
  <br>
  <a href="https://api.lwxiaoye.top/">XiaoyeyeyeyeyeAPI · Visit sponsor website</a>
</p>

## Overview

Every new session can start from zero: re-learning the project, re-asking conventions, and sometimes repeating a mistake that was already corrected. Experience is also easily fragmented across different coding-agent tools.

**memloom (formerly `dsh-memory`) wants experience to carry across sessions and hosts.**

It is not another full chat transcript and it does not stuff all history into context. It is a multi-host experience-memory system built on a host-agnostic shared core (`src/core/`), supporting **Antigravity (AGY)**, **DSH (DeepSeek Harness)**, and **Memloom Desktop** on equal footing:

- **Remember corrections**: a pitfall becomes a reusable lesson.
- **Remember work**: know what was done, where it stopped, and what it produced.
- **Remember projects**: turn scattered architecture conventions, commands and decisions into project knowledge.
- **Remember you**: keep a small set of genuinely long-lived cross-project preferences.
- **Leave control to you**: search across hosts, inspect sources, review proposals, migrate between AGY and DSH, edit, forget, or permanently delete.

<div align="center">

**Capture experience → organize knowledge → human review → recall on demand**

</div>

## Use cases

### Stop repeating the same mistake

Last week you corrected this in a project:

> Run typecheck before building; don't wait for the bundle to fail on a type error.

In a new session, when you work on build-related tasks again, memloom aims to bring that relevant lesson back into context. You should not have to explain it again, and the agent should not have to learn it through another failure.

### Continue where the last session stopped

> Where did we leave this module?

Through worklogs, project knowledge and source sessions, memloom will help the agent find the previous work summary and key results instead of reading the whole history.

### Let project knowledge settle

Conventions, common commands, key decisions and known pitfalls that recur across sessions can be consolidated by Dreaming into maintainable project wiki entries. Every piece of knowledge has a source, can be replaced when stale, and can be corrected when wrong.

### Make preferences work across projects and hosts

Long-lived preferences such as "reply in Chinese" or "never auto-commit" can be explicitly written as global memories; project-specific technical rules stay in their own workspaces and do not pollute each other, and can be moved losslessly between AGY and DSH via **Memloom Desktop**.

## Four kinds of memory

| Type | What it remembers | Default scope |
| --- | --- | --- |
| **Lesson** | Trigger conditions, failure causes, user corrections and reusable rules | Current workspace |
| **Worklog** | Summaries and daily rollups of work with actual output | Current workspace |
| **Wiki** | Architecture, conventions, commands, key decisions and linked knowledge | Current workspace |
| **Preference** | Communication habits, working style and long-term goals | Global, optionally workspace-bound |

Not every turn deserves to become a memory. Small talk, repeated retrieval and turns with no output do not all become worklogs; raw turn summaries do not enter the new-session index by default, and only fill the recent-work fallback from the last 7 days when fewer than 3 daily worklogs exist, by title and date only.

## How it works

### 1. Capture at the right moment, not the whole conversation

memloom listens across hosts for signals worth preserving:

- the user explicitly corrects a mistake;
- a tool fails and a working approach is found for the same target;
- a turn produces file changes, deliverables or an explicit result;
- the user says "remember this" or "always do it this way";
- a session fails and leaves a fragment worth organizing later.

Automatic capture first creates a lightweight **Episode**, not long-term knowledge. Capture uses a field allowlist and redacts before persistence; full tool arguments, full tool outputs, attachments, images and reasoning are out of scope.

A qualifying turn (file change, delivery, user correction or explicit completion result) produces a deterministic `worklog(turn)` without calling a model. The title prefers the first meaningful sentence in the assistant conclusion, then the first line of the user request; bare questions and clearly low-information fragments do not become titles, and the title is capped at 80 characters. Titles may still be short and need human review. The body allocates 4096 bytes with the conclusion first: `## Result` keeps up to 2048 bytes and is never squeezed out by a long request, `## Request` is capped at 1024 bytes, and only the remaining space goes to file lists and tool failures; every truncated section ends with `…[truncated]`.

### 2. Dreaming: turn fragments into experience

Dreaming is an offline memory-organization process: it reads redacted Episodes, combines them with existing memories, distills Lessons, Worklogs and Wikis, and handles duplicates and stale content (AGY runs via two-stage `prepare`/`commit` tools paired with built-in Skills; DSH runs via a background queue using the configured or session model).

The default strategy is **human-first**:

- automatic capture on;
- automatic Dreaming off by default, with manual runs available;
- all Dreaming-generated knowledge and logs start as `pending`;
- only acceptance, or acceptance after editing, moves them to searchable `active`;
- explicit `memory_write` content takes effect directly;
- in DSH, Dreaming can follow the current session model or use a chosen model and reasoning effort; in AGY, no external LLM API key is required, and `dreamSubagentModel` (default `flash`) selects the subagent model tier while native `autoDream` hooks prompt background subagent consolidation.

High confidence is not truth. The model does not bypass review because it feels certain.

Implemented reliability behavior for Dreaming:

- **Startup recovery and cold-session reconciliation**: after a process restart, persisted `queued` dreams resume with their original dream id; a dream interrupted while running is marked failed, its claimed episodes return to the retryable queue, and duplicate proposals are not generated. When `autoDream` is enabled, startup also reconciles cold sessions from the last 7 days to capture missed session events; with `autoDream=false` it neither reads cold sessions nor calls a model for this purpose.
- **Failure classification, backoff and pause**: authentication and quota errors pause automatic dreaming immediately; rate-limit, timeout and network errors back off for 60 seconds, then 180 seconds, and pause after three consecutive failures. Pause and backoff are process-local and reset on restart; manual dreams are never blocked, and a successful manual dream clears the pause.
- **Health checks and evidence grading**: before organizing, pending episodes, duplicate tool failures, pending proposals, duplicate titles and missing daily worklogs are computed locally and supplied to the model as hints. The model uses only facts supported by the episodes: content the user stated counts as evidence and cites the episode id; assistant claims without tool or user support are marked unverified or omitted; one memory covers one topic, and only what the environment cannot give back is recorded (lessons, approaches that worked, verified rules, pitfalls and plans in progress) — not code, file contents, current configuration values, git history or command output.

### 3. A new session carries only a small, relevant slice of experience

More memory is not better; the right memory at the right time is.

The first-request index of a new session is composed of:

| Content | Target count |
| --- | ---: |
| Global preferences (`preference`) | At most 5 |
| Pinned or high-importance workspace rules | At most 3 |
| Lessons, Wikis and Preferences relevant to the current request | At most 5 |
| Recent daily worklog titles and dates; when fewer than 3 exist, worklog titles from the last 7 days fill the gap | At most 3 |

The default index budget is **4096 bytes**. Retrieval uses local BM25, scope filtering and importance weighting; no external vector database is required.

Recent work prefers daily rollups; when there are fewer than 3, active `worklog(turn)` records created in the current workspace within the last 7 days fill the gap, at most 3 in total, with titles and dates only and no body summaries. Archived, expired or other-workspace records never enter the index.

When details are needed, the agent drills down through search and read: **index first, then search summaries, then the full body and sources.**

### 4. Memories can also be corrected and forgotten

In the optional in-session refresh mode, adds, edits, archives and expirations are synchronized through deltas or a new baseline; historical messages are never rewritten, and invalidated memories are clearly marked as no longer dependable.

Refresh is merged only before a later real model request and never wakes the agent just because memory changed. After restart, resume or compaction, index state is rebuilt from durable session state rather than a volatile in-memory cache.

## Management

`0.2.3` provides three complementary management surfaces covering cross-host desktop orchestration, in-host UI, and conversational workflows:

### 1. Memloom Desktop (standalone cross-host workbench)

A dedicated Electron application for **Antigravity (AGY)** and **DSH** on equal footing (featuring the `--ml-*` floating-island paper-and-ink design system, zero native form controls, light/dark/system themes, and zh/en locales; see [`docs/desktop.md`](docs/desktop.md)):

- **Memories**: federated BM25 search across all enabled hosts plus single-host master-detail CRUD, draft-protected editor modals with `desktop/external-change` conflict recovery, Markdown inspection, and floating batch bars;
- **Review Inbox**: aggregates `pending` proposals across hosts with `supersedes` version comparison and `A` / `E` / `R` shortcuts;
- **Cross-host Migration**: Loom Weft Bridge connecting AGY ⇄ DSH for single/multi-select `merge` or a 3-step `replace` wizard with workspace mapping and non-skippable confirmation gates;
- **Dreams & Audit**: inspect `DreamRun` history with per-run undo and the immutable `AuditRecord` diff timeline;
- **Host Config, Plugin Lifecycle & WriteGuard**: edit all 24 AGY configuration fields (including `dreamSubagentModel`) with backup/rebuild/purge confirmation modals; one-click install, sync, and uninstall AGY and DSH (multi-profile) plugins without touching `memory.json` (enforcing fail-closed DSH not-running checks); check GitHub Releases in-app with mandatory `SHA256SUMS.txt` verification and automatic post-restart plugin sync; manage DSH runtime concurrency read-only protection (`WriteGuard`) with SHA-256 pre-write checks and 20 rotated backups; and jump anywhere via `Ctrl/⌘K`.

### 2. DSH Settings → Memory (built-in 4-tab management page)

Inside DSH, provides a **unified header + four focused tabs** (`Memories`, `Review`, `Import & Export`, `Settings`):

- **Header overview & actions**: switch workspaces, jump via active/pending/archived counts, inspect the workspace index-budget meter, and access fixed `New memory`, `Dream now` and `Refresh` actions;
- **Memories, review & import/export**: server-side keyword search, segmented filter pills, centered create/detail/edit modals, line-level diff / side-by-side proposal review with `Save & accept` and dream undo, drag-and-drop import preview with workspace mapping, and grouped horizontal settings (permanent deletion, full purge and full rebuild stay behind confirmed Host APIs);
- **In-conversation indicator**: memory tools use DSH's native tool-call rows, and a small note beside token usage shows non-zero cumulative counts of memories injected, written and searched in the current session.

### 3. Antigravity (AGY) built-in Skills & MCP management tools

- **Conversational workflows**: ships bundled `memory`, `memory-dream`, and `memory-review` Skills to search, run two-stage Dream/Organize consolidation, and review pending proposals interactively;
- **Confirmation gate**: sensitive tools (`scope: 'all'`, cross-workspace writes, export/import, undoDream, rebuild/purge) are gated by `PreToolUse` `force_ask` host confirmation (see [`docs/agy.md`](docs/agy.md)).

## Privacy and security

**Memory should belong to you, not become an invisible black box.**

- **Local first**: memory data stays completely local on disk (AGY defaults to `${PLUGIN_DATA}/memory.json`, DSH defaults to `$DSH_HOME/storages/memory.json`); there is no cloud account and no default cross-device sync. If an external model service performs Dreaming, the content sent depends on that model service.
- **Redact before saving**: common secrets, tokens, passwords and inline `.env` values are redacted before persistence. An explicit `memory_write` containing a private key, common cloud API key, GitHub/Slack token or another strong secret shape is refused with a hint pointing to credential configuration; capture, dream and import paths still replace and save under redaction rules. `redactSecrets=false` only disables redaction for explicit writes, dreams and imports; capture and worklog text are always redacted.
- **Workspace isolation**: project memories are filtered by normalized workspace identity (including AGY `PreToolUse` host nonce verification, MCP `roots/list`, and strict global-only degradation), and the global layer allows user preferences only. Replacement import requires a mapping for every workspace in the file.
- **Untrusted content**: memory bodies and source references are background knowledge, never system instructions; persistence and injection also include safety escaping.
- **No full conversation copies**: host session logs (DSH session logs and AGY `transcript.jsonl`) remain the source of session facts; memory stores keep only distilled knowledge and necessary references.
- **Bounded capacity**: hard limits reject new records with an alert instead of silently dropping data. When `active` records overflow, only unreviewed derived records are archived automatically; user-owned and pinned records are protected.
- **User ownership**: memories created, edited, imported, accepted or restored by the user are protected from derived-cache rebuild cleanup.
- **Dangerous operations need confirmation**: permanent deletion, full purge, full rebuild, replacement import, scope expansion or disabling safety protections require explicit confirmation across Memloom Desktop modals, AGY `force_ask` gates, or confirmed Host APIs.

## Traceable, recoverable, undoable

Long-term memory must remain trustworthy under failure, not just writable.

memloom stores structured records, Markdown bodies and a local retrieval index, coordinating multi-step writes through an operation log:

- every business change keeps structured before/after snapshots and the actor;
- business revision numbers (`contentRevision`) prevent overwriting later user edits;
- interrupted operations recover according to their persisted state after a process crash;
- accepting a replacement proposal never leaves old and new versions active simultaneously;
- Dreaming runs can be undone; entries edited by the user afterwards are skipped and reported;
- search hits and full reads are counted separately, avoiding a "popular memories get recalled more" self-reinforcement loop.

**Rebuild is not backup recovery.** It only rebuilds derived data that may be deleted; user-owned memories must be protected, migrated and backed up independently.

## Tools and commands

### Core model tools (shared across AGY & DSH)

| Tool | Intended use |
| --- | --- |
| `memory_search` | Search summaries by keyword, type and scope (omit `query` to list top active summaries) |
| `memory_read` | Read the full body and sources of a recallable memory, recording actual use |
| `memory_write` | Explicitly create or update a memory; takes effect directly, with "when to write / not write" rules |
| `memory_forget` | Soft forget; models cannot delete permanently |
| `memory_dream` | Manually start a dream run (DSH) or inspect pending dream queue |
| `memory_organize` | Manually consolidate existing active memories into merge/replacement proposals |

### Host-specific surfaces

- **Antigravity (AGY)**: zero-dependency Stdio MCP server exposing **12 regular tools + 8 sensitive management tools** (including `memory_dream_prepare` / `memory_dream_commit`, `memory_organize_prepare` / `memory_organize_commit`, review, and undo), paired with `PreInvocation`, `Stop`, and `PreToolUse` Hooks plus `memory`, `memory-dream`, and `memory-review` Skills (see [`docs/agy.md`](docs/agy.md)).
- **DSH**: `/memory status`, `/memory search`, `/memory dream`, `/memory organize`, `/memory forget`, and `/memory export` commands (`export` returns a summary; full JSON export lives in Settings → Memory or Memloom Desktop).

## Defaults

| Setting | Target default | Meaning |
| --- | --- | --- |
| `autoCaptureEpisodes` | `true` | Capture key fragments, but ordinary fragments do not directly become long-term knowledge |
| `autoDream` | `false` | Do not call a model automatically; the user triggers organization manually |
| `refreshIndexOnChange` | `false` | Inject the index only on the first request of a new session by default |
| `redactSecrets` | `true` | Redact secrets before persistence |
| `indexMaxBytes` | `4096` | Bound the size of the first memory index |
| `injectForSubagents` | `false` | Do not repeat fixed context for every subtask by default |

The long-term direction is to add shadow runs, limited autonomy and ordinary unattended operation only after real evaluations meet entry criteria; human takeover, audit, undo and forgetting will not be removed.

## Install

> memloom is **distributed exclusively via this GitHub repository and GitHub Releases (not published to npm)**. `0.2.3` remains a 0.x development release.

**Common requirement**: Node.js `>=24.9.0` (`pnpm` is only needed when building from source). Download prebuilt artifacts from [GitHub Releases v0.2.3](https://github.com/JiaMingWang-CN/memloom/releases/tag/v0.2.3) or build each target independently:

### Option A: Antigravity (AGY) native plugin

- **From Release (recommended)**: download [`memloom-agy-plugin-0.2.3.zip`](https://github.com/JiaMingWang-CN/memloom/releases/download/v0.2.3/memloom-agy-plugin-0.2.3.zip), extract to `~/.gemini/config/plugins/memloom`, and reference it in `plugins.json` (zero runtime `node_modules` dependencies; requires only local Node.js).
- **From source**:
  ```bash
  git clone https://github.com/JiaMingWang-CN/memloom.git
  cd memloom && pnpm install
  pnpm build:agy && pnpm pack:agy:check   # builds & validates dist/agy-plugin/
  ```

### Option B: DSH (DeepSeek Harness) bundle

Requires locally installed DSH `0.2.2-rc.5` (`engines.dsh` declares `^0.2.2-rc.5`):

- **From Release (recommended)**:
  ```bash
  dsh plugin --profile desktop add https://github.com/JiaMingWang-CN/memloom/releases/download/v0.2.3/memloom-0.2.3.tgz
  ```
  You can also download `memloom-0.2.3.tgz` and install it from the DSH Plugins page, then restart DSH.
- **From source**:
  ```bash
  pnpm build          # produces dist/host and dist/client.js
  dsh plugin --profile desktop add link:./
  # or run `pnpm pack` to produce memloom-0.2.3.tgz
  ```
  See [`examples/cordis.patch.yml`](examples/cordis.patch.yml) for a minimal patch config, and `dsh plugin --profile desktop remove memloom` to uninstall.

### Option C: Memloom Desktop (standalone app)

- **Windows `win-x64` installer**: download and run [`memloom-desktop-0.2.3-win-x64-setup.exe`](https://github.com/JiaMingWang-CN/memloom/releases/download/v0.2.3/memloom-desktop-0.2.3-win-x64-setup.exe) to discover and manage both local AGY and DSH stores side by side.
- **Local browser-app mode / build from source**:
  ```bash
  pnpm run start:desktop   # launches via signed local Node.js + Edge app window (shares desktop-state.json)
  # or build Electron payload, bundled plugins, and Windows NSIS installer:
  pnpm run build:desktop && pnpm run build:desktop:plugins && node scripts/pack-desktop-check.mjs --require-bundled
  pnpm --dir desktop install && pnpm --dir desktop run pack:win
  ```

See [`docs/agy.md`](docs/agy.md) and [`docs/desktop.md`](docs/desktop.md) for full details.

## Quick start

1. **Write a memory**: in a new AGY or DSH session, ask the agent to remember something (it calls `memory_write`), or create one in **Memloom Desktop** / Settings → Memory. Explicit writes take effect directly.
2. **Recall in a new session**: memloom injects a small memory index before the first request of a new session; the agent can also call `memory_search` for summaries and `memory_read` for the full body and sources.
3. **Organize and review**: use the `memory-dream` / `memory-review` Skills in AGY, `/memory dream` or `Dream now` in DSH, or the cross-host **Review Inbox** in **Memloom Desktop**; generated records start `pending` and become searchable only after acceptance or edit-before-accept.
4. **Forget & migrate**: use `memory_forget` to soft-forget (restorable later), or transfer memories between AGY and DSH via **Memloom Desktop**.

A typical loop:

```text
> Run typecheck before building, so type errors don't surface at bundle time.
(the agent calls memory_write to store a lesson)

(new session) > We're about to bundle and release. What first?
(the index brings back "run typecheck before building")
```

## Configuration

Canonical defaults live in [`src/core/config.ts`](src/core/config.ts); see [`docs/configuration.md`](docs/configuration.md) for every field. Key `0.2.3` defaults:

| Setting | Default | Meaning |
| --- | --- | --- |
| `autoDream` | `false` | No automatic model organization by default; the user triggers it manually. |
| `refreshIndexOnChange` | `false` | Inject the index only on the first request of a new session by default. |
| `autoCaptureEpisodes` | `true` | Capture key fragments automatically, but ordinary fragments do not become searchable knowledge directly. |
| `indexMaxBytes` | `4096` | Byte budget for the first memory index. |
| `redactSecrets` | `true` | Redact secrets before persistence. |
| `injectForSubagents` | `false` | Do not repeat fixed context for every subtask by default. |

In AGY, edit `${PLUGIN_DATA}/config.json` or use the **Host Config** workbench in **Memloom Desktop**; in DSH, override via your profile patch YAML:

```yaml
- insert:
    - id: memloom
      name: memloom
      config:
        autoDream: false
        autoCaptureEpisodes: true
        refreshIndexOnChange: false
```

## Architecture

memloom uses a multi-host layered architecture in one repository, sharing a host-agnostic core (`src/core/` + `src/shared/`) across the AGY native plugin, the DSH bundle, and Memloom Desktop:

- **Shared core (`src/core/` + `src/shared/`)**: owns the six-table schema (memories, episodes, dreams, audit, operation log, session cursors), BM25 search, operation-log crash recovery, capacity and redaction policies, export/import, and two-stage Dream/Organize execution.
- **AGY native plugin (`src/agy/`)**: pairs the shared core with cross-process `.memory.lock` JSON persistence (`${PLUGIN_DATA}/memory.json`), 20 tiered MCP tools, `PreInvocation` / `Stop` / `PreToolUse` Hooks, and bundled Skills in a self-contained `dist/agy-plugin/`.
- **DSH plugin (`src/host/` + `src/client/`)**: registers the `memory` service via a single `MemoryService` (`storageDomain`, default `$DSH_HOME/storages/memory.json`), six model tools, `/memory` commands, and the Settings → Memory UI (`ctx.remote.memory.*`).
- **Memloom Desktop (`src/desktop/` + `desktop/`)**: features an independent `--ml-*` floating-island UI with official DSH/AGY host icons, lossless dual-envelope serialization (`dsh-unit` & `agy-flat`), DSH runtime `WriteGuard` concurrency protection, automatic pre-write backups, federated search, and cross-host migration.
- **Consistency & compatibility**: multi-table mutations coordinate via the `operations` state machine and `contentRevision` optimistic concurrency; legacy `dsh-memory` export JSON remains importable.

See [`docs/architecture.md`](docs/architecture.md), [`docs/agy.md`](docs/agy.md), [`docs/desktop.md`](docs/desktop.md), [`docs/memory-model.md`](docs/memory-model.md), [`docs/dreaming.md`](docs/dreaming.md) and [`docs/security.md`](docs/security.md).

## Explicit non-goals

In `0.x`, memloom does not aim at:

- external embedding services or vector databases;
- cloud accounts and cross-device sync;
- team multi-user permission systems;
- replacing host (AGY / DSH) historical session-text search;
- changing host session formats or adding private session event types;
- model-weight training or fine-tuning;
- enabling automatic knowledge activation without human review by default.

## Development progress

The repository is at **`0.2.3` development (0.x)**. Implemented and test-covered capabilities include:

- host-agnostic shared memory core (`src/core/`): domain storage, CRUD, scope isolation, version control, operation log, audit, capacity control, import/export and crash recovery;
- local BM25 retrieval, new-session index injection (baseline and optional delta refresh), whitelisted Episode capture, conditional `worklog(turn)`, spoken "remember" direct writes, and Dreaming / Organize consolidation;
- dream queue startup recovery and cold-session startup reconciliation, failure classification/backoff/process-local pause, health checks, evidence grading, worklog budgets, strong-secret refusal, and per-run undo;
- **Antigravity (AGY) native plugin**: cross-process file-locked JSON persistence, 20 tiered MCP tools, `PreInvocation`/`Stop`/`PreToolUse` Hooks, two-stage organization Skills, and `pnpm build:agy` / `pnpm pack:agy:check` bundle verification ([`docs/agy.md`](docs/agy.md));
- **DSH bundle plugin**: six structured-output tools, `/memory` commands, 4-tab Settings → Memory management page, session-memory usage note, and `engines.dsh` compatibility range;
- **Memloom Desktop (`0.2.3` full UI redesign)**: `--ml-*` floating-island workbench with zero native controls, official DSH & AGY vector logos, five core workflows (`Memories`, `Review`, `Migrate`, `Dreams & Audit`, `Host Config`), DSH `WriteGuard`, 20 rotated backups, and Windows `win-x64` NSIS installer packaging ([`docs/desktop.md`](docs/desktop.md)).

The default policy keeps `autoDream=false`, `refreshIndexOnChange=false` and `autoCaptureEpisodes=true`; see [Install](#install) and [Quick start](#quick-start) above.

## Release notes

- **Distribution channel**: memloom is distributed exclusively via [GitHub Releases](https://github.com/JiaMingWang-CN/memloom/releases) with **`memloom-<version>.tgz`** (DSH bundle), **`memloom-agy-plugin-<version>.zip`** (Antigravity plugin), and **`memloom-desktop-<version>-win-x64-setup.exe`** (Windows desktop installer) plus repository source — **no npm package publication**.
- **Changelog & checklist**: see [`CHANGELOG.md`](CHANGELOG.md) for detailed changes and [`docs/release-checklist.md`](docs/release-checklist.md) for verification records.

## FAQ

**Can I rely on memloom for long-term daily use now?**
The repository is at `0.2.3` development (0.x) and has not reached a stable release. Features work and are covered by automated tests, but interfaces, configuration and behavior may still change.

**Will it organize my memories automatically?**
Not by default. `autoDream=false`, so you trigger organization manually (via the `memory-dream` Skill in AGY, or `/memory dream` / `Dream now` in DSH); even when automatic organization is enabled, outputs enter `pending` review first.

**Does "remember this" write immediately?**
Yes. When the model did not call `memory_write` in that turn, an explicit "remember" or "from now on" request writes an `active` memory directly (a preference for stable-preference wording, a lesson otherwise); automatic dream/organize outputs still go through review.

**Do organized memories take effect directly?**
No. Every dream-generated `lesson` / `wiki` / `worklog(daily)` starts as `pending` and becomes searchable only after you accept or edit-before-accept in Memloom Desktop, the AGY `memory-review` Skill, or DSH Settings → Memory.

**Does it support semantic or vector search?**
No. Retrieval uses local BM25; there is no vector search and no external embedding service.

**Does memory sync across devices?**
No. Data stays locally in each host's storage path (AGY `${PLUGIN_DATA}/memory.json`, DSH `$DSH_HOME/storages/memory.json`); there is no cloud account or cross-device sync.

**Can different projects or hosts pollute each other?**
No. Memories are isolated by normalized `workspaceKey`, and AGY and DSH keep separate disk stores by default; inside Memloom Desktop they can be viewed together while remaining clearly labeled by host and workspace.

**How do I back up or migrate memories?**
The easiest way is the **Cross-host Migration** workbench in **Memloom Desktop**, which supports AGY ⇄ DSH `merge` and workspace-mapped `replace` migrations; you can also export full JSON and map workspaces on import. `/memory export` only returns a summary and writes no file.

**Does uninstalling the plugin delete my memories?**
Disabling/uninstalling the AGY or DSH plugin stops injection and capture while historical sessions remain; memory data stays in its local directory and can be cleaned manually.

## License

This project uses the [MIT license](LICENSE). Sponsor brand and marks remain the property of their respective owners.

---

<div align="center">

**Let experience remain, so every new session can move forward.**

memloom · Local-first long-term memory · 0.2.3-dev

</div>
