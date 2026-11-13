/**
 * G10-R1 worker B — immutable campaign authorization binding.
 *
 * A live slot is only resumable against the SAME ledger: identity, canonical
 * locator, immutable limit, a spent floor and the exact used-attempt prefix.
 * A path, a short name or an equal limit number alone is never an identity.
 * This is an engineering guard against accidental ledger swaps/rollbacks, not
 * a claim of resistance to arbitrary root tampering.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  G10_CAMPAIGN_BINDING_SCHEMA, type CampaignBinding,
} from './contracts';
import type { CampaignState } from '../eval/campaign-budget';

export type BindingRejectionCode =
  | 'CAMPAIGN_BINDING_MISSING'
  | 'LEDGER_MISSING'
  | 'LEDGER_IDENTITY_MISMATCH'
  | 'LEDGER_LOCATOR_MISMATCH'
  | 'LEDGER_LIMIT_MISMATCH'
  | 'LEDGER_SPENT_BELOW_FLOOR'
  | 'LEDGER_HISTORY_MISMATCH';

export type BindingCheck =
  | { ok: true }
  | { ok: false; code: BindingRejectionCode; issues: string[] };

/** Canonical absolute locator; a symlinked alias resolves to the same file. */
export function canonicalLedgerLocator(campaignJsonPath: string): string {
  try {
    return realpathSync(resolve(campaignJsonPath));
  } catch {
    return resolve(campaignJsonPath);
  }
}

export function campaignJsonPath(campaignDir: string): string {
  return resolve(campaignDir, 'campaign.json');
}

/** Bind a live save to its ledger. Refuses a ledger without an immutable id. */
export function createCampaignBinding(
  state: CampaignState,
  campaignJson: string,
  now: () => number = Date.now,
): { ok: true; binding: CampaignBinding } | { ok: false; issues: string[] } {
  if (typeof state.ledgerId !== 'string' || state.ledgerId.length === 0) {
    return { ok: false, issues: ['the campaign ledger has no immutable ledgerId; refusing to bind'] };
  }
  return {
    ok: true,
    binding: {
      schema: G10_CAMPAIGN_BINDING_SCHEMA,
      ledgerId: state.ledgerId,
      locator: canonicalLedgerLocator(campaignJson),
      limit: state.limit,
      spentFloor: state.spent,
      usedPrefix: state.attempts.map(attempt => attempt.attemptId),
      savedAtUtc: new Date(now()).toISOString(),
    },
  };
}

/**
 * Validate a saved binding against the ledger actually on disk BEFORE any
 * provider is constructed. Growth after the save is legal; a rollback, a
 * different ledger, a re-authorized limit or a rewritten history is not.
 */
export function validateCampaignBinding(
  binding: CampaignBinding,
  ledger: CampaignState,
  campaignJson: string,
): BindingCheck {
  const issues: string[] = [];
  if (binding.ledgerId !== ledger.ledgerId) {
    issues.push(`ledger identity ${JSON.stringify(ledger.ledgerId)} is not the saved ${JSON.stringify(binding.ledgerId)}`);
    return { ok: false, code: 'LEDGER_IDENTITY_MISMATCH', issues };
  }
  const locator = canonicalLedgerLocator(campaignJson);
  if (locator !== binding.locator) {
    issues.push(`ledger locator ${JSON.stringify(locator)} is not the saved ${JSON.stringify(binding.locator)}`);
    return { ok: false, code: 'LEDGER_LOCATOR_MISMATCH', issues };
  }
  if (ledger.limit !== binding.limit) {
    issues.push(`ledger limit ${ledger.limit} is not the saved authorization ${binding.limit}`);
    return { ok: false, code: 'LEDGER_LIMIT_MISMATCH', issues };
  }
  if (ledger.spent < binding.spentFloor) {
    issues.push(`ledger spent ${ledger.spent} is below the saved floor ${binding.spentFloor} (a rollback is not resumable)`);
    return { ok: false, code: 'LEDGER_SPENT_BELOW_FLOOR', issues };
  }
  if (ledger.attempts.length < binding.usedPrefix.length) {
    issues.push(`ledger has ${ledger.attempts.length} attempts, fewer than the saved prefix ${binding.usedPrefix.length}`);
    return { ok: false, code: 'LEDGER_HISTORY_MISMATCH', issues };
  }
  for (let index = 0; index < binding.usedPrefix.length; index += 1) {
    const actual = ledger.attempts[index]?.attemptId;
    if (actual !== binding.usedPrefix[index]) {
      issues.push(`attempt ${index} is ${JSON.stringify(actual)}, not the saved prefix ${JSON.stringify(binding.usedPrefix[index])}`);
      return { ok: false, code: 'LEDGER_HISTORY_MISMATCH', issues };
    }
  }
  return { ok: true };
}

/** Read-only summary used by the run record (never a substitute for checks). */
export function campaignSummary(ledger: CampaignState): { limit: number; spent: number; known: number | null } {
  const unknown = ledger.attempts.some(attempt => attempt.state !== 'finished' || attempt.totalTokens === null);
  return {
    limit: ledger.limit,
    spent: ledger.spent,
    known: unknown ? null : ledger.attempts.reduce((sum, attempt) => sum + (attempt.totalTokens ?? 0), 0),
  };
}
