/**
 * Re-export deterministic `worklog(turn)` generation from the shared core.
 * @module memloom/host/worklog
 */
export {
  buildWorklogContent,
  createTurnWorklog,
  shouldCreateWorklog,
  WORKLOG_MAX_BODY_BYTES,
  WORKLOG_MAX_CONCLUSION_BYTES,
  WORKLOG_MAX_TITLE_LENGTH,
  type CaptureEpisodeInput,
} from '../core/worklog.ts'
