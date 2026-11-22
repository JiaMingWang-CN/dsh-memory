/**
 * In-memory stand-in for `ctx.storageDomain` used by unit and integration
 * tests. It validates every stored record with the domain spec's zod schema,
 * mirroring the durable boundary of the real facility, and keeps table data
 * per domain name so a closed-then-reopened domain reloads existing records.
 */
import { Context } from '@deepseek-ai/cordis'
import type { DomainSpec } from '@deepseek-ai/dsh-storage-domain'
import { ToolsService } from '@deepseek-ai/dsh-tools'

type Store = Map<string, unknown>

class FakeTable {
  constructor(
    private readonly store: Store,
    private readonly schema: { parse(value: unknown): unknown },
    private readonly isClosed: () => boolean,
  ) {}

  private assertOpen(): void {
    if (this.isClosed()) throw new Error('closed: memory domain is closed')
  }

  get(key: string): unknown {
    this.assertOpen()
    return this.store.get(key)
  }

  entries(): IterableIterator<[string, unknown]> {
    this.assertOpen()
    return [...this.store.entries()][Symbol.iterator]()
  }

  keys(): IterableIterator<string> {
    this.assertOpen()
    return [...this.store.keys()][Symbol.iterator]()
  }

  get size(): number {
    this.assertOpen()
    return this.store.size
  }

  async put(key: string, value: unknown): Promise<void> {
    this.assertOpen()
    this.store.set(key, this.schema.parse(value))
  }

  async delete(key: string): Promise<boolean> {
    this.assertOpen()
    return this.store.delete(key)
  }

  async deleteMany(keys: readonly string[]): Promise<number> {
    this.assertOpen()
    let removed = 0
    for (const key of new Set(keys)) {
      if (this.store.delete(key)) removed += 1
    }
    return removed
  }

  async update(key: string, fn: (current: unknown) => unknown): Promise<unknown> {
    this.assertOpen()
    if (!this.store.has(key)) throw new Error(`missing-key: ${key}`)
    const next = this.schema.parse(fn(this.store.get(key)))
    this.store.set(key, next)
    return next
  }
}

/** Fake domain facility with persistent per-domain table data. */
export class FakeDomainFacility {
  private readonly data = new Map<string, Map<string, Store>>()
  private readonly openNames = new Set<string>()

  async open(spec: DomainSpec): Promise<unknown> {
    if (this.openNames.has(spec.name)) {
      throw new Error(`already-open: ${spec.name}`)
    }
    this.openNames.add(spec.name)
    let domainData = this.data.get(spec.name)
    if (domainData === undefined) {
      domainData = new Map()
      this.data.set(spec.name, domainData)
    }
    const tables = new Map<string, FakeTable>()
    let closed = false
    for (const [name, tableSpec] of Object.entries(spec.tables)) {
      let store = domainData.get(name)
      if (store === undefined) {
        store = new Map()
        domainData.set(name, store)
      }
      tables.set(name, new FakeTable(store, tableSpec.valueSchema, () => closed))
    }
    return {
      name: spec.name,
      table(name: string): FakeTable {
        const table = tables.get(name)
        if (table === undefined) throw new Error(`no-table: ${name}`)
        return table
      },
      get global(): never {
        throw new Error('no-global')
      },
      close: async (): Promise<void> => {
        closed = true
        this.openNames.delete(spec.name)
      },
    }
  }
}

/** A minimal command registry mirroring the production register/find/execute. */
export class FakeCommands {
  private readonly definitions = new Map<string, Record<string, unknown>>()

  register(definition: Record<string, unknown>): () => void {
    const name = definition.name as string
    this.definitions.set(name, definition)
    return () => {
      this.definitions.delete(name)
    }
  }

  find(_agent: unknown, name: string): Record<string, unknown> | undefined {
    return this.definitions.get(name)
  }

  list(_agent: unknown): Record<string, unknown>[] {
    return [...this.definitions.values()].map((definition) => ({
      name: definition.name,
      description: definition.description,
      definitionId: definition.definitionId,
      input: definition.input,
    }))
  }

  async execute(
    agent: unknown,
    line: string,
  ): Promise<{ commandId: string; result: unknown } | undefined> {
    const match = /^\/([^\s]+)\s*(.*)$/.exec(line.trim())
    if (match === null) return undefined
    const definition = this.definitions.get(match[1]!)
    if (definition === undefined) return undefined
    const handler = definition.handler as (invocation: unknown) => unknown
    const result = await handler({
      commandId: 'cmd-1',
      agent,
      rawInput: (match[2] ?? '').trim(),
      attachments: [],
      signal: new AbortController().signal,
    })
    return { commandId: 'cmd-1', result }
  }
}

/** A Cordis context with a fake `storageDomain` service provided. */
export interface FakeHost {
  ctx: Context
  facility: FakeDomainFacility
  commands: FakeCommands
}

/** Optional behaviour for {@link createFakeHost}. */
export interface FakeHostOptions {
  /** Resolve an Agent's effective working directory; defaults to `C:/ws/a`. */
  workingDirectory?: (agent: unknown) => string | Promise<string>
  /** Optional session-query stub used by cold-backfill wiring tests. */
  sessionQuery?: unknown
  /** Reuse an existing facility so tests can simulate a process restart. */
  facility?: FakeDomainFacility
  /** Optional LLM service exposed as `ctx.llm`. */
  llm?: unknown
}

/**
 * Build a fake Host context whose `ctx.storageDomain` is the in-memory facility
 * and whose `ctx.tools` is a real {@link ToolsService} (with a stub system
 * prompt), so tool registration exercises the production registry.
 * @param options - Optional working-directory resolver.
 * @returns The context plus its facility for state inspection.
 */
export function createFakeHost(options: FakeHostOptions = {}): FakeHost {
  const ctx = new Context()
  const facility = options.facility ?? new FakeDomainFacility()
  const provide = (ctx as unknown as { provide(name: string, value: unknown): void }).provide.bind(
    ctx,
  )
  provide('storageDomain', facility)
  // The tool registry renders its prompt section through `ctx.systemPrompt`; a
  // minimal stub is enough for tests that never assemble a real prompt.
  provide('systemPrompt', {
    tools: () => () => {},
    section: () => () => {},
    context: () => () => {},
    variable: () => () => {},
    suppressRuntimeContext: () => () => {},
    getSectionOrder: () => 0,
    getContextOrder: () => 0,
    refreshContext: (assembly: unknown) => assembly,
    assemble: async () => ({}),
  })
  new ToolsService(ctx)
  const commands = new FakeCommands()
  provide('commands', commands)
  const ensure = options.workingDirectory ?? (() => 'C:/ws/a')
  provide('workingDirectory', {
    ensure: (agent: unknown) => Promise.resolve(ensure(agent)),
  })
  // The MemoryService declares the full design inject set; unit/plugin tests
  // provide inert stubs for the services that this plan does not read yet.
  for (const name of ['agents', 'agentDefaultModel']) {
    provide(name, {})
  }
  provide('sessionQuery', options.sessionQuery ?? {})
  provide('llm', options.llm ?? {})
  // The Host registers its Remote descriptors through `ctx.typert`; the real
  // runtime provides this registry, so the fake host does too.
  provide('typert', { register: () => () => {} })
  return { ctx, facility, commands }
}
