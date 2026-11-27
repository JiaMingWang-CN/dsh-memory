/**
 * Re-export dream prompt assembly from the shared core.
 * @module memloom/host/dream-prompt
 */
export {
  buildDreamPrompt,
  buildDreamSystemPrompt,
  buildOrganizePrompt,
  DREAM_SYSTEM_PROMPT,
  EPISODE_SUMMARY_BYTES,
  mergeRelatedMemories,
  ORGANIZE_RECORD_LIMIT,
  ORGANIZE_SYSTEM_PROMPT,
  RELATED_MEMORY_LIMIT,
  type DreamPromptInput,
  type DreamSystemPromptOptions,
  type OrganizePromptInput,
} from '../core/dream-prompt.ts'
