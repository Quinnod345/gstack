/**
 * pregate/allowlist — the policy's `allowlist` applied to the secrets check's
 * findings (Lane D, GSTA-112; harness-evals #81/#83, GSTA-102, GSTA-106). An
 * entry names a gstack-redact finding id or a non-secret category, and scopes
 * it by path globs and/or a regular expression matched at the finding's
 * position in the added line (anchored there, so a dummy token's shape never
 * covers a real key that happens to share its line). `env.value`, the real
 * value of a credential-named environment variable, is never consulted
 * against the list: validation refuses an entry naming it, and this matcher
 * keeps such a finding whatever the entries say (#3449).
 */
import { createHash } from 'node:crypto';
import { matchesAny } from '../ship-policy';
import { ALLOWLISTABLE_CATEGORIES, NON_ALLOWLISTABLE, type AllowlistEntry } from './config';

export interface AllowlistFinding {
  id: string; category: string; severity: string; file: string; line?: number; col?: number;
  /** The added line the finding sits on (for `pattern`); absent when the scanner gave no position. */
  lineText?: string;
}
export interface Allowlisted<F extends AllowlistFinding = AllowlistFinding> { finding: F; index: number; entry: AllowlistEntry }

/** Whether `entry` names this finding: its id, or its category when the category may be named whole. */
function names(entry: AllowlistEntry, f: AllowlistFinding): boolean {
  if (entry.finding === f.id) return true;
  return (ALLOWLISTABLE_CATEGORIES as readonly string[]).includes(entry.finding) && entry.finding === f.category;
}

/** The pattern, anchored at the finding's column in its added line and ending at a token boundary (so a short pattern never covers the head of a longer value); a finding with no position never matches a pattern. */
function patternHits(entry: AllowlistEntry, f: AllowlistFinding): boolean {
  if (entry.pattern === undefined) return true;
  if (f.lineText === undefined || !f.col) return false;
  let re: RegExp;
  try { re = new RegExp(`^(?:${entry.pattern})(?![\\w-])`); } catch { return false; }
  return re.test(f.lineText.slice(f.col - 1));
}

/** Split findings into the ones an entry covers (with the entry) and the ones kept; env.value is always kept. */
export function applyAllowlist<F extends AllowlistFinding>(findings: readonly F[], entries: readonly AllowlistEntry[]): { kept: F[]; allowlisted: Allowlisted<F>[] } {
  const kept: F[] = [];
  const allowlisted: Allowlisted<F>[] = [];
  for (const f of findings) {
    const index = (NON_ALLOWLISTABLE as readonly string[]).includes(f.id) ? -1
      : entries.findIndex(e => names(e, f) && (!e.paths || matchesAny(e.paths, f.file)) && patternHits(e, f));
    if (index < 0) kept.push(f);
    else allowlisted.push({ finding: f, index, entry: entries[index]! });
  }
  return { kept, allowlisted };
}

/** sha256 of the entries, for the check's `inputs.allowlist`. */
export function allowlistDigest(entries: readonly AllowlistEntry[]): string {
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

/** One table line per allowlisted finding: what, where, and which entry (with its reason) covered it. */
export function describeAllowlisted(a: Allowlisted): string {
  const where = a.finding.line ? ` (${a.finding.file}, added line ${a.finding.line})` : ` (${a.finding.file})`;
  return `allowlisted ${a.finding.id}${where} by allowlist[${a.index}] ${a.entry.finding}: ${a.entry.reason}`;
}
