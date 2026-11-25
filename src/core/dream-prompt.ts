/**
 * Dream system prompt and user-prompt assembly.
 *
 * The dreamer makes exactly one model call with no tools. The system prompt
 * fixes the evidence rules and the output JSON shape; the user prompt carries
 * every claimed episode, the related memories and any pre-computed health
 * checks. Episode summaries are clipped per episode, never by keeping a
 * transcript.
 * @module dsh-memory/core/dream-prompt
 */
import type { EpisodeRecord, MemoryRecord } from '../shared/types.ts'
import { renderDreamHealth, type DreamHealth } from './dream-health.ts'

/** Per-episode prompt budget in UTF-8 bytes. */
export const EPISODE_SUMMARY_BYTES = 2048
/** Maximum number of related memory summaries in one prompt. */
export const RELATED_MEMORY_LIMIT = 20
/** Maximum number of active memories rendered into one organize prompt. */
export const ORGANIZE_RECORD_LIMIT = 60
/** Per-memory body budget in an organize prompt, in UTF-8 bytes. */
const ORGANIZE_BODY_BYTES = 512
const TOOL_ERROR_BYTES = 1024

/** System prompt for every dream run. */
export const DREAM_SYSTEM_PROMPT = [
  'You consolidate captured work sessions into durable long-term memories.',
  'Return ONE JSON object and nothing else, with the shape:',
  '{"memories":[{"type":"lesson|wiki|preference|worklog","title":"...","body":"...","confidence":0.0,"importance":0.0,"sourceEpisodeIds":["<episode id>"],"tags":["..."],"supersedes":["..."]}],"wikiUpdates":[]}',
  '',
  'Rules you must follow:',
  '- Use only facts supported by the supplied episodes; do not add outside knowledge and do not invent details.',
  '- Content the user stated explicitly is evidence: record it as user stated and cite the supplying episode id in sourceEpisodeIds; do not downgrade it just because no tool output confirms it.',
  '- An assistant claim without a tool result or a user statement behind it is unverified: mark it unverified in the body or omit it.',
  '- Record only what the environment cannot give back: lessons, approaches that worked, verified rules, pitfalls and plans in progress; do not store code, file contents, current configuration values, git history or command output.',
  '- Never copy, paraphrase or summarize already auto-loaded project instructions or documentation (such as AGENTS.md, CLAUDE.md, README or the injected skills list).',
  '- If an episode only reflects a broad request to perform memory operations and contains no new discoveries, pitfalls, decisions or user corrections, return no memory instead of copying existing docs.',
  '- Record one topic per memory and keep each memory concise and focused; split a memory that mixes topics and never bundle unrelated modules or constraints into one long note.',
  '- Record the lasting rule, not a one-off event.',
  '- Skip parameter constraints already stated in the tool definitions (required parameters, argument formats and return shapes).',
  '- Never write secrets such as API keys, tokens, passwords or private keys; record only where the credential is configured.',
  '- Every memory must include at least one sourceEpisodeIds entry citing a supplied episode; never shorten an episode id.',
  '- Keep titles short and bodies concise Markdown. Types are lesson (a reusable rule), wiki (project knowledge), preference (a stable user preference) and worklog (a daily summary).',
].join('\n')

/** Everything needed to build one dream user prompt. */
export interface DreamPromptInput {
  episodes: EpisodeRecord[]
  related: MemoryRecord[]
  health: DreamHealth
}

/** Clip text to a UTF-8 byte budget without splitting a code point. */
function clip(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let bytes = 0
  let out = ''
  for (const char of text) {
    const width = Buffer.byteLength(char, 'utf8')
    if (bytes + width > maxBytes) break
    out += char
    bytes += width
  }
  return out
}

