/**
 * DSH host adapter for the crash-recoverable operation log.
 * @module memloom/host/operations
 */
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import {
  isCommitted,
  OperationError,
  OperationRunner as CoreOperationRunner,
  type AcceptPayload,
  type CreatePayload,
  type DeletePayload,
  type DreamRunPayload,
  type DreamUndoDetail,
  type DreamUndoReport,
  type OperationErrorCode,
  type OperationObserver,
  type OperationRunnerOptions,
  type PatchPayload,
  type RecoveryOutcome,
  type RecoveryReport,
} from '../core/operations.ts'
import type { MemoryDomainHandle } from '../core/storage-contract.ts'
import { asMemoryDomainHandle, type memoryDomain } from './domain.ts'

export {
  isCommitted,
  OperationError,
  type AcceptPayload,
  type CreatePayload,
  type DeletePayload,
  type DreamRunPayload,
  type DreamUndoDetail,
  type DreamUndoReport,
  type OperationErrorCode,
  type OperationObserver,
  type OperationRunnerOptions,
  type PatchPayload,
  type RecoveryOutcome,
  type RecoveryReport,
}

/**
 * The serialized operation state machine over one open DSH `memory` domain.
 */
export class OperationRunner extends CoreOperationRunner {
  constructor(
    domain: Domain<typeof memoryDomain> | MemoryDomainHandle,
    options?: OperationRunnerOptions,
  ) {
    super(asMemoryDomainHandle(domain), options)
  }
}
