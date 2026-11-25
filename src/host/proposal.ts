/**
 * Re-export dream-proposal identity and duplicate policy from the shared core.
 * @module dsh-memory/host/proposal
 */
export {
  applyDuplicatePolicy,
  computeProposalKey,
  contentHash,
  normalizeTitle,
  proposalScopeKey,
  type DreamProposalOutput,
  type DuplicatePolicy,
} from '../core/proposal.ts'
