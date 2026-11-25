import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileMemoryDomain } from '../../src/agy/storage.ts'
import { MemoryId, type MemoryRecord } from '../../src/shared/types.ts'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-agy-concurrency-'))
  tempDirs.push(dir)
  return dir
}

function runWorker(storePath: string, workerIndex: number, count: number): Promise<void> {
  const storageUrl = pathToFileURL(join(process.cwd(), 'src/agy/storage.ts')).href
  const contractUrl = pathToFileURL(join(process.cwd(), 'src/core/storage-contract.ts')).href
  const typesUrl = pathToFileURL(join(process.cwd(), 'src/shared/types.ts')).href

  const script = `
    import { FileMemoryDomain } from ${JSON.stringify(storageUrl)};
    import { contentDigest } from ${JSON.stringify(contractUrl)};
    import { MemoryId } from ${JSON.stringify(typesUrl)};

    const storePath = process.argv[1];
    const worker = Number(process.argv[2]);
    const count = Number(process.argv[3]);
    const domain = await FileMemoryDomain.open({ storePath, lockTimeoutMs: 10000 });
    for (let i = 0; i < count; i += 1) {
      const id = \`w\${worker}-m\${i}\`;
      const base = {
        id: MemoryId(id),
        type: 'lesson',
        scope: { kind: 'workspace', key: 'c:/ws/concurrent', root: 'C:/ws/concurrent' },
        origin: 'user',
        ownership: 'user',
        pinned: false,
        title: \`Title \${id}\`,
        body: \`Body \${id}\`,
        tags: [],
        status: 'active',
        confidence: 0.9,
        importance: 0.8,
        contentRevision: 1,
        statsRevision: 0,
        createdAt: '2026-11-25T00:00:00.000Z',
        updatedAt: '2026-11-25T00:00:00.000Z',
        matchCount: 0,
        useCount: 0,
        sourceRefs: [],
        sourceEpisodeIds: [],
        supersedes: [],
      };
      const record = { ...base, contentHash: contentDigest(base) };
      await domain.withWriteLock(async () => {
        await domain.table('memories').put(record.id, record);
      });
    }
  `

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '-e',
        script,
        storePath,
        String(workerIndex),
        String(count),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Worker ${workerIndex} exited with code ${code}: ${stderr}`))
    })
  })
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('FileMemoryDomain multi-process concurrency and reload', () => {
  it('serializes 4 concurrent Node child processes writing 5 records each with zero lost writes and notifies onReload', async () => {
    const dir = makeTempDir()
    const storePath = join(dir, 'memory.json')
    const onReload = vi.fn()

    const reader = await FileMemoryDomain.open({ storePath, onReload })
    expect(reader.table('memories').size).toBe(0)

    await Promise.all([
      runWorker(storePath, 0, 5),
      runWorker(storePath, 1, 5),
      runWorker(storePath, 2, 5),
      runWorker(storePath, 3, 5),
    ])

    const changed = await reader.syncFromDiskIfChanged()
    expect(changed).toBe(true)
    expect(onReload).toHaveBeenCalledTimes(1)
    expect(reader.table('memories').size).toBe(20)

    for (let w = 0; w < 4; w += 1) {
      for (let i = 0; i < 5; i += 1) {
        const rec: MemoryRecord | undefined = reader.table('memories').get(MemoryId(`w${w}-m${i}`))
        expect(rec?.title).toBe(`Title w${w}-m${i}`)
      }
    }

    const unchanged = await reader.syncFromDiskIfChanged()
    expect(unchanged).toBe(false)
    expect(onReload).toHaveBeenCalledTimes(1)
  }, 20_000)
})
