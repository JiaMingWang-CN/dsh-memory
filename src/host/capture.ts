/**
 * Episode capture over `session/event` and `tools/result`.
 *
 * The capture pipeline keeps a small per-session state machine and turns each
 * committed event into a whitelisted, redacted episode summary. It never stores
 * raw tool arguments, raw tool output, environment variables, attachments,
 * images or reasoning; it never creates a `lesson` directly from a correction
 * candidate. `autoCaptureEpisodes=false` disables every automatic write.
 * @module memloom/host/capture
 */
import { createHash } from 'node:crypto'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { MemoryConfig } from './config.ts'
import { redactSecrets } from './redact.ts'
import type { MemoryStore } from './store.ts'
import type { EpisodeKind, EpisodeRecord, MemoryType } from '../shared/types.ts'
import { normalizeWorkspaceKey } from './workspace.ts'

/** Largest captured user prompt or assistant final, in UTF-8 bytes. */
export const MAX_CAPTURE_TEXT_BYTES = 4096
/** Largest captured tool error, in UTF-8 bytes. */
export const MAX_CAPTURE_TOOL_ERROR_BYTES = 1024

const CORRECTION_SIGNAL =
  /(不对|错了|不是|应该是|不要|别再|不是这个意思|wrong|incorrect|should be)/i

/** The user asked the agent to remember something for later. */
const REMEMBER_SIGNAL =
  /(记住|记下|记一下|记牢|别忘|不要忘|以后都|以后不要|从现在起|remember|don't forget|do not forget|from now on)/i
/** The remembered sentence states a stable preference rather than a one-off rule. */
const PREFERENCE_SIGNAL = /(以后|总是|习惯|偏好|每次|统一|always|never|prefer|from now on)/i
/** Negated forms such as "不要记住" must not trigger a write. */
const NEGATED_REMEMBER =
  /(?:(?:不要|别|不用|无需|不必)(?:再)?\s*(?:记住|记下|记一下|记牢)|(?:don't|do not|can't|cannot|never)\s+remember)/i
/** Explicit completion confirmations from the user after an assistant turn. */
const COMPLETION_SIGNAL =
  /(完成了|搞定了|已解决|没问题了|可以了|通过了|task complete|all done|resolved|looks good|lgtm)/i
const COMPLETION_TOOLS = new Set(['complete_task', 'finish_task', 'mark_done', 'goal_complete'])

const FILE_TOOLS = new Set([
  'write',
  'edit',
  'multi_edit',
  'apply_patch',
  'create_file',
  'delete',
  'move',
])
const DELIVERY_TOOLS = new Set(['present', 'deliver'])
const RUN_CODE_TOOL = 'run_code'
const MEMORY_TOOLS = new Set([
  'memory_search',
  'memory_read',
  'memory_write',
  'memory_forget',
  'memory_dream',
  'memory_organize',
])
const WHITELIST_ARG_KEYS = ['file_path', 'filePath', 'path', 'cwd', 'command', 'notebook_path']

/** Minimal payload shape of a `tool/ptc-dispatch` or `tool/ptc-dispatch-start` event. */
interface PtcDispatchPayload {
  name: string
  arguments?: unknown
  isError?: boolean
  error?: { code?: string; reason?: string }
}

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

/** One pending tool call in the current turn. */
interface PendingCall {
  name: string
  targetHash: string
  targetPath?: string
  step: number
}

/** One recorded tool failure in the current turn. */
interface Failure {
  name: string
  targetHash: string
  code: string
  seq: number
  consumed: boolean
}

/** Mutable state for one live session. */
interface SessionState {
  turn: number
  delegationDepth: number
  prompt?: string | undefined
  promptSeq?: number | undefined
  toolCalls: Map<string, PendingCall>
  failures: Failure[]
  assistantFinal?: string | undefined
  assistantSeq?: number | undefined
  files: Set<string>
  seqs: number[]
  delivered: boolean
  correction: boolean
  correctionText?: string | undefined
  explicitCompletion: boolean
  explicitWrite: boolean
  sawMemoryTool: boolean
  sawNonMemoryTool: boolean
  rememberText?: string | undefined
  rememberSeq?: number | undefined
  previousAssistantText?: string
}

/** Options for {@link MemoryCapture}. */
export interface MemoryCaptureOptions {
  store: MemoryStore
  config?: Partial<MemoryConfig> | null
  now?: () => Date
  /** Called after a turn episode is persisted (worklog generation hook). */
  onTurnEnd?: (input: CaptureEpisodeInput, record?: EpisodeRecord) => void | Promise<void>
  /** Host logger for dropped captures or failed spoken-memory writes. */
  logger?: { warn?: (message: string) => void }
}

/** Redact then byte-truncate one text field. */
function sanitize(text: string | undefined, maxBytes: number): string | undefined {
  if (text === undefined) return undefined
  const redacted = redactSecrets(text)
  return truncateUtf8(redacted, maxBytes)
}

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

/** Concatenate the text blocks of one message content array. */
function textOf(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
}

/** Parse whitelisted target fields out of raw tool-call arguments (JSON string or object). */
function whitelistedTarget(rawArguments: unknown): {
  targetHash: string
  targetPath?: string
} {
  let parsed: unknown = rawArguments
  if (typeof rawArguments === 'string') {
    try {
      parsed = JSON.parse(rawArguments)
    } catch {
      return { targetHash: hashOf('') }
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { targetHash: hashOf('') }
  }
  const record = parsed as Record<string, unknown>
  const picked: [string, string][] = []
  let targetPath: string | undefined
  for (const key of WHITELIST_ARG_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) {
      // Redact before hashing or storing so secrets never reach episode files.
      const redacted = redactSecrets(value)
      picked.push([key, redacted])
      if (
        targetPath === undefined &&
        (key === 'file_path' || key === 'filePath' || key === 'path')
      ) {
        targetPath = redacted
      }
    }
  }
  picked.sort((left, right) => left[0].localeCompare(right[0]))
  return {
    targetHash: hashOf(JSON.stringify(picked)),
    ...(targetPath === undefined ? {} : { targetPath }),
  }
}

function firstContentLine(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const item = block as { type?: unknown; text?: unknown }
    if (item.type !== 'text' || typeof item.text !== 'string') continue
    for (const rawLine of item.text.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (line !== '') return line
    }
  }
  return undefined
}

