/**
 * Shared Typert Remote definition for the `memory` namespace.
 *
 * Both halves consume this one spec: the Host registers the descriptors under
 * its own `ctx.typert` so the Gateway resolves a strict definition instead of
 * the conservative source-mode fallback, and the Client mounts the same
 * contribution so `ctx.remote.memory.*` exists in the browser. Keeping the
 * endpoint list, parameter names and Host implementation members in one place
 * prevents the two faces from drifting apart.
 *
 * Codecs are deliberately permissive (`z.unknown()`): the Host owns domain
 * validation, and the wire only needs JSON-safe values plus an exact parameter
 * shape (`{ request }` / `{ input }`) that the Gateway matches with
 * `assertExactArguments`.
 * @module dsh-memory/remote-spec
 */
import { z } from 'zod'
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import type {
  TypertRemoteCodecSpec,
  TypertRemoteInfo,
  TypertRemoteMethodSpec,
  TypertRemoteParameterSpec,
  TypertRemoteSpec,
} from '@deepseek-ai/dsh-typert-protocol'

const codec = (): TypertRemoteCodecSpec => ({
  mode: 'strict',
  typeSymbol: 'dsh-memory/wire',
  create: () => z.unknown(),
})

const parameter = (name: string): TypertRemoteParameterSpec => ({
  name,
  source: 'json',
  codec: codec(),
  strictCodec: codec(),
})

/**
 * Build one direct endpoint.
 * @param implementation - Public instance member on the Host `MemoryService`.
 * @param parameters - Ordered wire parameters.
 * @returns The method definition the factory consumes.
 */
function method(
  implementation: string,
  parameters: TypertRemoteParameterSpec[],
): TypertRemoteMethodSpec {
  return {
    service: 'memory',
    implementation,
    invocation: { kind: 'direct' },
    parameters,
    result: codec(),
  }
}

/** Endpoint key → Host implementation, parameter names, and result codec. */
export const MEMORY_REMOTE_SPEC: TypertRemoteSpec = {
  package: 'dsh-memory',
  methods: {
    'memory/overview': method('overview', [parameter('request')]),
    'memory/activeWorkspace': method('activeWorkspace', []),
    'memory/list': method('remoteList', [parameter('request')]),
    'memory/view': method('view', [parameter('request')]),
    'memory/create': method('create', [parameter('input')]),
    'memory/update': method('update', [parameter('input')]),
    'memory/delete': method('delete', [parameter('request')]),
    'memory/restore': method('remoteRestore', [parameter('request')]),
    'memory/review': method('review', [parameter('request')]),
    'memory/dream': method('dream', [parameter('request')]),
    'memory/dreamStatus': method('dreamStatus', []),
    'memory/undoDream': method('remoteUndoDream', [parameter('request')]),
    'memory/cancelDream': method('remoteCancelDream', [parameter('request')]),
    'memory/export': method('remoteExport', [parameter('request')]),
    'memory/import': method('remoteImport', [parameter('request')]),
    'memory/rebuild': method('rebuild', [parameter('request')]),
    'memory/purgeAll': method('purgeAll', [parameter('request')]),
    'memory/getConfig': method('getConfig', []),
    'memory/updateConfig': method('updateConfig', [parameter('request')]),
    'memory/modelCatalog': method('modelCatalog', []),
    'memory/modelEfforts': method('modelEfforts', [parameter('request')]),
  },
}

/** Mountable Client contribution and Host descriptor source for the namespace. */
export const MEMORY_REMOTE: TypertRemoteInfo = createTypertRemoteInfo(MEMORY_REMOTE_SPEC, z)
