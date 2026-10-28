/**
 * ship-receipt-depth — what the /ship receipt says about how deeply the
 * review read the head, and what the queue checks against it
 * (docs/review-policy.md#review-depth, docs/ship-policy.md#ship-receipt).
 *
 * `review_depth`: written by `gstack-ship-receipt write` from
 * gstack-review-plan at the reviewed head (depth, runtime lines, the rules
 * hash, the base and registry commits, the gate scan bound to that head).
 * `review_loop_exception`: the owner's acceptance of a stop after a
 * fix-check edit under frozen scope (#3559), shaped like the docs exception.
 * The queue recomputes the depth the head needs from git objects
 * (lib/review-collect.ts) and refuses a receipt below it. Kept beside
 * lib/ship-receipt.ts so that module stays under the size ratchet.
 */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import type { ShipReceipt } from './headless-artifacts';
import { collectCommit } from './review-collect';
import { classifyPath, depthOfCommitInput, type Depth } from './review-depth';
import { runScriptSync } from './script-invocation';
import { bindReceipt, type ReceiptBindingCode } from './ship-receipt';
import { docsExceptionLine, parseReceiptDocs } from './ship-receipt-docs';

export type ReceiptDepth = NonNullable<ShipReceipt['review_depth']>;
export type ReviewLoopException = NonNullable<ShipReceipt['review_loop_exception']>;
const RANK: Record<Depth, number> = { light: 0, standard: 1, full: 2 };
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(v);
const sha = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{40}$/.test(v);
const short = (s: string | null | undefined) => (s ? s.slice(0, 12) : 'none');

function git(root: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 60_000 });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() };
}

/**
 * The depth record for `head` (the checked-out commit), computed the way the
 * queue recomputes it: the range from git objects (collectCommit), plus
 * gstack-diff-scope and, for a tests or code diff, the gate scan of this
 * checkout, which therefore names `head`.
 */
export function receiptDepthAtHead(repoRoot: string, base: string, binDir: string, head: string): ReceiptDepth {
  const branch = base.replace(/^origin\//, '');
  const baseSha = git(repoRoot, ['rev-parse', '--verify', '--quiet', `origin/${branch}^{commit}`]);
  const c = collectCommit(repoRoot, baseSha.ok ? baseSha.out : branch, head);
  const run = (bin: string, timeout: number) => runScriptSync(path.join(binDir, bin), [branch], { cwd: repoRoot, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
  const scope: Record<string, string> = {};
  const sr = run('gstack-diff-scope', 60_000);
  for (const l of (sr.stdout ?? '').split('\n')) { const m = /^(SCOPE_[A-Z_]+)=(.*)$/.exec(l); if (m) scope[m[1]!] = m[2]!; }
  if (sr.status !== 0 && !scope.SCOPE_ERROR) scope.SCOPE_ERROR = `exit ${sr.status}`;
  let tagged: number | null = 0;
  if (c.paths.some(p => classifyPath(p, c.root) !== 'docs')) {
    const g = run('gstack-gate-diff', 120_000);
    const m = /GATE_SUMMARY: .*?tagged=\{([^}]*)\}/.exec(g.stdout ?? '');
    tagged = g.status === 0 && m ? m[1]!.split(',').reduce((n, kv) => n + (Number(kv.split(':')[1]) || 0), 0) : null;
  }
  const d = depthOfCommitInput({ ...c, scope, gateTagged: tagged });
  return { depth: d.depth, class: d.class, runtime_lines: d.runtimeLines, rules: d.rules, base: baseSha.ok ? baseSha.out : branch, registry: c.registry.sha, gate_scan: { tagged, head }, reasons: d.reasons.slice(0, 12) };
}

export const depthBelow = (have: Depth, need: Depth) => RANK[have] < RANK[need];
export const deeper = (a: Depth, b: Depth): Depth => (RANK[a] >= RANK[b] ? a : b);

/** `write --review-loop-exception` input and the queue's check: who accepted the stop, when, where, why, and the fix-check it followed. */
export function parseReviewLoopException(value: unknown): { ok: true; exception: ReviewLoopException } | { ok: false; message: string } {
  const bad = (message: string) => ({ ok: false as const, message });
  if (!value || typeof value !== 'object' || Array.isArray(value)) return bad('review_loop_exception must be { accepted_by, date, via, reason, fix_check: { head, findings[, files] } }');
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) if (!['accepted_by', 'date', 'via', 'reason', 'fix_check'].includes(key)) return bad(`review_loop_exception: unknown key ${JSON.stringify(key)}`);
  for (const key of ['accepted_by', 'date', 'via', 'reason']) if (!text(v[key])) return bad(`review_loop_exception.${key} must be a non-empty one-line string`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date as string)) return bad('review_loop_exception.date must be YYYY-MM-DD');
  const f = v.fix_check as Record<string, unknown> | null;
  if (!f || typeof f !== 'object' || Array.isArray(f)) return bad('review_loop_exception.fix_check must be { head, findings[, files] }');
  for (const key of Object.keys(f)) if (!['head', 'findings', 'files'].includes(key)) return bad(`review_loop_exception.fix_check: unknown key ${JSON.stringify(key)}`);
  if (!sha(f.head)) return bad('review_loop_exception.fix_check.head must be the full commit the fix-check reviewed');
  if (typeof f.findings !== 'number' || !Number.isInteger(f.findings) || f.findings < 0) return bad('review_loop_exception.fix_check.findings must be an integer >= 0 (what the fix-check reported)');
  if (f.files !== undefined && (!Array.isArray(f.files) || !f.files.every(text))) return bad('review_loop_exception.fix_check.files must be a list of paths');
  const files = (f.files as string[] | undefined)?.slice(0, 50);
  return { ok: true, exception: { accepted_by: (v.accepted_by as string).trim(), date: v.date as string, via: (v.via as string).trim(), reason: (v.reason as string).trim(), fix_check: { head: f.head, findings: f.findings, ...(files?.length ? { files } : {}) } } };
}

