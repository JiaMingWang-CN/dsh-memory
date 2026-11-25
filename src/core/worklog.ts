/**
 * Deterministic `worklog(turn)` generation.
 *
 * A worklog is written only for a completed turn that produced something
 * concrete: a file change, a delivery, a user correction, or an explicit
 * completion result. It is a lightweight summary built without any LLM call and
 * never includes raw tool parameters or output.
 * @module dsh-memory/core/worklog
 */
import type { MemoryConfig } from './config.ts'
import { redactSecrets } from './redact.ts'
import type { MemoryStore } from './store.ts'
import type { EpisodeKind, EpisodeRecord, MemoryRecord } from '../shared/types.ts'

/**
 * Episode summary handed to the worklog builder and the dream queue. It carries
 * only whitelisted fields; no raw tool parameters or output are present.
 */
export interface CaptureEpisodeInput {
  kind: EpisodeKind
  sessionId: string
  workspaceKey: string
  workspaceRoot: string
  turn: number
  sourceSeqs: number[]
  prompt?: string
  assistantFinal?: string
  toolName?: string
  toolError?: string
  files: string[]
  /** One-line summaries of tool failures observed in the turn. */
  toolFailures?: string[]
  correctionText?: string
  outcome?: string
  /** Structured failure code of a failed turn. */
  failureCode?: string
  /** Redacted failure message of a failed turn. */
  failureMessage?: string
  /** A delivery (`present`/`deliver`) event occurred in this turn. */
  delivered?: boolean
  /** The turn contains a user correction candidate. */
  correction?: boolean
  /** An explicit completion signal (goal/completed task) was observed. */
  explicitCompletion?: boolean
  /** The turn belongs to a subagent session (delegation depth > 0). */
  subagent?: boolean
}

/** Largest worklog body, in UTF-8 bytes. */
export const WORKLOG_MAX_BODY_BYTES = 4096
/** Largest assistant conclusion quoted into a worklog. */
export const WORKLOG_MAX_CONCLUSION_BYTES = 2048
/** Longest worklog title, in characters. */
export const WORKLOG_MAX_TITLE_LENGTH = 80

/** Largest user request kept in a worklog, in UTF-8 bytes. */
const WORKLOG_MAX_REQUEST_BYTES = 1024
/** Largest number of file entries kept in a worklog. */
const WORKLOG_MAX_FILES = 20
/** Largest number of tool-failure entries kept in a worklog. */
const WORKLOG_MAX_TOOL_FAILURES = 10
/** Marker appended to every truncated section. */
const TRUNCATION_MARKER = '…[truncated]'
const TRUNCATION_MARKER_BYTES = Buffer.byteLength(TRUNCATION_MARKER, 'utf8')
/** Markdown headings that carry no information once stripped. */
const HEADING_LABELS = /^(?:结论|总结|摘要|结果|完成情况|summary|result|conclusion)$/i
/** Generic acknowledgements and filler sentences that make useless titles. */
const GENERIC_TITLE =
  /^(?:(?:已)?完成(?:了)?|好的?|好|收到|明白|了解|没问题|可以|行|我来处理|我去处理|我处理|已处理|已修复|处理完成|搞定|done|ok|okay|sure|具体修改如下|具体如下|修改如下|详细说明如下|总结如下|说明如下|如下)(?:[，,、\s]*(?:好的?|收到|明白|了解|没问题|可以|行|我来处理|我去处理|我处理|已处理|完成|done|ok|okay|sure|具体修改如下|具体如下|修改如下|详细说明如下|总结如下|说明如下|如下))*$/i

/** Truncate by UTF-8 bytes without splitting a code point. */
function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let bytes = 0
  let out = ''
  for (const char of text) {
    const width = Buffer.byteLength(char, 'utf8')
    if (bytes + width > maxBytes) break
    out += char
    bytes += width
  }
  return out
}