/** Render one episode with its full identity and evidence metadata. */
function renderEpisode(episode: EpisodeRecord): string {
  const parts = [
    `### episode ${episode.id} (${episode.kind}, sessionId: ${episode.sessionId}, turn: ${episode.turn}, seq ${episode.sourceSeqs.join(',')})`,
  ]
  if (episode.prompt !== undefined) {
    parts.push(`user: ${clip(episode.prompt, EPISODE_SUMMARY_BYTES)}`)
  }
  if (episode.assistantFinal !== undefined) {
    parts.push(`assistant: ${clip(episode.assistantFinal, EPISODE_SUMMARY_BYTES)}`)
  }
  if (episode.correctionText !== undefined) {
    parts.push(`correction: ${clip(episode.correctionText, EPISODE_SUMMARY_BYTES)}`)
  }
  if (episode.toolName !== undefined) parts.push(`tool: ${episode.toolName}`)
  if (episode.toolError !== undefined) {
    parts.push(`error: ${clip(episode.toolError, TOOL_ERROR_BYTES)}`)
  }
  if (episode.files.length > 0) parts.push(`files: ${episode.files.join(', ')}`)
  if (episode.outcome !== undefined) parts.push(`outcome: ${episode.outcome}`)
  return clip(parts.join('\n'), EPISODE_SUMMARY_BYTES)
}

/**
 * System prompt for a full-store organize run. Unlike a dream run it reads only
 * existing memories and must cite the ids it replaces.
 */
export const ORGANIZE_SYSTEM_PROMPT = [
  'You consolidate an existing long-term memory store.',
  'Return ONE JSON object and nothing else, with the shape:',
  '{"memories":[{"type":"lesson|wiki|preference|worklog","title":"...","body":"...","confidence":0.0,"importance":0.0,"supersedes":["<memory id>"],"tags":["..."]}]}',
  '',
  'Rules you must follow:',
  '- Use only facts present in the supplied memories; never add outside knowledge and never invent details.',
  '- Merge duplicate or overlapping memories into one concise memory.',
  '- When memories contradict, keep the most recent, best-supported statement and supersede the rest.',
  '- Every output MUST include a non-empty supersedes array of the exact ids of the memories it replaces.',
  '- Do not output a memory that merely repeats one existing memory; leave memories that need no change untouched.',
  '- One topic per memory; keep titles short and bodies concise Markdown.',
  '- Never write secrets such as API keys, tokens, passwords or private keys; record only where the credential is configured.',
].join('\n')

/** Everything needed to build one organize user prompt. */
export interface OrganizePromptInput {
  records: MemoryRecord[]
}

/** Build the user prompt for one organize call. */
export function buildOrganizePrompt(input: OrganizePromptInput): string {
  const lines: string[] = ['## Existing memories']
  const records = input.records.slice(0, ORGANIZE_RECORD_LIMIT)
  if (records.length === 0) {
    lines.push('(none)')
    return lines.join('\n')
  }
  for (const record of records) {
    lines.push(
      `### memory ${record.id}`,
      `type: ${record.type}; scope: ${record.scope.kind === 'global' ? 'global' : 'workspace'}; importance: ${record.importance}; updated: ${record.updatedAt.slice(0, 10)}`,
      `title: ${clip(record.title, 200)}`,
      `body: ${clip(record.body, ORGANIZE_BODY_BYTES)}`,
      '',
    )
  }
  return lines.join('\n')
}

/**
 * Build the user prompt for one dream call.
 * @param input - Claimed episodes, related memories and pre-computed health.
 * @returns Prompt sections in fixed order: health, episodes, related memories.
 */
export function buildDreamPrompt(input: DreamPromptInput): string {
  const lines: string[] = []
  const health = renderDreamHealth(input.health)
  if (health !== '') {
    lines.push('## Health checks already computed', health, '')
  }
  lines.push('## Episodes')
  if (input.episodes.length === 0) {
    lines.push('(none)')
  } else {
    for (const episode of input.episodes) lines.push(renderEpisode(episode), '')
  }
  lines.push('## Related memories')
  const related = input.related
    .slice(0, RELATED_MEMORY_LIMIT)
    .map(
      (record) =>
        `- [${record.type}] ${record.title} (id: ${record.id}, importance: ${record.importance})`,
    )
  lines.push(...(related.length === 0 ? ['(none)'] : related))
  return lines.join('\n')
}
