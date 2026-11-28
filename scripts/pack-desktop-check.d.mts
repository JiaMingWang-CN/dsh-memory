/** Type declarations for the Desktop packaging verification script. */
export function validateDesktopArtifact(outDir?: string): string[]
export function validateBundledPluginsArtifact(outDir?: string, expectedVersion?: string): string[]
export function runDesktopPackCheck(options?: { requireBundled?: boolean }): number
