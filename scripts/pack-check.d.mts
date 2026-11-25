/** Type declarations for the DSH bundle pack validator. */
export function packedManifest(): { name: string; version: string; files: { path: string }[] }
export function validateManifest(manifest: { files: { path: string }[] }): string[]
export function run(): number