function asPtcDispatchPayload(data: unknown): PtcDispatchPayload | undefined {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined
  const record = data as Record<string, unknown>
  if (typeof record.name !== 'string' || record.name === '') return undefined
  const rawError = record.error
  let error: { code?: string; reason?: string } | undefined
  if (rawError !== null && typeof rawError === 'object' && !Array.isArray(rawError)) {
    const err = rawError as Record<string, unknown>
    error = {
      ...(typeof err.code === 'string' ? { code: err.code } : {}),
      ...(typeof err.reason === 'string' ? { reason: err.reason } : {}),
    }
  }
  const isError = typeof record.isError === 'boolean' ? record.isError : undefined
  if (isError === true && (error?.reason === undefined || error.reason.trim() === '')) {
    // Real DSH 0.2.2-rc.5 `tool/ptc-dispatch` failures carry the message in
    // `content` without a structured `error` field; keep only the sanitized first line.
    const summary = sanitize(firstContentLine(record.content), MAX_CAPTURE_TOOL_ERROR_BYTES)
    if (summary !== undefined && summary !== '') {
      error = { ...(error ?? {}), reason: summary }
    }
  }
  return {
    name: record.name,
    arguments: record.arguments,
    ...(isError === undefined ? {} : { isError }),
    ...(error === undefined ? {} : { error }),
  }
}

