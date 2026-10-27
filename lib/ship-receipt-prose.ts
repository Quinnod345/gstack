/**
 * The receipt-versus-prose number check (/ship Step 19, docs/ship-policy.md#ship-receipt):
 * a PR body that quotes a counter the receipt also records (review passes,
 * deferred findings, gate case counts) must quote the receipt's number.
 * `gstack-ship-receipt read --check-prose` runs it; a disagreement is
 * RECEIPT_PROSE_MISMATCH. Prose that quotes no receipt counter is not a claim.
 */
import { RECEIPT_FENCE } from './ship-receipt';

export interface ProseClaim { field: string; prose: number; receipt: number }
export interface ProseCheck { checked: number; mismatches: ProseClaim[] }

/** Integer leaves of the receipt under the counter-bearing keys, as `parent.key` → value. */
export function receiptCounters(receipt: Record<string, unknown>): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (value: unknown, prefix: string) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const [key, leaf] of Object.entries(value as Record<string, unknown>)) {
      if (Number.isInteger(leaf)) out.set(prefix ? `${prefix}.${key}` : key, leaf as number);
      else walk(leaf, prefix ? `${prefix}.${key}` : key);
    }
  };
  for (const key of ['review_loop', 'gate', 'ci']) walk(receipt[key], key);
  return out;
}

const BLOCK_RE = new RegExp('```' + RECEIPT_FENCE + '[ \\t]*\\r?\\n[\\s\\S]*?\\r?\\n```', 'g');
const ESCAPE = /[.*+?^${}()|[\]\\]/g;

/**
 * Every `<name>=<n>`, `<name>: <n>` and `<n> <name>` in the prose (the body
 * without its receipt block), where `<name>` is a counter's leaf key with `_`
 * matched as `_`, space or `-` and not part of a longer word (`3 pass-through`
 * is not a `pass` claim), compared with the receipt. A leaf key shared by
 * several counters (`pass` under every gate lane, `passed` under gate and ci)
 * names any of them: the claim matches when its number equals one of those
 * counters, and a mismatch names the first of them. A number that is the value
 * of a `key=` or `key:` pair is that key's claim alone, never the start of a
 * `<n> <name>` claim about the next key (#3513).
 */
export function checkReceiptProse(receipt: Record<string, unknown>, body: string): ProseCheck {
  const prose = body.replace(BLOCK_RE, '');
  const byLeaf = new Map<string, Array<{ field: string; value: number }>>();
  for (const [field, value] of receiptCounters(receipt)) {
    const leaf = field.split('.').at(-1)!;
    byLeaf.set(leaf, [...(byLeaf.get(leaf) ?? []), { field, value }]);
  }
  const pattern = (leaf: string) => leaf.replace(ESCAPE, '\\$&').replaceAll('_', '[ _-]');
  // The number-then-name branch must not start on a `key=value` or `key: value` pair's value: in `passes=2 blocking_found=1`
  // and `passes: 2 blocking_found: 1` the 2 is passes' claim, not a "2 blocking_found" one. The offsets of every counter
  // key's value are collected first, whatever the whitespace around the separator, and a claim starting there is skipped.
  const values = new Set<number>();
  for (const leaf of byLeaf.keys()) for (const m of prose.matchAll(new RegExp(`(?<![\\w-])${pattern(leaf)}\\s*[=:]\\s*(?=\\d)`, 'gi'))) values.add(m.index + m[0].length);
  const mismatches: ProseClaim[] = [];
  let checked = 0;
  for (const [leaf, counters] of byLeaf) {
    const name = pattern(leaf);
    const re = new RegExp(`(?:(?<![\\w-])${name}\\s*[=:]\\s*(\\d+)\\b|(?<![=:\\w.-])(\\d+)\\s+${name}(?![\\w-]))`, 'gi');
    for (let m = re.exec(prose); m; m = re.exec(prose)) {
      // A skipped value hands the scan back right after its digits, so the key that follows still makes its own pair claim.
      if (m[2] !== undefined && values.has(m.index)) { re.lastIndex = m.index + m[2].length; continue; }
      checked++;
      const n = Number(m[1] ?? m[2]);
      if (!counters.some(c => c.value === n)) mismatches.push({ field: counters[0]!.field, prose: n, receipt: counters[0]!.value });
    }
  }
  return { checked, mismatches };
}

export function proseLine(check: ProseCheck): string {
  if (!check.checked) return 'PROSE: no receipt counter claims in the body';
  if (!check.mismatches.length) return `PROSE: ${check.checked} receipt counter claim${check.checked === 1 ? '' : 's'} in the body, all match`;
  return 'PROSE: mismatch ' + check.mismatches.map(m => `${m.field} body=${m.prose} receipt=${m.receipt}`).join('; ');
}
