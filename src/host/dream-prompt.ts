/**
 * Re-export dream prompt assembly from the shared core.
 * @module dsh-memory/host/dream-prompt
 */
export {
  buildDreamPrompt,
  buildOrganizePrompt,
  DREAM_SYSTEM_PROMPT,
  EPISODE_SUMMARY_BYTES,
  ORGANIZE_RECORD_LIMIT,
  ORGANIZE_SYSTEM_PROMPT,
  RELATED_MEMORY_LIMIT,
  type DreamPromptInput,
  type OrganizePromptInput,
} from '../core/dream-prompt.ts'
