/**
 * Synthetic session / event builders for the capture tests.
 */
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

export interface FakeCaptureSession {
  id: string
  header: { cwd?: string; delegationDepth?: number }
}

/** Build a minimal live session shape the capture state machine reads. */
export function captureSession(
  id = 's1',
  cwd: string | undefined = 'C:/ws/a',
  delegationDepth = 0,
): Session {
  const header: FakeCaptureSession['header'] = cwd === undefined ? {} : { cwd }
  if (delegationDepth > 0) header.delegationDepth = delegationDepth
  const session: FakeCaptureSession = { id, header }
  return session as unknown as Session
}

function event<T extends string>(type: T, seq: number, data: unknown): SessionEvent {
  return { type, seq, time: seq, data } as unknown as SessionEvent
}

export function turnStart(seq: number, turn: number): SessionEvent {
  return event('turn/start', seq, { turn })
}

export function userMessage(seq: number, text: string): SessionEvent {
  return event('user/message', seq, {
    role: 'user',
    id: `u${seq}`,
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  })
}

export function assistantMessage(seq: number, text: string, turn = 1, step = 1): SessionEvent {
  return event('assistant/message', seq, {
    turn,
    step,
    message: {
      role: 'assistant',
      id: `a${seq}`,
      source: { kind: 'model', provider: 'p', model: 'm' },
      content: [{ type: 'text', text }],
    },
    stream: [],
  })
}

export function toolCall(
  seq: number,
  input: { callId: string; name: string; arguments: string; turn?: number; step?: number },
): SessionEvent {
  return event('tool/call', seq, {
    turn: input.turn ?? 1,
    step: input.step ?? 1,
    callId: input.callId,
    name: input.name,
    arguments: input.arguments,
  })
}

export function toolResult(
  seq: number,
  input: {
    callId: string
    text?: string
    isError?: boolean
    error?: { name: string; code: string; reason?: string }
    turn?: number
    step?: number
  },
): SessionEvent {
  return event('tool/result', seq, {
    turn: input.turn ?? 1,
    step: input.step ?? 1,
    message: {
      role: 'tool',
      id: `t${seq}`,
      source: { kind: 'tool', callId: input.callId },
      toolCallId: input.callId,
      content: [{ type: 'text', text: input.text ?? 'done' }],
      ...(input.isError === undefined ? {} : { isError: input.isError }),
    },
    ...(input.error === undefined ? {} : { error: input.error }),
  })
}

export function turnEnd(
  seq: number,
  reasonKind = 'completed',
  turn = 1,
  failure?: { code: string; message: string; status?: number },
): SessionEvent {
  const reason =
    reasonKind === 'completed'
      ? { kind: 'completed' }
      : reasonKind === 'blocked'
        ? { kind: 'blocked' }
        : reasonKind === 'interrupted'
          ? { kind: 'interrupted' }
          : reasonKind === 'error'
            ? {
                kind: 'error',
                error: failure ?? { code: 'MODEL_UNAVAILABLE', message: 'model call failed' },
              }
            : { kind: 'interrupted' }
  return event('turn/end', seq, { turn, reason })
}
