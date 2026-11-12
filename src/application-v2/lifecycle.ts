/**
 * R2 frozen lifecycle contracts (owner freeze; R implements, P consumes).
 *
 * These types define the external behaviour the R1 black-box repros demand:
 *  - every player input becomes a tracked job with a terminal or recoverable
 *    state; save/EOF/quit never silently drop an accepted step;
 *  - a cancel or timeout revokes the actor's submission right (generation), so
 *    a late scoring result executes zero world effects;
 *  - a new promise after a cancel creates a NEW instance; retrying the same
 *    command reuses the same instance id.
 *
 * Frozen fields may gain optional members later; existing members and their
 * semantics do not change without a new owner freeze commit.
 */

/** Per-player-input job identity and lifecycle state. */
export type PlayerJobKind =
  | 'observe' | 'promise' | 'cancel' | 'tell' | 'advance'
  | 'step' | 'knowledge' | 'save' | 'quit'
  /** R2 gameplay slice commands (additive; same job lifecycle). */
  | 'assign' | 'cancel-task' | 'task-status' | 'game-step'
  /** R3 spatial slice commands (additive; same job lifecycle). */
  | 'map' | 'where' | 'travel' | 'withdraw' | 'deliver' | 'restock'
  | 'close-road' | 'open-road' | 'tell-restock';

export type PlayerJobStatus = 'pending' | 'running' | 'completed' | 'cancelled' | 'failed';

export interface PlayerJob {
  /** Monotonic per-process job sequence, assigned before the handler starts. */
  jobId: string;
  kind: PlayerJobKind;
  status: PlayerJobStatus;
  /** True exactly for completed/cancelled/failed. */
  terminal: boolean;
  /** Command identity for retries of the same logical player input. */
  commandId: string | null;
  /** Human/machine readable outcome; never used to imply authority. */
  detail?: unknown;
}

/**
 * Save/quit barrier policy. A barrier must settle every accepted job first:
 * either wait for its terminal state up to `settleTimeoutMs`, or cancel it
 * explicitly and record the cancelled terminal state. Dropping an accepted
 * job with no record is a contract violation, not an optimisation.
 */
export interface SaveBarrierPolicy {
  settleTimeoutMs: number;
  onPendingStep: 'wait' | 'cancel';
}

export const DEFAULT_SAVE_BARRIER: SaveBarrierPolicy = { settleTimeoutMs: 10_000, onPendingStep: 'wait' };

/**
 * A promise instance: one concrete obligation created by one player command.
 * `promiseKey` is the stable logical identity (which npc, which kind);
 * `instanceId` is unique per creation. Cancelling targets an instance (or the
 * live instance of a key). A retried creation command with the same
 * `commandId` returns the existing instance instead of creating another.
 */
export interface PromiseInstance {
  instanceId: string;
  promiseKey: string;
  commandId: string;
  createdAt: number;
  state: 'active' | 'cancelled' | 'kept';
}

/**
 * Per-actor submission right. `generation` increments on cancel/timeout/
 * dependency invalidation; a scoring result carrying an older generation must
 * not submit world effects even if it arrives first at the port.
 */
export interface ActorGeneration {
  actorId: string;
  generation: number;
  reason: string | null;
}

/** Receipt view used by the app layer: monotonic, never downgraded. */
export type ReceiptStatus = 'applied' | 'rejected' | 'unknown';

export interface ImmutableReceipt {
  commandId: string;
  status: ReceiptStatus;
  /** True when this response replayed an earlier receipt (idempotent retry). */
  duplicate: boolean;
  eventIds: string[];
  postStateVersion: number | null;
  reason: string | null;
}