/** The line the PR body must carry, word for word, while the exception stands. */
export function reviewLoopExceptionLine(e: ReviewLoopException): string {
  return `Review-loop exception: accepted by ${e.accepted_by} ${e.date} via ${e.via}: ${e.reason} (fix-check at ${e.fix_check.head.slice(0, 12)}, ${e.fix_check.findings} finding${e.fix_check.findings === 1 ? '' : 's'})`;
}

const carries = (body: string, line: string) => body.split(/\r?\n/).some(l => l.trim() === line);

/** The owner exceptions a receipt records, checked the same way: valid shape, and the body carries each line verbatim. */
export function exceptionProblems(body: string, r: ShipReceipt): string[] {
  const out: string[] = [];
  const raw = r as ShipReceipt & { docs?: unknown };
  if (raw.docs !== undefined) {
    const d = parseReceiptDocs(raw.docs);
    if (!d.ok) out.push(`docs: ${d.message}`);
    else { const line = docsExceptionLine(d.docs); if (line && !carries(body, line)) out.push(`the body does not carry the documentation exception line verbatim: ${JSON.stringify(line)}`); }
  }
  if (r.review_loop_exception !== undefined) {
    const e = parseReviewLoopException(r.review_loop_exception);
    if (!e.ok) out.push(e.message);
    else {
      if (!r.review_loop?.fix_checks) out.push('review_loop_exception needs review_loop.fix_checks >= 1 (the stop it accepts follows a fix-check)');
      const line = reviewLoopExceptionLine(e.exception);
      if (!carries(body, line)) out.push(`the body does not carry the review-loop exception line verbatim: ${JSON.stringify(line)}`);
    }
  }
  return out;
}

export interface DepthVerdict { ok: boolean; line: string; message?: string }

/**
 * The depth the bound head needs against `baseRef`, recomputed from git
 * objects; the recorded gate scan counts only when it names the receipt's
 * head, otherwise the scan is unavailable and the head needs full. A receipt
 * with no review_depth and no gstack_version predates depth receipts and is
 * accepted as legacy; one from a writer that records depth but lacks it is not.
 */
export function receiptDepthVerdict(root: string, baseRef: string, r: ShipReceipt, head: string): DepthVerdict {
  const rd = r.review_depth;
  if (!rd && !r.gstack_version) return { ok: true, line: 'REVIEW_DEPTH: legacy receipt (written before receipts recorded review_depth); accepted' };
  const baseSha = git(root, ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`]);
  const c = collectCommit(root, baseSha.ok ? baseSha.out : baseRef, head);
  const scanBound = !!rd && rd.gate_scan.tagged !== null && head.startsWith(rd.gate_scan.head);
  const need = depthOfCommitInput({ ...c, gateTagged: scanBound ? rd!.gate_scan.tagged : null });
  const have = rd?.depth;
  const inputs = `base@${short(baseSha.ok ? baseSha.out : null)},registry@${short(c.registry.sha)},gate_scan@${scanBound ? short(rd!.gate_scan.head) : 'missing'}`;
  const line = `REVIEW_DEPTH: receipt=${have ?? 'none'} required=${need.depth} runtime_lines=${need.runtimeLines} class=${need.class} reasons=${need.reasons.join(',')} inputs=${inputs}`;
  if (have && !depthBelow(have, need.depth)) return { ok: true, line };
  const why = have ? `was reviewed at ${have} depth` : 'records no review_depth though its writer records one';
  const errs = need.errors.map(e => `${e.code} (${e.input})`).join('; ');
  return { ok: false, line, message: `the receipt ${why}, but head ${head.slice(0, 12)} needs ${need.depth} (${need.reasons.join(', ')}${errs ? `; ${errs}` : ''}); the receipt is unchanged; run /ship on ${head.slice(0, 12)}` };
}

/** bindReceipt plus the owner exceptions and the review depth: what READY and train build accept. */
export function bindShippedReceipt(root: string, baseRef: string, body: string, pr: string | undefined, accepted: readonly string[]):
  | { ok: true; receipt: ShipReceipt; head: string; line: string; depthLine: string }
  | { ok: false; code: ReceiptBindingCode | 'QUEUE_RECEIPT_DEPTH_RAISED' | 'QUEUE_RECEIPT_EXCEPTION_INVALID'; message: string; line: string; depthLine?: string } {
  const b = bindReceipt(body, pr, accepted);
  if (!b.ok) return b;
  const problems = exceptionProblems(body, b.receipt);
  if (problems.length) return { ok: false, code: 'QUEUE_RECEIPT_EXCEPTION_INVALID', message: `the receipt's owner exception does not stand: ${problems.join('; ')}`, line: b.line };
  const d = receiptDepthVerdict(root, baseRef, b.receipt, b.head);
  if (!d.ok) return { ok: false, code: 'QUEUE_RECEIPT_DEPTH_RAISED', message: d.message!, line: b.line, depthLine: d.line };
  return { ...b, depthLine: d.line };
}

