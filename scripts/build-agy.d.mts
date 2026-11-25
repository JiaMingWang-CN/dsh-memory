/** Type declarations for the Antigravity plugin build script. */
export function buildAgyPlugin(options?: {
  outDir?: string
}): Promise<{ outDir: string; files: string[] }>
