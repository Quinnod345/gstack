/**
 * autoplan-gate-cost — what a gate costs so far and what taking every
 * recommendation would add (plan E16). Every gate-producing command prints the
 * two lines, and the owner brief carries the same figures, so an approval is
 * never asked without its price. gstack prices what it reserved and settled in
 * `<out>/spend.json` (lib/spend-ledger.ts); a host subagent's actual spend is
 * `unknown` to it (kept at its reservation in worst_case), so the line says so
 * and points at the host's own cost view instead of inventing a credit figure.
 * The reopen estimate is an upper bound: the phases a plan-changing
 * recommendation names plus Eng (its prompt carries the earlier consensus),
 * two voices each when the outside voice is on, at the per-voice estimate the
 * run has been reserving.
 */
import * as path from 'node:path';
import type { GateList } from './gate-list';
import { readLedger, summarize, type SpendSummary } from './spend-ledger';

export interface GateCost {
  summary: SpendSummary;
  /** Attempts the ledger has seen: settled plus still reserved. */
  attempts: number;
  /** Phases a `rec` reply would reopen through its plan-changing recommendations, in run order; empty when none changes the plan. */
  reopens: string[];
  voices: number;
  per_voice_usd: number;
  /** The reopen estimate: voices × per-voice. */
  rec_more_usd: number;
}

export interface GateCostRun { phase_order: string[]; outside_enabled: boolean; spend_cap_usd: number | null }

const usd = (n: number) => n.toFixed(2);

/** Phases a `rec` reopens: every plan-changing recommendation's phase, then Eng last when the run reviews it. */
export function recReopens(list: GateList, phaseOrder: string[]): string[] {
  const named = new Set<string>();
  for (const item of list.items) {
    if (item.id === 'p1' || item.reopens === false || item.carried) continue;
    const option = item.options.find(o => o.key === item.recommended);
    if (option?.changes_plan && item.phase) named.add(item.phase);
  }
  if (named.size && phaseOrder.includes('eng')) named.add('eng');
  return phaseOrder.filter(p => named.has(p));
}

export function gateCost(outDir: string, list: GateList, run: GateCostRun, o: { spendFile?: string; defaultPerVoiceUsd?: number } = {}): GateCost {
  const ledger = readLedger(o.spendFile ?? path.join(outDir, 'spend.json'), run.spend_cap_usd);
  const summary = summarize(ledger);
  const seen = [...ledger.settled.map(s => s.reserved_usd), ...ledger.reserved.map(r => r.estimate_usd)].filter(n => n > 0);
  const per_voice_usd = seen.length ? seen[seen.length - 1]! : o.defaultPerVoiceUsd ?? 0;
  const reopens = recReopens(list, run.phase_order);
  const voices = reopens.length * (run.outside_enabled ? 2 : 1);
  return { summary, attempts: ledger.settled.length + ledger.reserved.length, reopens, voices, per_voice_usd, rec_more_usd: Math.round(voices * per_voice_usd * 100) / 100 };
}

/** The two printed lines: the ledger at this gate, and the price of `rec`. */
export function renderGateCost(c: GateCost): string[] {
  const s = c.summary;
  const cap = s.cap_usd === null ? 'none' : usd(s.cap_usd);
  const headroom = s.headroom_usd === null ? 'none' : usd(s.headroom_usd);
  const unknown = s.unknown_count ? `; ${s.unknown_count} host-subagent attempt(s) priced unknown, counted at their reservation (read the actual figure in the host's cost view)` : '';
  const after = s.headroom_usd === null ? '' : ` → headroom ${usd(s.headroom_usd - c.rec_more_usd)}${s.headroom_usd - c.rec_more_usd < 0 ? ' (over the cap: raise it with gstack-autoplan budget before answering rec)' : ''}`;
  return [
    `GATE_SPEND: spent=${usd(s.spent_usd)} worst_case=${usd(s.worst_case_usd)} cap=${cap} headroom=${headroom} attempts=${c.attempts}${unknown}`,
    c.reopens.length
      ? `GATE_REC_COST: rec reopens ${c.reopens.join(',')} ≈ ${c.voices} voice(s) × ${usd(c.per_voice_usd)} = +${usd(c.rec_more_usd)} (estimate at the run's per-voice reservation)${after}`
      : 'GATE_REC_COST: rec reopens nothing (no recommended option changes the plan): +0.00',
  ];
}

/** One sentence for the owner brief. */
export function gateCostSentence(c: GateCost): string {
  const s = c.summary;
  const cap = s.cap_usd === null ? 'no cap set' : `cap ${usd(s.cap_usd)}, headroom ${usd(s.headroom_usd!)}`;
  const unknown = s.unknown_count ? `, ${s.unknown_count} host attempt(s) unknown and counted at reservation` : '';
  const rec = c.reopens.length ? `Taking every recommendation reopens ${c.reopens.join(', ')}: about +${usd(c.rec_more_usd)} more.` : 'Taking every recommendation reopens nothing: no further spend.';
  return `Cost so far: spent ${usd(s.spent_usd)}, worst case ${usd(s.worst_case_usd)} (${cap}${unknown}; ${c.attempts} reviewer attempt(s)). ${rec}`;
}