/** Truncate one section to a byte budget and append the truncation marker. */
function truncateSection(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const budget = Math.max(0, maxBytes - TRUNCATION_MARKER_BYTES)
  return `${truncateUtf8(text, budget)}${TRUNCATION_MARKER}`
}

/** Remove leading blockquote, heading, list and inline markdown markers. */
function stripMarkdownLine(line: string): string {
  let text = line.trim()
  text = text.replace(/^(?:>\s*)+/, '')
  if (/^(?:[-*+]|\d+[.)])\s*$/.test(text)) return ''
  text = text.replace(/^#{1,6}\s*/, '')
  text = text.replace(/^(?:[-*+]|\d+[.)])\s+/, '')
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  text = text.replace(/\*\*|__|~~|`/g, '')
  return text.trim()
}

/** Split one line into sentence pieces, keeping the trailing punctuation. */
function splitSentencePieces(line: string): string[] {
  const pieces: string[] = []
  let start = 0
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    const next = line[index + 1]
    const boundary =
      char === '。' ||
      char === '！' ||
      char === '？' ||
      char === '!' ||
      char === '?' ||
      char === '：' ||
      ((char === ':' || char === '.') && (next === undefined || /\s/.test(next)))
    if (!boundary) continue
    pieces.push(line.slice(start, index + 1))
    start = index + 1
  }
  if (start < line.length) pieces.push(line.slice(start))
  return pieces
}

/** Remove common lead-in labels such as `已完成：` or `结论：`. */
function stripLeadIn(text: string): string {
  let candidate = text.trim()
  candidate = candidate.replace(/^已完成\s*[：:]?\s*/, '')
  candidate = candidate.replace(/^(?:结论|总结|摘要|结果|完成情况)\s*[：:]\s*/, '')
  candidate = candidate.replace(/^(?:summary|result|conclusion)\s*[：:]\s*/i, '')
  return candidate.trim()
}

/** Collapse whitespace and drop trailing commas/colons from a title. */
function normalizeTitle(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[，,：:；;。.、]+$/u, '')
    .trim()
}

/** Whether a candidate consists only of punctuation or symbols. */
function isPunctuationOnly(text: string): boolean {
  return /^[\p{P}\p{S}\s]+$/u.test(text)
}

/** Whether a candidate is a bare question sentence. */
function isQuestionTitle(text: string): boolean {
  return /(?:[？?]|吗|呢)$/.test(text)
}

/** Whether a candidate is a generic acknowledgement or filler sentence. */
function isGenericTitle(text: string): boolean {
  return GENERIC_TITLE.test(text)
}

/** First informational sentence in a text, or undefined when there is none. */
function firstMeaningfulTitle(text: string): string | undefined {
  let inCodeFence = false
  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    if (/^(?:`{3,}|~{3,})/.test(trimmed)) {
      inCodeFence = !inCodeFence
      continue
    }
    if (inCodeFence) continue
    if (trimmed.startsWith('|')) continue
    const line = stripMarkdownLine(rawLine)
    if (line === '') continue
    if (isPunctuationOnly(line)) continue
    for (const piece of splitSentencePieces(line)) {
      const candidate = normalizeTitle(stripLeadIn(piece))
      if (candidate === '') continue
      if (isPunctuationOnly(candidate)) continue
      if (HEADING_LABELS.test(candidate)) continue
      if (isGenericTitle(candidate)) continue
      if (isQuestionTitle(candidate)) continue
      return candidate
    }
  }
  return undefined
}

/** Whether a prompt-derived candidate is informative enough to be a title. */
function isPromptTitleUsable(title: string): boolean {
  if (isGenericTitle(title)) return false
  if ([...title].length < 6 && !/[\u4e00-\u9fff]/.test(title)) return false
  return !/^(?:执行|运行|开始|继续|处理|do|run|execute)\s*(?:plan|计划|task|任务)?\s*[0-9a-z._-]+$/i.test(
    title,
  )
}