function hashOf(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * Episode capture state machine. One instance is owned by the memory service
 * and fed by the `session/event` and `tools/result` host events.
 */
export class MemoryCapture {
  private readonly store: MemoryStore
  private readonly enabled: boolean
  private readonly onTurnEnd:
    ((input: CaptureEpisodeInput, record?: EpisodeRecord) => void | Promise<void>) | undefined
  private readonly states = new Map<string, SessionState>()
  private readonly logger: { warn?: (message: string) => void } | undefined
  private chain: Promise<void> = Promise.resolve()

  constructor(options: MemoryCaptureOptions) {
    this.store = options.store
    this.enabled = options.config?.autoCaptureEpisodes !== false
    this.onTurnEnd = options.onTurnEnd
    this.logger = options.logger
  }

  /** Wait for queued capture writes (test and shutdown support). */
  async flush(): Promise<void> {
    await this.chain
    await this.store.flush()
  }

  private enqueue(work: () => Promise<void>): void {
    this.chain = this.chain.then(work).catch(() => undefined)
  }

  private stateOf(session: Session): SessionState {
    const id = session.id
    let state = this.states.get(id)
    if (state === undefined) {
      state = {
        turn: 0,
        delegationDepth: session.header.delegationDepth ?? 0,
        toolCalls: new Map(),
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
      this.states.set(id, state)
    }
    return state
  }

  private workspaceOf(session: Session): { key: string; root: string } | undefined {
    const cwd = session.header.cwd
    if (cwd === undefined || cwd === '') return undefined
    return { key: normalizeWorkspaceKey(cwd), root: cwd }
  }

  /**
   * Handle one committed session event.
   * @param session - Session that produced the event.
   * @param event - Committed event.
   */
  onSessionEvent(session: Session, event: SessionEvent): void {
    const state = this.stateOf(session)
    if (!this.enabled) {
      if (event.type === 'turn/end') this.resetTurn(state)
      return
    }
    switch (event.type as string) {
      case 'turn/start':
        state.turn = (event as SessionEvent<'turn/start'>).data.turn
        break
      case 'user/message':
        this.onUserMessage(session, state, event as SessionEvent<'user/message'>)
        break
      case 'tool/call':
        this.onToolCall(state, event as SessionEvent<'tool/call'>)
        break
      case 'tool/result':
        this.onToolResultEvent(session, state, event as SessionEvent<'tool/result'>)
        break
      case 'tool/ptc-dispatch-start':
        this.onPtcDispatchStart(state, event.data)
        break
      case 'tool/ptc-dispatch':
        this.onPtcDispatch(session, state, event.seq, event.data)
        break
      case 'assistant/message':
        this.onAssistantMessage(state, event as SessionEvent<'assistant/message'>)
        break
      case 'turn/end':
        this.onTurnEndEvent(session, state, event as SessionEvent<'turn/end'>)
        break
      default:
        break
    }
  }

  /**
   * Handle one `tools/result` host event. Tracks `memory_*` invocations so
   * a successful explicit `memory_write` suppresses duplicate spoken "remember"
   * proposals in the same turn.
   * @param exec - Executed tool call.
   * @param result - Tool outcome.
   */
  onToolResult(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): void {
    if (!this.enabled) return
    if (!MEMORY_TOOLS.has(exec.name)) return
    const agentId = exec.agent?.id
    if (agentId === undefined) return
    const state = this.states.get(agentId)
    if (state === undefined) return
    state.sawMemoryTool = true
    if (exec.name === 'memory_write' && result.isError === false) state.explicitWrite = true
  }

  private onUserMessage(
    session: Session,
    state: SessionState,
    event: SessionEvent<'user/message'>,
  ): void {
    const message = event.data
    if (message.source.kind !== 'user') return
    const text = sanitize(textOf(message.content), MAX_CAPTURE_TEXT_BYTES)
    if (text === undefined || text === '') return
    if (state.turn === 0) state.turn = 1
    state.prompt = text
    state.promptSeq = event.seq
    state.seqs.push(event.seq)
    if (
      state.rememberText === undefined &&
      REMEMBER_SIGNAL.test(text) &&
      !NEGATED_REMEMBER.test(text)
    ) {
      state.rememberText = text
      state.rememberSeq = event.seq
    }
    const previousAssistantText = state.previousAssistantText
    if (previousAssistantText !== undefined && CORRECTION_SIGNAL.test(text)) {
      state.correction = true
      state.correctionText = text
      const workspace = this.workspaceInput(session)
      if (workspace.workspaceKey === '') return
      // Snapshot the turn before the queued write: turn/end resets the live state.
      const turn = state.turn
      // A correction only forms a candidate episode; it never writes a lesson.
      this.enqueue(async () => {
        await this.store.appendEpisode({
          ...workspace,
          kind: 'user-correction',
          turn,
          sourceSeqs: [event.seq],
          correctionText: text,
          assistantFinal: previousAssistantText,
        })
      })
    } else if (previousAssistantText !== undefined && COMPLETION_SIGNAL.test(text)) {
      state.explicitCompletion = true
    }
  }

  private onToolCall(state: SessionState, event: SessionEvent<'tool/call'>): void {
    const { callId, name, arguments: argumentsText, step } = event.data
    state.seqs.push(event.seq)
    if (name === RUN_CODE_TOOL || MEMORY_TOOLS.has(name)) {
      if (MEMORY_TOOLS.has(name)) state.sawMemoryTool = true
      state.toolCalls.set(String(callId), {
        name,
        targetHash: hashOf(''),
        step,
      })
      return
    }
    state.sawNonMemoryTool = true
    const target = whitelistedTarget(argumentsText)
    state.toolCalls.set(String(callId), {
      name,
      targetHash: target.targetHash,
      ...(target.targetPath === undefined ? {} : { targetPath: target.targetPath }),
      step,
    })
  }

  private onToolResultEvent(
    session: Session,
    state: SessionState,
    event: SessionEvent<'tool/result'>,
  ): void {
    const data = event.data
    const callId = String(data.message.source.callId)
    const call = state.toolCalls.get(callId)
    const name = call?.name ?? data.error?.name ?? 'unknown'
    const isError = data.message.isError === true || data.error !== undefined
    this.handleSettledTool(session, state, {
      name,
      targetHash: call?.targetHash ?? hashOf(''),
      ...(call?.targetPath === undefined ? {} : { targetPath: call.targetPath }),
      seq: event.seq,
      isError,
      ...(data.error === undefined ? {} : { error: data.error }),
    })
  }

  private onPtcDispatchStart(state: SessionState, rawData: unknown): void {
    const payload = asPtcDispatchPayload(rawData)
    if (payload === undefined) return
    if (MEMORY_TOOLS.has(payload.name)) {
      state.sawMemoryTool = true
      return
    }
    if (payload.name !== RUN_CODE_TOOL) state.sawNonMemoryTool = true
  }

  private onPtcDispatch(
    session: Session,
    state: SessionState,
    seq: number,
    rawData: unknown,
  ): void {
    const payload = asPtcDispatchPayload(rawData)
    if (payload === undefined) return
    const isError = payload.isError === true || payload.error !== undefined
    if (payload.name === RUN_CODE_TOOL || MEMORY_TOOLS.has(payload.name)) {
      this.handleSettledTool(session, state, {
        name: payload.name,
        targetHash: hashOf(''),
        seq,
        isError,
        ...(payload.error === undefined ? {} : { error: payload.error }),
      })
      return
    }
    state.seqs.push(seq)
    const target = whitelistedTarget(payload.arguments)
    this.handleSettledTool(session, state, {
      name: payload.name,
      targetHash: target.targetHash,
      ...(target.targetPath === undefined ? {} : { targetPath: target.targetPath }),
      seq,
      isError,
      ...(payload.error === undefined ? {} : { error: payload.error }),
    })
  }

  private handleSettledTool(
    session: Session,
    state: SessionState,
    input: {
      name: string
      targetHash: string
      targetPath?: string
      seq: number
      isError: boolean
      error?: { code?: string; reason?: string }
    },
  ): void {
    // Ignore the PTC transport wrapper and all memory_* tools so plugin errors
    // or recoveries never pollute project tool-failure / tool-recovery episodes.
    if (input.name === RUN_CODE_TOOL) return
    if (MEMORY_TOOLS.has(input.name)) {
      state.sawMemoryTool = true
      if (!input.isError && input.name === 'memory_write') state.explicitWrite = true
      return
    }
    state.sawNonMemoryTool = true
    if (input.isError) {
      this.recordFailure(session, state, input)
      return
    }
    this.recordSuccess(session, state, input)
  }

  private recordFailure(
    session: Session,
    state: SessionState,
    input: {
      name: string
      targetHash: string
      seq: number
      error?: { code?: string; reason?: string }
    },
  ): void {
    const code = input.error?.code ?? 'UNKNOWN'
    const errorText =
      sanitize(
        `${input.name}: ${code}${input.error?.reason === undefined ? '' : ` ${input.error.reason}`}`,
        MAX_CAPTURE_TOOL_ERROR_BYTES,
      ) ?? `${input.name}: ${code}`
    state.failures.push({
      name: input.name,
      targetHash: input.targetHash,
      code,
      seq: input.seq,
      consumed: false,
    })
    state.seqs.push(input.seq)
    const workspace = this.workspaceInput(session)
    if (workspace.workspaceKey === '') return
    // Snapshot the turn before the queued write: turn/end resets the live state.
    const turn = state.turn
    this.enqueue(async () => {
      await this.store.appendEpisode({
        ...workspace,
        kind: 'tool-failure',
        turn,
        sourceSeqs: [input.seq],
        toolName: input.name,
        toolError: errorText,
      })
    })
  }

  private recordSuccess(
    session: Session,
    state: SessionState,
    input: {
      name: string
      targetHash: string
      targetPath?: string
      seq: number
    },
  ): void {
    // Success: a matching earlier failure with the same tool and target becomes
    // a recovery episode. Different target or tool never infers "fixed".
    const failure = state.failures.find(
      (entry) =>
        !entry.consumed && entry.name === input.name && entry.targetHash === input.targetHash,
    )
    if (failure !== undefined) {
      failure.consumed = true
      state.seqs.push(input.seq)
      const workspace = this.workspaceInput(session)
      if (workspace.workspaceKey !== '') {
        // Snapshot the turn and failure seq: both live state and the failure list
        // are reset by turn/end before the queued write runs.
        const turn = state.turn
        const failureSeq = failure.seq
        this.enqueue(async () => {
          await this.store.appendEpisode({
            ...workspace,
            kind: 'tool-recovery',
            turn,
            sourceSeqs: [failureSeq, input.seq],
            toolName: input.name,
          })
        })
      }
    }
    if (input.targetPath !== undefined && FILE_TOOLS.has(input.name)) {
      state.files.add(input.targetPath)
    }
    if (DELIVERY_TOOLS.has(input.name)) state.delivered = true
    if (COMPLETION_TOOLS.has(input.name)) state.explicitCompletion = true
  }

  private onAssistantMessage(state: SessionState, event: SessionEvent<'assistant/message'>): void {
    const text = sanitize(textOf(event.data.message.content), MAX_CAPTURE_TEXT_BYTES)
    if (text === undefined || text === '') return
    state.assistantFinal = text
    state.assistantSeq = event.seq
    state.seqs.push(event.seq)
  }

  private onTurnEndEvent(
    session: Session,
    state: SessionState,
    event: SessionEvent<'turn/end'>,
  ): void {
    const reason = event.data.reason
    const outcome = reason.kind
    // A spoken "remember" is only persisted when the model did not already do it
    // explicitly in this turn.
    const rememberText = state.rememberText
    const rememberSeq = state.rememberSeq
    const explicitWrite = state.explicitWrite
    const pureMemoryTurn =
      state.sawMemoryTool &&
      !state.sawNonMemoryTool &&
      state.files.size === 0 &&
      !state.correction &&
      !state.delivered &&
      !state.explicitCompletion &&
      outcome !== 'error'
    const input: CaptureEpisodeInput = {
      kind: 'turn',
      ...this.workspaceInput(session),
      turn: state.turn === 0 ? event.data.turn : state.turn,
      sourceSeqs: uniqueSeqs(state.seqs, event.seq),
      files: [...state.files],
      outcome,
      delivered: state.delivered,
      correction: state.correction,
      explicitCompletion: state.explicitCompletion,
      ...(state.delegationDepth > 0 ? { subagent: true } : {}),
      ...(reason.kind === 'error'
        ? {
            failureCode: reason.error.code,
            failureMessage:
              sanitize(reason.error.message, MAX_CAPTURE_TOOL_ERROR_BYTES) ?? reason.error.message,
          }
        : {}),
      ...(state.failures.length === 0
        ? {}
        : { toolFailures: state.failures.map((failure) => `${failure.name}: ${failure.code}`) }),
      ...(state.prompt === undefined ? {} : { prompt: state.prompt }),
      ...(state.assistantFinal === undefined ? {} : { assistantFinal: state.assistantFinal }),
      ...(state.correctionText === undefined ? {} : { correctionText: state.correctionText }),
    }
    if (state.assistantFinal !== undefined) {
      state.previousAssistantText = state.assistantFinal
    }
    this.resetTurn(state)
    if (input.workspaceKey === '') return
    this.enqueue(async () => {
      const hasContent =
        !pureMemoryTurn &&
        (input.prompt !== undefined ||
          input.assistantFinal !== undefined ||
          input.files.length > 0 ||
          outcome !== 'completed')
      let record: EpisodeRecord | undefined
      if (hasContent) {
        record = await this.store.appendEpisode({
          sessionId: input.sessionId,
          workspaceKey: input.workspaceKey,
          workspaceRoot: input.workspaceRoot,
          kind: 'turn',
          turn: input.turn,
          sourceSeqs: input.sourceSeqs,
          files: input.files,
          outcome,
          ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
          ...(input.assistantFinal === undefined ? {} : { assistantFinal: input.assistantFinal }),
          ...(input.correctionText === undefined ? {} : { correctionText: input.correctionText }),
          ...(input.failureCode === undefined ? {} : { failureCode: input.failureCode }),
          ...(input.failureMessage === undefined ? {} : { failureMessage: input.failureMessage }),
        })
      }
      if (rememberText !== undefined && rememberSeq !== undefined && !explicitWrite) {
        await this.remember(input, rememberText, rememberSeq)
      }
      if (!pureMemoryTurn && this.onTurnEnd !== undefined) await this.onTurnEnd(input, record)
    })
  }

  private resetTurn(state: SessionState): void {
    state.turn = 0
    state.prompt = undefined
    state.promptSeq = undefined
    state.toolCalls.clear()
    state.failures = []
    state.assistantFinal = undefined
    state.assistantSeq = undefined
    state.files.clear()
    state.seqs = []
    state.delivered = false
    state.correction = false
    state.correctionText = undefined
    state.explicitCompletion = false
    state.explicitWrite = false
    state.sawMemoryTool = false
    state.sawNonMemoryTool = false
    state.rememberText = undefined
    state.rememberSeq = undefined
  }

  /**
   * Persist one spoken "remember" request as an active memory.
   *
   * A wording like "以后都" becomes a workspace preference; everything else is a
   * lesson. A successful explicit `memory_write` in the same turn suppresses
   * this write, and an existing active record with the same title is reused.
   */
  private async remember(input: CaptureEpisodeInput, text: string, seq: number): Promise<void> {
    const type: MemoryType = PREFERENCE_SIGNAL.test(text) ? 'preference' : 'lesson'
    const title = rememberTitle(text)
    const scope = {
      kind: 'workspace' as const,
      key: input.workspaceKey,
      root: input.workspaceRoot,
    }
    try {
      if (this.store.findActiveByTitle(scope, type, title) !== undefined) return
      await this.store.create({
        type,
        title,
        body: text,
        scope,
        origin: 'system',
        ownership: 'user',
        status: 'active',
        importance: 0.5,
        sourceRefs: [{ sessionId: input.sessionId, turn: input.turn, eventSeq: seq }],
        actor: 'system',
      })
    } catch (error) {
      const message = `[memloom] failed to store a spoken remember request: ${
        error instanceof Error ? error.message : String(error)
      }`
      if (this.logger?.warn !== undefined) this.logger.warn(message)
      else console.warn(message)
    }
  }

  /** Workspace fields for one episode write; empty key means "skip". */
  private workspaceInput(session: Session): {
    sessionId: string
    workspaceKey: string
    workspaceRoot: string
  } {
    const workspace = this.workspaceOf(session)
    return {
      sessionId: session.id,
      workspaceKey: workspace?.key ?? '',
      workspaceRoot: workspace?.root ?? '',
    }
  }
}

/** Keep the first turn seq plus the turn-end seq, de-duplicated and sorted. */
function uniqueSeqs(seqs: readonly number[], endSeq: number): number[] {
  const set = new Set<number>([...seqs, endSeq])
  return [...set].sort((left, right) => left - right)
}

/** Bounded, markdown-free title from one remembered sentence. */
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
