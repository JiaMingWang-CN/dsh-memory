/** Type declarations for the Desktop bundled plugins build script. */
import type { BundledPluginsManifest } from '../src/desktop/bundled-plugins.js'

export function buildDesktopBundledPlugins(options?: {
  outDir?: string
  dshTgzPath?: string
  agyZipOutPath?: string
  checksumsOutPath?: string
}): Promise<{
  outDir: string
  manifest: BundledPluginsManifest
  agyZipPath?: string
  checksumsPath?: string
}>

export function formatSha256Sums(
  entries: ReadonlyArray<{ readonly fileName: string; readonly sha256: string }>,
): string
