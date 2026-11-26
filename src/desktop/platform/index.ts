/**
 * Platform adapter factory for Memloom Desktop.
 * @module memloom/desktop/platform
 */
import os from 'node:os'
import type { PlatformAdapter } from './types.ts'
import {
  createWin32PlatformAdapter,
  discoverDefaultAgyStore,
  discoverDefaultDshStores,
} from './win32.ts'

function createConservativeStubAdapter(platform: NodeJS.Platform): PlatformAdapter {
  const homeDir = os.homedir()
  return {
    platform,
    async detectDshProcesses() {
      return {
        running: false,
        uncertain: true,
        matchedProcesses: [],
        error: `DSH process detection is not yet implemented on ${platform}`,
      }
    },
    resolveDefaultDshStores(env?: NodeJS.ProcessEnv) {
      return discoverDefaultDshStores(homeDir, env)
    },
    resolveDefaultAgyStore(env?: NodeJS.ProcessEnv) {
      return discoverDefaultAgyStore(homeDir, env)
    },
  }
}

/**
 * Create a {@link PlatformAdapter} for the target OS platform.
 * Uses the Windows adapter on `win32` and conservative fail-closed stubs on `darwin` / `linux`.
 */
export function createPlatformAdapter(
  platform: NodeJS.Platform = process.platform,
): PlatformAdapter {
  switch (platform) {
    case 'win32':
      return createWin32PlatformAdapter()
    case 'darwin':
      return createConservativeStubAdapter('darwin')
    case 'linux':
      return createConservativeStubAdapter('linux')
    default:
      return createConservativeStubAdapter(platform)
  }
}
