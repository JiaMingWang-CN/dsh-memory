/**
 * Incremental AGY `transcript.jsonl` parser and episode/worklog capture.
 *
 * Reads only steps strictly newer than the persisted `session_cursors` cursor,
 * applies strict field whitelisting and secret redaction, never reads
 * `PLANNER_RESPONSE.thinking` or `GENERIC` body content beyond the first two
 * header lines, splits multi-turn increments at `USER_INPUT` boundaries, and
 * maintains cross-process correction context in {@link AgySessionStateStore}.
 * @module memloom/agy/transcript-capture
 */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { CapacityPolicy } from '../core/capacity.ts'
import type { ResolvedMemoryConfig } from '../core/config.ts'
import type { MemoryEngine } from '../core/engine.ts'
import { OperationRunner } from '../core/operations.ts'
import { detectStrongSecret, redactSecrets } from '../core/redact.ts'
import { MemoryStore } from '../core/store.ts'
import {
  createTurnWorklog,
  shouldCreateWorklog,
  type CaptureEpisodeInput,
} from '../core/worklog.ts'
import { normalizeWorkspaceKey } from '../core/workspace.ts'
import type { EpisodeRecord, MemoryIndexSource, MemoryScope, MemoryType } from '../shared/types.ts'
import type { AgySessionStateStore } from './session-state.ts'
import type { FileMemoryDomain } from './storage.ts'
import { REGULAR_TOOL_NAMES, SENSITIVE_TOOL_NAMES } from './tools.ts'

/** Largest captured user prompt or assistant summary, in UTF-8 bytes. */
export const MAX_CAPTURE_TEXT_BYTES = 4096
/** Largest captured tool error header summary, in UTF-8 bytes. */
export const MAX_CAPTURE_TOOL_ERROR_BYTES = 1024

const USER_REQUEST_TAG = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i
const ADDITIONAL_METADATA_BLOCK = /<ADDITIONAL_METADATA>[\s\S]*?(?:<\/ADDITIONAL_METADATA>|$)/gi

const CORRECTION_SIGNAL =
  /(不对|错了|不是|应该是|不要|别再|不是这个意思|wrong|incorrect|should be)/i