/** Build a deterministic title from the assistant result, then the prompt. */
function titleOf(episode: CaptureEpisodeInput): string {
  const redactedAssistant =
    episode.assistantFinal === undefined ? undefined : redactSecrets(episode.assistantFinal)
  const assistantTitle =
    redactedAssistant === undefined ? undefined : firstMeaningfulTitle(redactedAssistant)
  const redactedPrompt = episode.prompt === undefined ? undefined : redactSecrets(episode.prompt)
  const promptLine = redactedPrompt?.split(/\r?\n/, 1)[0]
  const promptCandidate = promptLine === undefined ? undefined : firstMeaningfulTitle(promptLine)
  const promptTitle =
    promptCandidate !== undefined && isPromptTitleUsable(promptCandidate)
      ? promptCandidate
      : undefined
  const selected = assistantTitle ?? promptTitle ?? 'Work log'
  const normalized = normalizeTitle(selected) || 'Work log'
  const characters = [...normalized]
  if (characters.length <= WORKLOG_MAX_TITLE_LENGTH) return normalized
  return `${characters.slice(0, WORKLOG_MAX_TITLE_LENGTH - 1).join('')}…`
}

/** Build a text section inside its own byte budget. */
function buildTextBlock(heading: string, text: string, maxBytes: number): string | undefined {
  const redacted = redactSecrets(text).trim()
  if (redacted === '') return undefined
  const block = `## ${heading}\n${redacted}`
  if (Buffer.byteLength(block, 'utf8') <= maxBytes) return block
  return truncateSection(block, maxBytes)
}

/** Build a bounded list section. */
function buildListBlock(
  heading: string,
  entries: readonly string[],
  maxEntries: number,
  maxBytes: number,
): string | undefined {
  const candidates = entries
    .map((entry) => redactSecrets(entry).trim())
    .filter((entry) => entry !== '')
  const selected = candidates.slice(0, maxEntries)
  if (selected.length === 0) return undefined
  const headingBytes = Buffer.byteLength(`## ${heading}\n`, 'utf8')
  if (maxBytes < headingBytes + 2 + TRUNCATION_MARKER_BYTES) return undefined
  const block = `## ${heading}\n${selected.map((entry) => `- ${entry}`).join('\n')}`
  const blockBytes = Buffer.byteLength(block, 'utf8')
  const truncatedByCount = candidates.length > selected.length
  if (!truncatedByCount) {
    return blockBytes <= maxBytes ? block : truncateSection(block, maxBytes)
  }
  const suffix = `\n${TRUNCATION_MARKER}`
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix, 'utf8'))
  return `${truncateUtf8(block, budget)}${suffix}`
}

/** Build the bounded worklog body for one turn. */
function bodyOf(episode: CaptureEpisodeInput): string {
  const blocks: string[] = []
  let usedBytes = 0

  const append = (block: string | undefined): void => {
    if (block === undefined) return
    const separatorBytes = blocks.length === 0 ? 0 : 2
    const blockBytes = Buffer.byteLength(block, 'utf8')
    if (usedBytes + separatorBytes + blockBytes > WORKLOG_MAX_BODY_BYTES) return
    blocks.push(block)
    usedBytes += separatorBytes + blockBytes
  }

  // Result is allocated first so a long request can never squeeze it out.
  const assistantFinal = episode.assistantFinal?.trim()
  if (assistantFinal !== undefined && assistantFinal !== '') {
    append(buildTextBlock('Result', assistantFinal, WORKLOG_MAX_CONCLUSION_BYTES))
  }
  const prompt = episode.prompt?.trim()
  if (prompt !== undefined && prompt !== '') {
    append(buildTextBlock('Request', prompt, WORKLOG_MAX_REQUEST_BYTES))
  }

  let remainingBytes = WORKLOG_MAX_BODY_BYTES - usedBytes
  const hasFailures = (episode.toolFailures?.length ?? 0) > 0
  if (episode.files.length > 0) {
    const separatorBytes = blocks.length === 0 ? 0 : 2
    const failureHeadingBytes = Buffer.byteLength('## Tool failures\n', 'utf8')
    const failureReserve = hasFailures ? 2 + failureHeadingBytes + 2 + TRUNCATION_MARKER_BYTES : 0
    const available = Math.max(0, remainingBytes - separatorBytes - failureReserve)
    append(buildListBlock('Files', episode.files, WORKLOG_MAX_FILES, available))
    remainingBytes = WORKLOG_MAX_BODY_BYTES - usedBytes
  }
  if (hasFailures) {
    const separatorBytes = blocks.length === 0 ? 0 : 2
    const available = Math.max(0, remainingBytes - separatorBytes)
    append(
      buildListBlock(
        'Tool failures',
        episode.toolFailures ?? [],
        WORKLOG_MAX_TOOL_FAILURES,
        available,
      ),
    )
  }

  let body = blocks.join('\n\n')
  if (Buffer.byteLength(body, 'utf8') > WORKLOG_MAX_BODY_BYTES) {
    body = truncateSection(body, WORKLOG_MAX_BODY_BYTES)
  }
  return body
}

