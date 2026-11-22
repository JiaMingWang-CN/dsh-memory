<div align="center">

# dsh-memory

### The next session should not start from zero.

**A DSH-native long-term memory plugin.**

Remember the projects you worked on, the pitfalls you hit, the rules you settled on, and your preferences.<br>
Recall them when needed; stay quiet when not.

[Overview](#overview) · [Use cases](#use-cases) · [How it works](#how-it-works) · [Management](#management) · [Privacy and security](#privacy-and-security) · [Install](#install) · [Configuration](#configuration) · [Architecture](#architecture) · [FAQ](#faq) · [Release notes](#release-notes)

[![Status](https://img.shields.io/badge/status-0.1.1--dev-blue)](#development-progress)
[![Distribution](https://img.shields.io/badge/distribution-GitHub%20Plugin-black)](#install)
![License](https://img.shields.io/badge/license-MIT-green)
[![Local first](https://img.shields.io/badge/data-local--first-brightgreen)](#privacy-and-security)

</div>

> [!NOTE]
> **Currently at `0.1.0` development (0.x), distributed exclusively as a GitHub plugin via GitHub Releases — not published to npm.**
>
> This document tracks the implemented capabilities in this repository. Before a stable release, interfaces, configuration and behavior may still change. See [`CHANGELOG.md`](CHANGELOG.md) for detailed changes.

---

<p align="center">
  <strong>Sponsor · Thank you for supporting dsh-memory open-source development</strong>
  <br>
  <a href="https://api.lwxiaoye.top/">
    <img src="assets/sponsor-k.png" alt="XiaoyeyeyeyeyeAPI sponsor logo" width="120">
  </a>
  <br>
  <a href="https://api.lwxiaoye.top/">XiaoyeyeyeyeyeAPI · Visit sponsor website</a>
</p>

## Overview

Every new session can start from zero: re-learning the project, re-asking conventions, and sometimes repeating a mistake that was already corrected.

**dsh-memory wants experience to carry across sessions.**

It is not another full chat transcript and it does not stuff all history into context. It is an experience-memory system designed around the DSH session lifecycle:

- **Remember corrections**: a pitfall becomes a reusable lesson.
- **Remember work**: know what was done, where it stopped, and what it produced.
- **Remember projects**: turn scattered architecture conventions, commands and decisions into project knowledge.
- **Remember you**: keep a small set of genuinely long-lived cross-project preferences.
- **Leave control to you**: inspect sources, review proposals, edit content, forget or permanently delete.

<div align="center">

**Capture experience → organize knowledge → human review → recall on demand**

</div>

## Use cases

### Stop repeating the same mistake

Last week you corrected this in a project:

> Run typecheck before building; don't wait for the bundle to fail on a type error.

In a new session, when you work on build-related tasks again, dsh-memory aims to bring that relevant lesson back into context. You should not have to explain it again, and the agent should not have to learn it through another failure.

### Continue where the last session stopped

> Where did we leave this module?

Through worklogs, project knowledge and source sessions, dsh-memory will help the agent find the previous work summary and key results instead of reading the whole history.

### Let project knowledge settle

Conventions, common commands, key decisions and known pitfalls that recur across sessions can be consolidated by Dreaming into maintainable project wiki entries. Every piece of knowledge has a source, can be replaced when stale, and can be corrected when wrong.

### Make preferences work across projects

Long-lived preferences such as "reply in Chinese" or "never auto-commit" can be explicitly written as global memories; project-specific technical rules stay in their own workspaces and do not pollute each other.

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

dsh-memory is designed to listen for signals worth preserving:

- the user explicitly corrects a mistake;
- a tool fails and a working approach is found for the same target;
- a turn produces file changes, deliverables or an explicit result;
- the user says "remember this" or "always do it this way";
- a session fails and leaves a fragment worth organizing later.

Automatic capture first creates a lightweight **Episode**, not long-term knowledge. Capture uses a field allowlist and redacts before persistence; full tool arguments, full tool outputs, attachments, images and reasoning are out of scope.

A qualifying turn (file change, delivery, user correction or explicit completion result) produces a deterministic `worklog(turn)` without calling a model. The title prefers the first meaningful sentence in the assistant conclusion, then the first line of the user request; bare questions and clearly low-information fragments do not become titles, and the title is capped at 80 characters. Titles may still be short and need human review. The body allocates 4096 bytes with the conclusion first: `## Result` keeps up to 2048 bytes and is never squeezed out by a long request, `## Request` is capped at 1024 bytes, and only the remaining space goes to file lists and tool failures; every truncated section ends with `…[truncated]`.

### 2. Dreaming: turn fragments into experience

Dreaming is an offline memory-organization process: it reads redacted Episodes, combines them with existing memories, distills Lessons, Worklogs and Wikis, and handles duplicates and stale content.

The first complete release plans to be **human-first** by default:

- automatic capture on;
- automatic Dreaming off by default, with manual runs available;
- all Dreaming-generated knowledge and logs start as `pending`;
- only acceptance, or acceptance after editing, moves them to searchable `active`;
- explicit `memory_write` content takes effect directly;
- Dreaming can follow the current session model or use a chosen model and reasoning effort.

High confidence is not truth. The model does not bypass review because it feels certain.

Implemented reliability behavior for Dreaming:

- **Startup recovery and cold-session reconciliation**: after a process restart, persisted `queued` dreams resume with their original dream id; a dream interrupted while running is marked failed, its claimed episodes return to the retryable queue, and duplicate proposals are not generated. When `autoDream` is enabled, startup also reconciles cold sessions from the last 7 days to capture missed session events; with `autoDream=false` it neither reads cold sessions nor calls a model for this purpose.
- **Failure classification, backoff and pause**: authentication and quota errors pause automatic dreaming immediately; rate-limit, timeout and network errors back off for 60 seconds, then 180 seconds, and pause after three consecutive failures. Pause and backoff are process-local and reset on restart; manual dreams are never blocked, and a successful manual dream clears the pause.
- **Health checks and evidence grading**: before each dream that calls the model, pending episodes, duplicate tool failures, pending proposals, duplicate titles and missing daily worklogs are computed locally and supplied to the model as hints. The model uses only facts supported by the episodes: content the user stated counts as evidence and cites the episode id; assistant claims without tool or user support are marked unverified or omitted; one memory covers one topic, and only what the environment cannot give back is recorded (lessons, approaches that worked, verified rules, pitfalls and plans in progress) — not code, file contents, current configuration values, git history or command output.

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

Refresh is merged only before a later real model request and never wakes the agent just because memory changed. After restart, resume or compaction, index state is rebuilt from durable messages in the session rather than a volatile in-memory cache.

## Management

### Settings → Memory

The management page uses a **unified header + four focused tabs** (`Memories`, `Review`, `Import & Export`, `Settings`) and provides the following (0.1.0 development version):

- **Header overview and navigation**: switch workspaces, click active/pending/archived counters to jump directly, monitor the current workspace's index budget meter, and access fixed `New memory`, `Dream now` and `Refresh` actions;
- **Memories (search and filter)**: server-side keyword search across title, body and tags, segmented type/status filter pills, inline user tags and conditional paging;
- **Centered modals for create, detail and edit**: pinned footers, tag chips, synchronized importance slider, one-click body/source copying, and inline unsaved-change confirmation; archived records show only Restore and hide Archive;
- **Review and dreaming**: top status card showing the latest run's model, processed episodes and output counts with cancel/undo actions; proposal modal with **line-level diff / side-by-side / proposed-only** views, one-step `Save & accept`, and previous/next sequential review;
- **Import and export**: separated Export and drag-and-drop Import cards with parsed file summary preview (memories, episodes, workspaces, exported timestamp), per-workspace mapping and structured import reports;
- **Grouped settings**: four horizontal setting groups (`Automatic dreaming`, `Index & injection`, `Retention`, `Privacy & security`) with second-based idle wait and interval inputs, an opt-in `Auto-accept proposals` switch (off by default, keeps `derived` ownership and remains undoable by run), live KB budget conversion, unsaved-change indicator and discard action.

Permanent deletion, full purge and full rebuild remain available only through the Host management API, require explicit confirmation parameters, and are not exposed in the 0.1.0 page.

By default only the current workspace and global preferences are shown. Other projects' memories appear only after explicitly switching to "all accessible workspaces".

In conversation, the memory tools keep DSH's native tool-call rows (matching `memory_read`), and a small note beside the token usage and time displays only non-zero cumulative counts of memories injected, written and searched in this session.

## Privacy and security

**Memory should belong to you, not become an invisible black box.**

- **Local first**: memory data is persisted locally under `$DSH_HOME` by default; there is no cloud account and no default cross-device sync. If an external model service performs Dreaming, the content sent depends on that model service.
- **Redact before saving**: common secrets, tokens, passwords and inline `.env` values are redacted; the design does not save the original first and clean it later. An explicit `memory_write` that contains a private key, a common cloud API key, a GitHub/Slack token or another strong secret shape is refused with a hint to record where the credential is configured; capture, dream and import paths still replace and save under the redaction rules. `redactSecrets=false` only disables redaction for explicit writes, dreams and imports; capture and worklog text are always redacted.
- **Workspace isolation**: project memories are filtered by normalized workspace identity, and the global layer allows user preferences only. A replacement import requires a mapping for every workspace in the file; if one is missing, the whole replacement is rejected.
- **Untrusted content**: memory bodies and source references are background knowledge, never system instructions; persistence and injection also include safety escaping.
- **No full conversation copies**: the DSH session log remains the source of session facts; the memory store keeps distilled knowledge and necessary references.
- **Bounded capacity**: hard limits reject new records with an alert instead of silently dropping data. When `active` records overflow, only unreviewed derived records are archived automatically; user-owned and pinned records are protected.
- **User ownership**: memories created, edited, imported, accepted or restored by the user are protected from derived-cache rebuild cleanup.
- **Dangerous operations need confirmation**: permanent deletion, full purge, full rebuild, replacement import, scope expansion or disabling safety protections still require explicit user confirmation; export files contain personal memories, and the management page reminds you to store them safely.

## Traceable, recoverable, undoable

Long-term memory must remain trustworthy under failure, not just writable.

dsh-memory stores structured records, Markdown bodies and a local retrieval index, coordinating multi-step writes through an operation log:

- every business change keeps structured before/after snapshots and the actor;
- business revision numbers prevent overwriting later user edits;
- interrupted operations recover according to their persisted state after a process crash;
- accepting a replacement proposal never leaves old and new versions active simultaneously;
- Dreaming runs can be undone; entries edited by the user afterwards are skipped and reported;
- search hits and full reads are counted separately, avoiding a "popular memories get recalled more" self-reinforcement loop.

**Rebuild is not backup recovery.** It only rebuilds derived data that may be deleted; user-owned memories must be protected, migrated and backed up independently.

## Tools and commands

### Agent tools

| Tool | Intended use |
| --- | --- |
| `memory_search` | Search summaries by keyword, type and scope |
| `memory_read` | Read the full body and sources of a recallable memory, recording actual use |
| `memory_write` | Explicitly create or update a memory; takes effect directly, and the tool description states when to write and when not to |
| `memory_forget` | Soft forget; models cannot delete permanently |
| `memory_dream` | Manually start a dream run over the episode queue |
| `memory_organize` | Manually consolidate existing active memories into merge/replacement proposals |

### User commands

The plugin provides `/memory status`, `/memory search`, `/memory dream`, `/memory organize`, `/memory forget` and `/memory export` for status, retrieval, episode queue organization, existing-memory organization, forgetting and export summaries. Full JSON export is done in Settings → Memory.

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

> dsh-memory is **distributed exclusively as a GitHub plugin (via this GitHub repository and GitHub Releases) and is not published to npm**. `0.1.0` remains a 0.x development version.

**Requirements**

- A locally installed DSH `0.2.2-rc.5` (the `engines.dsh` field in `package.json` declares the compatible range `^0.2.2-rc.5`)
- Node.js `>=24.9.0`
- pnpm (only required when building from source)

**Option 1: Install from a GitHub Release (recommended)**

Once a GitHub Release is published, install its prebuilt `.tgz` bundle asset directly via the DSH CLI without building locally:

```bash
dsh plugin --profile desktop add https://github.com/JiaMingWang-CN/dsh-memory/releases/download/v0.1.1/dsh-memory-0.1.1.tgz
```

You can also download `dsh-memory-0.1.1.tgz` from GitHub Releases and install it from the DSH Plugins page.

**Option 2: Build from GitHub source and install locally**

```bash
git clone https://github.com/JiaMingWang-CN/dsh-memory.git
cd dsh-memory
pnpm install
pnpm build          # produces dist/host and dist/client.js

# Approach A: local link install (recommended for development; rebuild + restart DSH to reload)
dsh plugin --profile desktop add link:./

# Approach B: pack into a local bundle tarball
pnpm pack           # produces dsh-memory-0.1.1.tgz
```

Installing or enabling changes your profile; restart DSH afterwards and Memory will appear under Settings with its icon. See [`examples/cordis.patch.yml`](examples/cordis.patch.yml) for a minimal patch config. To remove the plugin, run `dsh plugin --profile desktop remove dsh-memory` (your memories remain safely stored in `$DSH_HOME/storages/memory.json`).

## Quick start

1. **Write a memory**: in a new session, ask the agent to remember something (it calls `memory_write`), or create one in Settings → Memory. Explicit writes take effect directly.
2. **Recall in a new session**: dsh-memory injects a small memory index before the first request of a new session; the agent can also call `memory_search` for summaries and `memory_read` for the full body and sources.
3. **Organize and review**: run `/memory dream`, or click `Dream now` in Settings → Memory. Results first enter "pending review" and become searchable long-term memories only after you accept or edit-before-accept.
4. **Forget**: use `memory_forget` or the management page for a soft forget; the memory stops being recalled and can be restored later.

A typical loop:

```text
> Run typecheck before building, so type errors don't surface at bundle time.
(the agent calls memory_write to store a lesson)

(new session) > We're about to bundle and release. What first?
(the index brings back "run typecheck before building")
```

## Configuration

Defaults match `src/host/config.ts` field by field; see [`docs/configuration.md`](docs/configuration.md) for every field. Key 0.1.0 defaults:

| Setting | Default | Meaning |
| --- | --- | --- |
| `autoDream` | `false` | No automatic model organization by default; the user triggers it manually. |
| `refreshIndexOnChange` | `false` | Inject the index only on the first request of a new session by default. |
| `autoCaptureEpisodes` | `true` | Capture key fragments automatically, but ordinary fragments do not become searchable knowledge directly. |
| `indexMaxBytes` | `4096` | Byte budget for the first memory index. |
| `redactSecrets` | `true` | Redact secrets before persistence. |
| `injectForSubagents` | `false` | Do not repeat fixed context for every subtask by default. |

Minimal runnable config example:

```yaml
- insert:
    - id: dsh-memory
      name: dsh-memory
      config:
        autoDream: false
        autoCaptureEpisodes: true
        refreshIndexOnChange: false
```

## Architecture

dsh-memory is a single DSH bundle containing both Host and Client:

- **Host**: a single `MemoryService` registers the `memory` service and owns storage, BM25 retrieval, episode capture, dreaming, existing-memory organization, `agent/pre-step` index injection, the six model tools and the `/memory` command.
- **Client**: registers the Settings → Memory page and icon, and shows a small memory-usage note in the assistant action row beside token usage; the memory tools use DSH's native tool-call rows with no custom cards. It reads and writes through `ctx.remote.memory.*`, uses zh/en copy and only theme tokens for styling.
- **Storage**: memories persist through a `storageDomain` JSON domain (default `$DSH_HOME/storages/memory.json`); six tables hold memories, episodes, dreams, audit, operation log and session cursors.
- **Consistency and recovery**: there are no cross-table transactions; multi-table writes go through the `operations` state machine and recover from the operation matrix after a crash, and a single corrupted row does not block recovery of the remaining operations.
- **Index injection**: a first baseline, then, when refresh is enabled, only `add` / `replace` / `remove` / `reset` deltas, without waking the agent.
- **Error contract**: Host business errors map to stable `memory/*` remote failure codes, with details preserving the original `OperationError` code.
- **Compatibility**: `engines.dsh` declares the compatible DSH version range, and `prepack` builds before packing.

See [`docs/architecture.md`](docs/architecture.md), [`docs/memory-model.md`](docs/memory-model.md), [`docs/dreaming.md`](docs/dreaming.md) and [`docs/security.md`](docs/security.md).

## FAQ

**Can I rely on dsh-memory for long-term daily use now?**
The repository is at 0.1.0 development (0.x) and has not reached a stable release. Features work, but interfaces, configuration and behavior may still change.

**Will it organize my memories automatically?**
Not by default. `autoDream=false`, so you run `/memory dream` (episode queue) or `/memory organize` (existing active memories), or click `Dream now`. Even with automatic organization enabled, outputs enter review first.

**Does "remember this" write immediately?**
Yes. When the model did not call `memory_write` in that turn, an explicit "remember" or "from now on" request writes an `active` memory directly (a preference for stable-preference wording, a lesson otherwise); automatic dream/organize outputs still go through review.

**Do organized memories take effect directly?**
No. Every dream-generated `lesson` / `wiki` / `worklog(daily)` starts as `pending` and becomes searchable only after you accept or edit-before-accept in Settings → Memory.

**Does it support semantic or vector search?**
No. Retrieval uses local BM25; there is no vector search and no external embedding service.

**Does memory sync across devices?**
No. Data stays locally under `$DSH_HOME`; there is no cloud account or cross-device sync.

**Can different projects pollute each other?**
No. Memories are isolated by normalized `workspaceKey`; by default only the current workspace and global preferences are shown, and other workspaces appear only after explicitly switching to "all accessible workspaces".

**How do I back up or migrate memories?**
Export full JSON from the export area in Settings → Memory, then merge or replace it through the import area after mapping each workspace. `/memory export` only returns an export summary and writes no file. Across machines, choose a local target for every source workspace; unmapped entries are skipped, and replacement mode requires all of them to be mapped.

**Does uninstalling the plugin delete my memories?**
Disabling/uninstalling stops injection and capture while historical messages remain; memory data stays in `$DSH_HOME` and can be cleaned manually.

## Explicit non-goals

The first complete release does not aim at:

- external embedding services or vector databases;
- cloud accounts and cross-device sync;
- team multi-user permission systems;
- replacing DSH's historical session-text search;
- changing the DSH session format or adding private session event types;
- model-weight training or fine-tuning;
- enabling automatic knowledge activation without human review by default.

## Development progress

The repository is at **0.1.0 development (0.x)**. Implemented and test-covered capabilities include:

- memory domain storage, CRUD, scope isolation and version control;
- operation log, audit, capacity control, import/export and crash recovery;
- local BM25 retrieval and management-page keyword search;
- the six explicit tools `memory_write`, `memory_search`, `memory_read`, `memory_forget`, `memory_dream` and `memory_organize`;
- new-session memory index injection (first baseline by default, optional delta refresh);
- whitelisted Episode capture, conditional `worklog(turn)` and manual/automatic Dreaming (all outputs `pending`);
- spoken "remember / from now on" requests write an `active` memory directly (preference or lesson) and dedupe against a same-turn `memory_write`;
- full-library consolidation of existing active memories (`memory_organize` / `/memory organize`), where proposals must `supersedes` the older memory;
- dream queue startup recovery and cold-session startup reconciliation, failure classification/backoff/process-local pause, health checks and evidence grading;
- worklog title and body budgets, strong-secret refusal on explicit writes, and the recent turn worklog index fallback (design D1, v2.4);
- `proposalKey` dedupe, duplicate-proposal linking and per-dream-run undo (triggerable from the management page);
- the `/memory status | search | dream | organize | forget | export` command (`export` returns a summary);
- the 4-tab Settings → Memory management page: header overview with index budget meter, keyword search and filter pills, centered create/detail/edit modals (tag chips, importance slider, inline unsaved confirmation, archived records hiding Archive), proposal diff/side-by-side comparison with `Save & accept` and sequential review, `Dream now` with detailed run status/cancel/undo, drag-and-drop import preview with workspace mapping, and grouped horizontal settings;
- stable `memory/*` failure codes for the remote management API (conflict, not found, invalid content, forbidden, capacity, unavailable), which the client uses to localize messages and detect concurrent-edit conflicts;
- `engines.dsh` declares the compatible DSH version range, `prepack` builds before packing, and CI validates the packed files.

The Settings → Memory management page, the review UI, and the in-conversation memory-usage summary (the memory tools use DSH's native tool-call rows) are all delivered. 0.1.0 remains a **0.x development version** with `autoDream=false`, `refreshIndexOnChange=false` and `autoCaptureEpisodes=true`; see [Install](#install) and [Quick start](#quick-start) above.

## Release notes

- **Distribution channel**: dsh-memory is distributed exclusively as a **GitHub plugin** via [GitHub Releases](https://github.com/JiaMingWang-CN/dsh-memory/releases) (prebuilt `.tgz` bundle asset plus repository source), with **no npm package publication**.
- **Changelog**: see [`CHANGELOG.md`](CHANGELOG.md) for detailed changes.

## License

This project uses the [MIT license](LICENSE). Sponsor brand and marks remain the property of their respective owners.

---

<div align="center">

**Let experience remain, so every new session can move forward.**

dsh-memory · DSH-native long-term memory · 0.1.0-dev

</div>