const REMEMBER_SIGNAL =
  /(记住|记下|记一下|记牢|别忘|不要忘|以后都|以后不要|从现在起|remember|don't forget|do not forget|from now on)/i
const PREFERENCE_SIGNAL = /(以后|总是|习惯|偏好|每次|统一|always|never|prefer|from now on)/i
const NEGATED_REMEMBER =
  /(?:(?:不要|别|不用|无需|不必)(?:再)?\s*(?:记住|记下|记一下|记牢)|(?:don't|do not|can't|cannot|never)\s+remember)/i
const COMPLETION_SIGNAL =
  /(完成了|搞定了|已解决|没问题了|可以了|通过了|task complete|all done|resolved|looks good|lgtm)/i

const FILE_TOOLS = new Set([
  // AGY file modification tools
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
  'write_file',
  'edit_file',
  'delete_file',
  'move_file',
  // DSH file modification tools
  'write',
  'edit',
  'multi_edit',
  'apply_patch',
  'create_file',
  'delete',
  'move',
])

const DELIVERY_TOOLS = new Set(['present', 'deliver'])
const COMPLETION_TOOLS = new Set(['complete_task', 'finish_task', 'mark_done', 'goal_complete'])

const KNOWN_MEMORY_TOOLS: readonly string[] = [
  ...REGULAR_TOOL_NAMES,
  ...SENSITIVE_TOOL_NAMES,
  'memory_dream',
  'memory_organize',
].sort((left, right) => right.length - left.length)

const WHITELIST_ARG_KEYS: readonly string[] = [
  'TargetFile',
  'AbsolutePath',
  'Path',
  'CommandLine',
  'Cwd',
  'target_file',
  'targetFile',
  'absolute_path',
  'absolutePath',
  'file_path',
  'filePath',
  'path',
  'cwd',
  'command',
  'command_line',
  'commandLine',
  'notebook_path',
  'notebookPath',
]

const PATH_ARG_KEYS = new Set([
  'TargetFile',
  'AbsolutePath',
  'Path',
  'target_file',
  'targetFile',
  'absolute_path',
  'absolutePath',
  'file_path',
  'filePath',
  'path',
])

const FAILURE_STATUS_RE = /^(?:ERROR|FAILED|FAILURE|CANCELED|CANCELLED|TIMEOUT|TIMED_OUT)$/i
const EXIT_CODE_FAILURE_RE =
  /(?:command\s+exited\s+with\s+(?:code|status)|exit\s+code)\s*[:=]?\s*([1-9]\d*)/i
const ERROR_HEADER_RE =
  /^(?:error|typeerror|syntaxerror|referenceerror|enoent|eacces|eperm|fail|failed|exception|tool\s+error|command\s+failed)\b/i
const JSON_IS_ERROR_RE = /"isError"\s*:\s*true\b/

/** Input accepted by {@link captureAgyTranscript}. */
export interface TranscriptCaptureInput {
  transcriptPath: string
  conversationId: string
  workspaceRoot: string
  terminationReason?: string
  error?: string
  subagent?: boolean
  domain: FileMemoryDomain
  engine: MemoryEngine
  sessionStore: AgySessionStateStore
  config: ResolvedMemoryConfig
  now?: () => Date
}

/** Summary returned by {@link captureAgyTranscript}. */
export interface TranscriptCaptureReport {
  processedSteps: number
  episodesCreated: number
  worklogsCreated: number
  directMemoriesCreated: number
  lastStepIndex: number
}

interface ParsedStep {
  stepIndex: number
  type: string
  status: string
  content?: string
  toolCalls?: readonly unknown[]
}

interface PendingToolCall {
  name: string
  targetHash: string
  targetPath?: string
  isMemoryTool: boolean
  isMemoryWrite: boolean
}

interface RecordedFailure {
  name: string
  targetHash: string
  code: string
  seq: number
  consumed: boolean
}

interface TurnDraft {
  turnNumber: number
  prompt?: string
  promptSeq?: number
  assistantFinal?: string
  assistantSeq?: number
  pendingCalls: PendingToolCall[]
  failures: RecordedFailure[]
  files: Set<string>
  seqs: number[]
  delivered: boolean
  correction: boolean
  correctionText?: string
  explicitCompletion: boolean
  explicitWrite: boolean
  sawMemoryTool: boolean
  sawNonMemoryTool: boolean
  rememberText?: string
  rememberSeq?: number
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hashOf(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

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

function sanitize(text: string | undefined, maxBytes: number): string | undefined {
  if (text === undefined) return undefined
  const redacted = redactSecrets(text)
  return truncateUtf8(redacted, maxBytes)
}

/**
 * Extract pure user request text from an AGY `USER_INPUT` or `lastUserInput` string.
 * Prefers content inside `<USER_REQUEST>...</USER_REQUEST>`, otherwise strips
 * `<ADDITIONAL_METADATA>...</ADDITIONAL_METADATA>` blocks.
 */
export function extractUserRequestText(raw: string): string {
  const match = USER_REQUEST_TAG.exec(raw)
  if (match !== null && match[1] !== undefined) {
    return match[1].trim()
  }
  return raw.replace(ADDITIONAL_METADATA_BLOCK, '').trim()
}

/**
 * Unwrap a JSON-stringified argument value from compact AGY `transcript.jsonl`
 * (e.g. `"\"c:\\\\ws\\\\a.ts\""` -> `"c:\\ws\\a.ts"`), falling back to the raw string.
 */
function unwrapStringArg(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'string') return parsed
  } catch {
    // Native unescaped string value (e.g. transcript_full.jsonl).
  }
  return raw
}

function unwrapArgsObject(raw: unknown): Record<string, unknown> | undefined {
  if (isPlainObject(raw)) return raw
  if (typeof raw !== 'string') return undefined
  try {
    const first: unknown = JSON.parse(raw)
    if (isPlainObject(first)) return first
    if (typeof first === 'string') {
      const second: unknown = JSON.parse(first)
      if (isPlainObject(second)) return second
    }
  } catch {
    return undefined
  }
  return undefined
}

function matchMemoryToolName(rawName: string): string | undefined {
  const trimmed = rawName.trim()
  for (const known of KNOWN_MEMORY_TOOLS) {
    if (
      trimmed === known ||
      trimmed.endsWith(`_${known}`) ||
      trimmed.endsWith(`:${known}`) ||
      trimmed.endsWith(`/${known}`) ||
      trimmed.endsWith(`.${known}`)
    ) {
      return known
    }
  }
  if (/^(?:.*[_:/.-])?memory_[a-z0-9_]+$/i.test(trimmed)) {
    const idx = trimmed.toLowerCase().lastIndexOf('memory_')
    return trimmed.slice(idx).toLowerCase()
  }
  return undefined
}

function isMemoryServerName(serverName: string | undefined): boolean {
  if (serverName === undefined) return true
  const trimmed = serverName.trim()
  if (trimmed.length === 0) return true
  return (
    /^(?:(?:memloom|dsh-memory)[_:-])?memory$/i.test(trimmed) || /memloom|dsh-memory/i.test(trimmed)
  )
}

function resolveTranscriptToolCall(rawCall: unknown): PendingToolCall | undefined {
  if (!isPlainObject(rawCall)) return undefined
  if (typeof rawCall.name !== 'string' || rawCall.name.trim().length === 0) return undefined

  const outerName = rawCall.name.trim()
  const outerArgs = unwrapArgsObject(rawCall.args) ?? {}

  let effectiveName = outerName
  let effectiveArgs = outerArgs
  let serverAllowed = true

  if (outerName === 'call_mcp_tool' || outerName.endsWith('_call_mcp_tool')) {
    const serverName =
      unwrapStringArg(outerArgs.ServerName) ?? unwrapStringArg(outerArgs.serverName)
    serverAllowed = isMemoryServerName(serverName)
    const innerName = unwrapStringArg(outerArgs.ToolName) ?? unwrapStringArg(outerArgs.toolName)
    if (innerName !== undefined && innerName.trim().length > 0) {
      effectiveName = innerName.trim()
      effectiveArgs =
        unwrapArgsObject(outerArgs.Arguments) ?? unwrapArgsObject(outerArgs.arguments) ?? {}
    }
  }

  const memoryTool = serverAllowed ? matchMemoryToolName(effectiveName) : undefined
  if (memoryTool !== undefined) {
    return {
      name: memoryTool,
      targetHash: hashOf(''),
      isMemoryTool: true,
      isMemoryWrite: memoryTool === 'memory_write',
    }
  }

  const picked: [string, string][] = []
  let targetPath: string | undefined
  for (const key of WHITELIST_ARG_KEYS) {
    const unwrapped = unwrapStringArg(effectiveArgs[key])
    if (unwrapped !== undefined && unwrapped.length > 0) {
      const redacted = redactSecrets(unwrapped)
      picked.push([key, redacted])
      if (targetPath === undefined && PATH_ARG_KEYS.has(key)) {
        targetPath = redacted
      }
    }
  }
  picked.sort((left, right) => left[0].localeCompare(right[0]))

  return {
    name: effectiveName,
    targetHash: hashOf(JSON.stringify(picked)),
    ...(targetPath === undefined ? {} : { targetPath }),
    isMemoryTool: false,
    isMemoryWrite: false,
  }
}

/**
 * Inspect ONLY `status` and at most the first 2 non-empty header lines of a
 * `GENERIC` step's `content`. Never reads or stores body content past line 2.
 */
function inspectGenericStep(step: ParsedStep): {
  isFailure: boolean
  code: string
  headerSummary?: string
} {
  const headerLines: string[] = []
  if (typeof step.content === 'string') {
    for (const rawLine of step.content.split(/\r?\n/)) {
      const trimmed = rawLine.trim()
      if (trimmed.length === 0) continue
      headerLines.push(trimmed)
      if (headerLines.length >= 2) break
    }
  }

  const headerJoined = headerLines.join(' | ')
  const statusFailed = FAILURE_STATUS_RE.test(step.status.trim())
  const exitMatch = EXIT_CODE_FAILURE_RE.exec(headerJoined)
  const headerError =
    exitMatch !== null ||
    headerLines.some((line) => ERROR_HEADER_RE.test(line)) ||
    JSON_IS_ERROR_RE.test(headerJoined)

  const isFailure = statusFailed || headerError
  let code = 'OK'
  if (exitMatch !== null && exitMatch[1] !== undefined) {
    code = `EXIT_${exitMatch[1]}`
  } else if (statusFailed) {
    code = step.status.trim().toUpperCase()
  } else if (headerError) {
    code = 'TOOL_ERROR'
  }

  const redactedSummary =
    headerJoined.length > 0 ? sanitize(headerJoined, MAX_CAPTURE_TOOL_ERROR_BYTES) : undefined

  return {
    isFailure,
    code,
    ...(redactedSummary === undefined ? {} : { headerSummary: redactedSummary }),
  }
}

function parseTranscriptSteps(
  rawText: string,
  cursor: number,
): {
  steps: ParsedStep[]
  maxStepIndex: number
} {
  const steps: ParsedStep[] = []
  let maxStepIndex = cursor

  for (const rawLine of rawText.split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    if (trimmed.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      // Skip malformed JSONL lines safely without throwing.
      continue
    }
    if (!isPlainObject(parsed)) continue
    const stepIndex = parsed.step_index
    if (typeof stepIndex !== 'number' || !Number.isInteger(stepIndex) || stepIndex < 0) {
      continue
    }
    if (stepIndex <= cursor) continue

    maxStepIndex = Math.max(maxStepIndex, stepIndex)
    const type = typeof parsed.type === 'string' ? parsed.type : ''
    const status = typeof parsed.status === 'string' ? parsed.status : ''
    // Whitelist: deliberately NEVER access `parsed.thinking`.
    const content = typeof parsed.content === 'string' ? parsed.content : undefined
    const toolCalls = Array.isArray(parsed.tool_calls) ? parsed.tool_calls : undefined

    steps.push({
      stepIndex,
      type,
      status,
      ...(content === undefined ? {} : { content }),
      ...(toolCalls === undefined ? {} : { toolCalls }),
    })
  }

  steps.sort((left, right) => left.stepIndex - right.stepIndex)
  return { steps, maxStepIndex }
}

/**
 * Lightweight check for whether a transcript contains any valid step after `cursor`.
 */
export async function hasTranscriptStepsAfter(
  transcriptPath: string,
  cursor: number,
): Promise<boolean> {
  const raw = await fs.readFile(transcriptPath, 'utf8')
  const { steps } = parseTranscriptSteps(raw, cursor)
  return steps.length > 0
}

function mapTerminationOutcome(
  terminationReason: string | undefined,
  error: string | undefined,
): {
  outcome: string
  failureCode?: string
  failureMessage?: string
} {
  if (terminationReason === 'USER_CANCELED' || terminationReason === 'CANCELED') {
    return { outcome: 'cancelled' }
  }
  const hasErrorText = typeof error === 'string' && error.trim().length > 0
  if (
    terminationReason === 'ERROR' ||
    (terminationReason !== undefined && /^MAX_/i.test(terminationReason)) ||
    hasErrorText
  ) {
    const failureCode = terminationReason ?? 'ERROR'
    const failureMessage = sanitize(
      hasErrorText ? error.trim() : failureCode,
      MAX_CAPTURE_TOOL_ERROR_BYTES,
    )
    return {
      outcome: 'error',
      failureCode,
      ...(failureMessage === undefined ? {} : { failureMessage }),
    }
  }
  return { outcome: 'completed' }
}

function rememberTitle(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? ''
  const stripped = firstLine
    .replace(/^[>\s#*_`~-]+/, '')
    .replace(/[*_`~]/g, '')
    .trim()
  const source = stripped === '' ? 'Remembered note' : stripped
  const characters = [...source]
  return characters.length <= 80 ? characters.join('') : `${characters.slice(0, 79).join('')}…`
}

function uniqueSortedSeqs(seqs: readonly number[]): number[] {
  return [...new Set(seqs)].sort((left, right) => left - right)
}

function createTurnDraft(turnNumber: number): TurnDraft {
  return {
    turnNumber,
    pendingCalls: [],
    failures: [],
    files: new Set(),
    seqs: [],
    delivered: false,
    correction: false,
    explicitCompletion: false,
    explicitWrite: false,
    sawMemoryTool: false,
    sawNonMemoryTool: false,
  }
}

function createCaptureStore(
  domain: FileMemoryDomain,
  config: ResolvedMemoryConfig,
  now: () => Date,
): MemoryStore {
  const capacity = new CapacityPolicy({
    maxActiveMemories: config.maxActiveMemories,
    maxArchivedMemories: config.maxArchivedMemories,
    maxStoredMemories: config.maxStoredMemories,
    maxQueuedEpisodes: config.maxQueuedEpisodes,
  })
  const runner = new OperationRunner(domain, {
    now,
    requestDedupeTtlMs: config.requestDedupeTtlMs,
    maxOperationRecords: config.maxOperationRecords,
    maxAuditRecords: config.maxAuditRecords,
  })
  return new MemoryStore(domain, runner, {
    now,
    capacity,
    searchLimit: config.searchLimit,
    worklogRetentionDays: config.worklogRetentionDays,
    episodeRetentionDays: config.episodeRetentionDays,
    archivePurgePolicy: config.archivePurgePolicy,
    archiveRetentionDays: config.archiveRetentionDays,
  })
}

/**
 * Incrementally capture whitelisted episodes, direct oral "remember" memories,
 * and significant turn worklogs from an AGY `transcript.jsonl` file.
 */
export async function captureAgyTranscript(
  input: TranscriptCaptureInput,
): Promise<TranscriptCaptureReport> {
  const now = input.now ?? (() => new Date())
  const workspaceKey = normalizeWorkspaceKey(input.workspaceRoot)

  if (workspaceKey.length === 0) {
    return {
      processedSteps: 0,
      episodesCreated: 0,
      worklogsCreated: 0,
      directMemoriesCreated: 0,
      lastStepIndex: -1,
    }
  }

  const rawTranscript = await fs.readFile(input.transcriptPath, 'utf8')
  const store = createCaptureStore(input.domain, input.config, now)

  let processedSteps = 0
  let episodesCreated = 0
  let worklogsCreated = 0
  let directMemoriesCreated = 0
  let lastStepIndex = -1
  let sessionUpdate:
    | {
        conversationId: string
        workspaceRoot: string
        scopeKey: string
        indexSources: MemoryIndexSource[]
        captureTurn: number
        previousAssistantText?: string
      }
    | undefined

  await input.domain.withWriteLock(async () => {
    const existingCursor = input.domain.table('session_cursors').get(input.conversationId)
    const cursor = existingCursor?.lastProcessedSeq ?? -1
    const { steps, maxStepIndex } = parseTranscriptSteps(rawTranscript, cursor)
    lastStepIndex = maxStepIndex

    if (steps.length === 0) {
      return
    }
    processedSteps = steps.length

    await input.engine.recover()
    await store.initialize()

    const existingSession = await input.sessionStore.read(input.conversationId)
    let currentTurnNumber = existingSession?.captureTurn ?? 0
    let previousAssistantText = existingSession?.previousAssistantText
    let needsSearchSync = false

    const finalizeTurn = async (turn: TurnDraft, isFinalTurn: boolean): Promise<void> => {
      const outcomeInfo = isFinalTurn
        ? mapTerminationOutcome(input.terminationReason, input.error)
        : { outcome: 'completed' }

      // Settle any pending calls that had no subsequent GENERIC step in this increment.
      if (outcomeInfo.outcome === 'completed') {
        for (const call of turn.pendingCalls) {
          if (call.isMemoryTool) {
            turn.sawMemoryTool = true
            if (call.isMemoryWrite) turn.explicitWrite = true
          } else {
            turn.sawNonMemoryTool = true
            if (call.targetPath !== undefined && FILE_TOOLS.has(call.name)) {
              turn.files.add(call.targetPath)
            }
            if (DELIVERY_TOOLS.has(call.name)) turn.delivered = true
            if (COMPLETION_TOOLS.has(call.name)) turn.explicitCompletion = true
          }
        }
      }
      turn.pendingCalls = []

      const pureMemoryTurn =
        turn.sawMemoryTool &&
        !turn.sawNonMemoryTool &&
        turn.files.size === 0 &&
        !turn.correction &&
        !turn.delivered &&
        !turn.explicitCompletion &&
        outcomeInfo.outcome !== 'error'

      const sourceSeqs = uniqueSortedSeqs(turn.seqs)
      const episodeInput: CaptureEpisodeInput = {
        kind: 'turn',
        sessionId: input.conversationId,
        workspaceKey,
        workspaceRoot: input.workspaceRoot,
        turn: turn.turnNumber,
        sourceSeqs,
        files: [...turn.files],
        outcome: outcomeInfo.outcome,
        delivered: turn.delivered,
        correction: turn.correction,
        explicitCompletion: turn.explicitCompletion,
        ...(input.subagent === true ? { subagent: true } : {}),
        ...(outcomeInfo.failureCode === undefined ? {} : { failureCode: outcomeInfo.failureCode }),
        ...(outcomeInfo.failureMessage === undefined
          ? {}
          : { failureMessage: outcomeInfo.failureMessage }),
        ...(turn.failures.length === 0
          ? {}
          : { toolFailures: turn.failures.map((f) => `${f.name}: ${f.code}`) }),
        ...(turn.prompt === undefined ? {} : { prompt: turn.prompt }),
        ...(turn.assistantFinal === undefined ? {} : { assistantFinal: turn.assistantFinal }),
        ...(turn.correctionText === undefined ? {} : { correctionText: turn.correctionText }),
      }

      let persistedRecord: EpisodeRecord | undefined
      const hasContent =
        !pureMemoryTurn &&
        (episodeInput.prompt !== undefined ||
          episodeInput.assistantFinal !== undefined ||
          episodeInput.files.length > 0 ||
          outcomeInfo.outcome !== 'completed')

      if (hasContent) {
        persistedRecord = await input.engine.appendEpisode({
          sessionId: episodeInput.sessionId,
          workspaceKey: episodeInput.workspaceKey,
          workspaceRoot: episodeInput.workspaceRoot,
          kind: 'turn',
          turn: episodeInput.turn,
          sourceSeqs: episodeInput.sourceSeqs,
          files: episodeInput.files,
          outcome: outcomeInfo.outcome,
          ...(episodeInput.prompt === undefined ? {} : { prompt: episodeInput.prompt }),
          ...(episodeInput.assistantFinal === undefined
            ? {}
            : { assistantFinal: episodeInput.assistantFinal }),
          ...(episodeInput.correctionText === undefined
            ? {}
            : { correctionText: episodeInput.correctionText }),
          ...(episodeInput.failureCode === undefined
            ? {}
            : { failureCode: episodeInput.failureCode }),
          ...(episodeInput.failureMessage === undefined
            ? {}
            : { failureMessage: episodeInput.failureMessage }),
        })
        if (persistedRecord !== undefined) episodesCreated += 1
      }

      if (
        turn.rememberText !== undefined &&
        turn.rememberSeq !== undefined &&
        !turn.explicitWrite &&
        !detectStrongSecret(turn.rememberText)
      ) {
        const memType: MemoryType = PREFERENCE_SIGNAL.test(turn.rememberText)
          ? 'preference'
          : 'lesson'
        const title = rememberTitle(turn.rememberText)
        const scope: MemoryScope = {
          kind: 'workspace',
          key: workspaceKey,
          root: input.workspaceRoot,
        }
        try {
          if (store.findActiveByTitle(scope, memType, title) === undefined) {
            await store.create({
              type: memType,
              title,
              body: turn.rememberText,
              scope,
              origin: 'system',
              ownership: 'user',
              status: 'active',
              importance: 0.5,
              sourceRefs: [
                {
                  sessionId: input.conversationId,
                  turn: turn.turnNumber,
                  eventSeq: turn.rememberSeq,
                },
              ],
              actor: 'system',
            })
            directMemoriesCreated += 1
            needsSearchSync = true
          }
        } catch {
          // Spoken remember capture must never block transcript capture.
        }
      }

      const worklogEligible =
        !pureMemoryTurn &&
        input.config.worklogCapture === 'significant' &&
        input.subagent !== true &&
        (!isFinalTurn || input.terminationReason !== 'USER_CANCELED') &&
        shouldCreateWorklog(episodeInput)

      if (worklogEligible) {
        const worklog = await createTurnWorklog(store, input.config, episodeInput, persistedRecord)
        if (worklog !== undefined) {
          worklogsCreated += 1
          needsSearchSync = true
        }
      }

      if (turn.assistantFinal !== undefined) {
        previousAssistantText = turn.assistantFinal
      }
    }

    let activeTurn: TurnDraft | undefined

    for (const step of steps) {
      if (step.type === 'USER_INPUT') {
        const extracted =
          step.content === undefined ? undefined : extractUserRequestText(step.content)
        const text = sanitize(extracted, MAX_CAPTURE_TEXT_BYTES)
        if (text === undefined || text.length === 0) continue

        if (activeTurn !== undefined) {
          await finalizeTurn(activeTurn, false)
          activeTurn = undefined
        }

        currentTurnNumber += 1
        activeTurn = createTurnDraft(currentTurnNumber)
        activeTurn.prompt = text
        activeTurn.promptSeq = step.stepIndex
        activeTurn.seqs.push(step.stepIndex)

        if (REMEMBER_SIGNAL.test(text) && !NEGATED_REMEMBER.test(text)) {
          activeTurn.rememberText = text
          activeTurn.rememberSeq = step.stepIndex
        }

        if (previousAssistantText !== undefined && CORRECTION_SIGNAL.test(text)) {
          activeTurn.correction = true
          activeTurn.correctionText = text
          const corrRecord = await input.engine.appendEpisode({
            sessionId: input.conversationId,
            workspaceKey,
            workspaceRoot: input.workspaceRoot,
            kind: 'user-correction',
            turn: activeTurn.turnNumber,
            sourceSeqs: [step.stepIndex],
            correctionText: text,
            assistantFinal: previousAssistantText,
          })
          if (corrRecord !== undefined) episodesCreated += 1
        } else if (previousAssistantText !== undefined && COMPLETION_SIGNAL.test(text)) {
          activeTurn.explicitCompletion = true
        }
        continue
      }

      if (step.type === 'PLANNER_RESPONSE') {
        if (activeTurn === undefined) {
          if (currentTurnNumber === 0) currentTurnNumber = 1
          activeTurn = createTurnDraft(currentTurnNumber)
        }
        activeTurn.seqs.push(step.stepIndex)

        if (step.content !== undefined && step.content.trim().length > 0) {
          const text = sanitize(step.content.trim(), MAX_CAPTURE_TEXT_BYTES)
          if (text !== undefined && text.length > 0) {
            activeTurn.assistantFinal = text
            activeTurn.assistantSeq = step.stepIndex
          }
        }

        if (step.toolCalls !== undefined) {
          for (const rawCall of step.toolCalls) {
            const call = resolveTranscriptToolCall(rawCall)
            if (call === undefined) continue
            if (call.isMemoryTool) {
              activeTurn.sawMemoryTool = true
            } else {
              activeTurn.sawNonMemoryTool = true
            }
            activeTurn.pendingCalls.push(call)
          }
        }
        continue
      }

      if (step.type === 'GENERIC') {
        if (activeTurn === undefined) {
          if (currentTurnNumber === 0) currentTurnNumber = 1
          activeTurn = createTurnDraft(currentTurnNumber)
        }
        const call = activeTurn.pendingCalls.shift() ?? {
          name: 'unknown',
          targetHash: hashOf(''),
          isMemoryTool: false,
          isMemoryWrite: false,
        }
        const inspected = inspectGenericStep(step)

        if (call.isMemoryTool) {
          activeTurn.sawMemoryTool = true
          if (call.isMemoryWrite && !inspected.isFailure) {
            activeTurn.explicitWrite = true
          }
          continue
        }

        activeTurn.sawNonMemoryTool = true
        activeTurn.seqs.push(step.stepIndex)

        if (inspected.isFailure) {
          const errorDetail = inspected.headerSummary ?? inspected.code
          const toolError =
            sanitize(`${call.name}: ${errorDetail}`, MAX_CAPTURE_TOOL_ERROR_BYTES) ??
            `${call.name}: ${inspected.code}`
          activeTurn.failures.push({
            name: call.name,
            targetHash: call.targetHash,
            code: inspected.code,
            seq: step.stepIndex,
            consumed: false,
          })
          const failRecord = await input.engine.appendEpisode({
            sessionId: input.conversationId,
            workspaceKey,
            workspaceRoot: input.workspaceRoot,
            kind: 'tool-failure',
            turn: activeTurn.turnNumber,
            sourceSeqs: [step.stepIndex],
            toolName: call.name,
            toolError,
          })
          if (failRecord !== undefined) episodesCreated += 1
        } else {
          const matchedFailure = activeTurn.failures.find(
            (entry) =>
              !entry.consumed && entry.name === call.name && entry.targetHash === call.targetHash,
          )
          if (matchedFailure !== undefined) {
            matchedFailure.consumed = true
            const recRecord = await input.engine.appendEpisode({
              sessionId: input.conversationId,
              workspaceKey,
              workspaceRoot: input.workspaceRoot,
              kind: 'tool-recovery',
              turn: activeTurn.turnNumber,
              sourceSeqs: [matchedFailure.seq, step.stepIndex],
              toolName: call.name,
            })
            if (recRecord !== undefined) episodesCreated += 1
          }
          if (call.targetPath !== undefined && FILE_TOOLS.has(call.name)) {
            activeTurn.files.add(call.targetPath)
          }
          if (DELIVERY_TOOLS.has(call.name)) activeTurn.delivered = true
          if (COMPLETION_TOOLS.has(call.name)) activeTurn.explicitCompletion = true
        }
      }
    }

    if (activeTurn !== undefined) {
      await finalizeTurn(activeTurn, true)
    }

    if (needsSearchSync) {
      input.engine.syncSearchIndex()
    }

    if (maxStepIndex >= 0 && maxStepIndex > cursor) {
      await input.domain.table('session_cursors').put(input.conversationId, {
        sessionId: input.conversationId,
        workspaceKey,
        lastProcessedSeq: maxStepIndex,
        lastProcessedAt: now().toISOString(),
      })
    }

    sessionUpdate = {
      conversationId: input.conversationId,
      workspaceRoot: existingSession?.workspaceRoot ?? input.workspaceRoot,
      scopeKey: existingSession?.scopeKey ?? workspaceKey,
      indexSources: existingSession?.indexSources ?? [],
      captureTurn: currentTurnNumber,
      ...(previousAssistantText === undefined ? {} : { previousAssistantText }),
    }
  })

  if (sessionUpdate !== undefined) {
    await input.sessionStore.write({
      ...sessionUpdate,
      updatedAt: now().toISOString(),
    })
  }

  return {
    processedSteps,
    episodesCreated,
    worklogsCreated,
    directMemoriesCreated,
    lastStepIndex,
  }
}