/**
 * Build the deterministic title and body for one worklog.
 * @param episode - Turn episode summary.
 * @returns Bounded title and body content.
 */
export function buildWorklogContent(episode: CaptureEpisodeInput): { title: string; body: string } {
  return { title: titleOf(episode), body: bodyOf(episode) }
}

/**
 * Whether a captured turn qualifies for a deterministic worklog.
 * @param episode - Turn episode summary.
 * @returns True only for a completed turn with at least one output condition.
 */
export function shouldCreateWorklog(episode: CaptureEpisodeInput): boolean {
  // A subagent turn is internal delegation work; its result already reaches the
  // parent session and must not create a second user-facing worklog.
  if (episode.subagent === true) return false
  if (episode.outcome !== 'completed') return false
  return (
    episode.files.length > 0 ||
    episode.delivered === true ||
    episode.correction === true ||
    episode.explicitCompletion === true
  )
}

/**
 * Create the `worklog(turn)` record for one completed turn.
 *
 * The record is `origin='system'`, `ownership='derived'`, `status='active'` and
 * `importance=0.3`; it never enters the resident index. A failure is logged and
 * swallowed so it can never block the turn from ending.
 * @param store - Memory store.
 * @param config - Resolved config (`worklogCapture`).
 * @param episode - Turn episode summary.
 * @param episodeRecord - Persisted source episode, when available.
 * @returns The created record, or undefined when not eligible / disabled.
 */
export async function createTurnWorklog(
  store: MemoryStore,
  config: Partial<MemoryConfig> | null | undefined,
  episode: CaptureEpisodeInput,
  episodeRecord?: EpisodeRecord,
  logger?: { warn?: (message: string) => void },
): Promise<MemoryRecord | undefined> {
  if (config?.worklogCapture === 'off') return undefined
  if (!shouldCreateWorklog(episode)) return undefined
  if (episode.workspaceKey === '' || episode.workspaceRoot === '') return undefined
  try {
    const { title, body } = buildWorklogContent(episode)
    return await store.create({
      type: 'worklog',
      worklogKind: 'turn',
      title,
      body,
      scope: { kind: 'workspace', key: episode.workspaceKey, root: episode.workspaceRoot },
      origin: 'system',
      ownership: 'derived',
      status: 'active',
      importance: 0.3,
      sourceEpisodeIds: episodeRecord === undefined ? [] : [episodeRecord.id],
      sourceRefs: [
        { sessionId: episode.sessionId, turn: episode.turn, eventSeq: episode.sourceSeqs[0] },
      ],
      actor: 'system',
    })
  } catch (error) {
    const message = `[dsh-memory] failed to create turn worklog: ${
      error instanceof Error ? error.message : String(error)
    }`
    if (logger?.warn !== undefined) logger.warn(message)
    else console.warn(message)
    return undefined
  }
}
