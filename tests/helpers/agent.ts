/**
 * Fake Agent / Session / Inbox used by the index-injection tests.
 *
 * The real agent runtime is driven by the loop; these fakes expose just the
 * durable surface, the pending inbox and the `followup` spy the injector reads,
 * so a test can call the pre-step handler directly without booting a driver.
 */
import { vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Message, UserMessage } from '@deepseek-ai/dsh-llm'
import type { InboxTarget } from '@deepseek-ai/dsh-agent'

class FakeInbox {
  nextTurn: UserMessage[] = []
  nextStep: UserMessage[] = []

  private list(target: InboxTarget): UserMessage[] {
    return target === 'next-step' ? this.nextStep : this.nextTurn
  }

  append(target: InboxTarget, message: UserMessage): void {
    this.list(target).push(message)
  }

  prepend(target: InboxTarget, message: UserMessage): void {
    this.list(target).unshift(message)
  }

  replace(messageId: string, message: UserMessage): boolean {
    for (const list of [this.nextStep, this.nextTurn]) {
      const index = list.findIndex((entry) => entry.id === messageId)
      if (index >= 0) {
        list[index] = message
        return true
      }
    }
    return false
  }

  remove(messageId: string): boolean {
    for (const list of [this.nextStep, this.nextTurn]) {
      const index = list.findIndex((entry) => entry.id === messageId)
      if (index >= 0) {
        list.splice(index, 1)
        return true
      }
    }
    return false
  }

  splice(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
  ): UserMessage[] {
    return this.list(target).splice(start, deleteCount, ...inserted)
  }

  clear(): void {
    this.nextStep = []
    this.nextTurn = []
  }
}

export interface FakeAgentOptions {
  messages?: Message[]
  delegationDepth?: number
  id?: string
}

/** A fake agent with a durable surface, an inbox and a `followup` spy. */
export interface FakeAgent {
  agent: Agent
  session: {
    header: { delegationDepth?: number }
    messages: Message[]
    deriveMessages(): Message[]
  }
  inbox: FakeInbox
  followup: ReturnType<typeof vi.fn>
}

/**
 * Build a fake agent whose session surface is the supplied message list.
 * @param options - Seed messages, delegation depth and session id.
 * @returns The agent plus the mutable surface, inbox and follow-up spy.
 */
export function makeFakeAgent(options: FakeAgentOptions = {}): FakeAgent {
  const session = {
    header: { delegationDepth: options.delegationDepth ?? 0 },
    messages: [...(options.messages ?? [])],
    deriveMessages(): Message[] {
      return [...session.messages]
    },
  }
  const inbox = new FakeInbox()
  const followup = vi.fn()
  const agent = {
    id: options.id ?? 'session-1',
    session,
    inbox,
    followup,
  } as unknown as Agent
  return { agent, session, inbox, followup }
}

/** Record one synthetic `dsh-memory` user message onto a fake surface. */
export function appendMemoryMessage(fake: FakeAgent, message: UserMessage): void {
  fake.session.messages.push(message)
}
