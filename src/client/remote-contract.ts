/**
 * Client-side Typert Remote contribution for the `memory` namespace.
 *
 * The definition itself lives in `src/remote-spec.ts`, shared with the Host so
 * the registered strict descriptors and the mounted Client methods describe
 * exactly the same endpoints. This module keeps the stable import path the
 * client entry and tests already use.
 * @module dsh-memory/client/remote-contract
 */
export { MEMORY_REMOTE } from '../remote-spec.ts'
