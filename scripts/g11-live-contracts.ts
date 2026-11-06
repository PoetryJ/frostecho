/**
 * G11-live resume — the FROZEN interface between worker A (the read-only
 * evidence verifier) and worker B (the orchestrator) / C (black-box tests).
 *
 * Both sides import ONLY this file. Changing these shapes is an interface
 * change: it must be agreed before A and B touch their implementations.
 */
export const G11_VERIFY_SCHEMA = 'frostecho.g11-live.verify/2' as const;

/** The two scenes, in execution order. */
export const G11_SCENES = ['W1', 'W2'] as const;
export type G11Scene = (typeof G11_SCENES)[number];

/** Per-scene file directory: W1 -> w1 (the driver's own layout). */
export const sceneDirOf = (scene: G11Scene): string => scene.toLowerCase();

/** The one-shot evidence roots the verifier reads. Never writes. */
export interface G11VerifyInput {
  batchDir: string;
  campaignDir: string;
  /** The frozen request model every wire body must carry exactly this. */
  model: string;
}

export interface G11AttemptCost {
  attemptId: string;
  scene: G11Scene | null;
  phase: string | null;
  totalTokens: number | null;
}

export interface G11SceneReport {
  scene: G11Scene;
  /** complete: prefix+suffix verified; not_run: no files; incomplete: partial; inconsistent: problems. */
  status: 'complete' | 'incomplete' | 'not_run' | 'inconsistent';
  posts: number;
  /** fulfilled (W1) / expired (W2), or null when the authoritative outcome is absent. */
  outcome: string | null;
  prefix: 'verified' | 'missing' | 'invalid' | 'not_run';
  suffix: 'verified' | 'missing' | 'invalid' | 'not_run';
  slotHashOk: boolean | null;
}

export interface G11VerifyResult {
  schema: typeof G11_VERIFY_SCHEMA;
  /** No integrity/semantic problem: every read record re-executes and cross-checks. */
  evidenceOk: boolean;
  /** evidenceOk AND both scenes complete AND neither outcome is wrong AND no failed attempt. */
  complete: boolean;
  /** The ONE continuation gate: evidenceOk && complete. */
  ok: boolean;
  classification: 'complete' | 'incomplete' | 'inconsistent' | 'offline_ready';
  /** INTEGRITY problems only: these close `evidenceOk`. */
  issues: string[];
  /**
   * Success-shape expectations that are ABSENT because the scene honestly
   * declared it did not succeed (no suffix, no final state, no binding).
   * They never close `evidenceOk`; a scene that CLAIMS success is held to them
   * as integrity issues instead.
   */
  expectations: string[];
  costs: {
    limit: number | null;
    spent: number;
    attempts: number;
    totalTokens: number | null;
    unknownUsage: string[];
    byAttempt: G11AttemptCost[];
  };
  posts: { total: number; perScene: Record<G11Scene, number> };
  scenes: G11SceneReport[];
}

/** Derived gate; kept as a function so no caller re-implements `&&`. */
export const g11Ok = (result: G11VerifyResult): boolean => result.evidenceOk && result.complete;
