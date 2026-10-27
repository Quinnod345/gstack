/**
 * Free contracts of the receipt-versus-prose number check (lib/ship-receipt-prose.ts,
 * gstack-ship-receipt read --check-prose): claims in the three spellings are
 * read against review_loop, gate and ci integers, the receipt block itself is
 * never a claim, a disagreement is RECEIPT_PROSE_MISMATCH (exit 1), and prose
 * without counters passes.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkReceiptProse, proseLine, receiptCounters } from '../lib/ship-receipt-prose';
import { renderReceiptBlock } from '../lib/ship-receipt';
import { EXIT } from '../lib/headless-artifacts';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin/gstack-ship-receipt');
const receipt = {
  schema_version: 1 as const, pr: 7, head: 'a'.repeat(40), base: 'main', version: '1.2.3.0',
  review_loop: { passes: 2, blocking_found: 2, deferred: 1, noted: 0, fixed: 1, scope: 'frozen' },
  gate: { status: 'green', passed: 41, failed: 0, run: '123' }, ci: { status: 'success' },
};

describe('checkReceiptProse', () => {
  test('counters are the integer leaves under review_loop, gate and ci; identifiers are never counters', () => {
    expect([...receiptCounters(receipt).keys()]).toEqual(['review_loop.passes', 'review_loop.blocking_found', 'review_loop.deferred',
      'review_loop.noted', 'review_loop.fixed', 'gate.passed', 'gate.failed']);
  });

  test('the three spellings are claims, the receipt block is not, and a disagreement names field and both values', () => {
    const body = 'Review: 2 passes, 1 deferred finding, blocking found: 2. Gate: passed=41, 0 failed.\n\n' + renderReceiptBlock({ ...receipt, review_loop: { ...receipt.review_loop, passes: 9 } });
    const ok = checkReceiptProse(receipt, body);
    expect(ok).toEqual({ checked: 5, mismatches: [] });
    expect(proseLine(ok)).toBe('PROSE: 5 receipt counter claims in the body, all match');
    const bad = checkReceiptProse(receipt, 'The loop took 3 passes; deferred=2; 41 passed.');
    expect(bad.mismatches).toEqual([{ field: 'review_loop.passes', prose: 3, receipt: 2 }, { field: 'review_loop.deferred', prose: 2, receipt: 1 }]);
    expect(proseLine(bad)).toBe('PROSE: mismatch review_loop.passes body=3 receipt=2; review_loop.deferred body=2 receipt=1');
    expect(proseLine(checkReceiptProse(receipt, 'PR #7 adds the docs.'))).toBe('PROSE: no receipt counter claims in the body');
  });

  test('a leaf key shared by several counters matches any of them, and a hyphenated word is not a claim', () => {
    // /ship writes the gate per lane ({"<lane>":{pass,fail,skip}}), so `pass` names every lane and `passed` names gate and ci alike.
    const lanes = { ...receipt, gate: { unit: { pass: 41, fail: 0, skip: 2 }, e2e: { pass: 7, fail: 0, skip: 0 } }, ci: { status: 'success', passed: 31, failed: 0 } };
    expect(checkReceiptProse(lanes, 'unit: pass=41, e2e pass: 7; CI passed: 31.')).toEqual({ checked: 3, mismatches: [] });
    expect(checkReceiptProse(lanes, '3 pass-through tests and the fail-fast path; blocking-found: 2.')).toEqual({ checked: 1, mismatches: [] });
    const bad = checkReceiptProse(lanes, 'pass: 40');
    expect(bad.mismatches).toEqual([{ field: 'gate.unit.pass', prose: 40, receipt: 41 }]);
    expect(checkReceiptProse(receipt, 'Gate passed: 41. CI passed=41.').mismatches).toEqual([]);
  });
});

describe('gstack-ship-receipt read --check-prose', () => {
  const run = (body: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-prose-'));
    const file = path.join(dir, 'body.md');
    fs.writeFileSync(file, body);
    const r = spawnSync(BIN, ['read', '--body', file, '--check-prose', '--json'], { encoding: 'utf8', timeout: 60_000 });
    fs.rmSync(dir, { recursive: true, force: true });
    return { status: r.status, out: r.stdout, err: r.stderr };
  };

  test('a matching body exits 0 with the PROSE line and the receipt; a mismatch is RECEIPT_PROSE_MISMATCH exit 1', () => {
    const good = run('Two passes: passes=2, deferred: 1.\n\n' + renderReceiptBlock(receipt));
    expect(good.status).toBe(EXIT.ok);
    expect(good.err).toContain('PROSE: 2 receipt counter claims in the body, all match');
    expect(JSON.parse(good.out).prose).toEqual({ checked: 2, mismatches: [] });
    const bad = run('Three passes: passes=3.\n\n' + renderReceiptBlock(receipt));
    expect(bad.status).toBe(EXIT.fail);
    expect(bad.err).toContain('PROSE: mismatch review_loop.passes body=3 receipt=2');
    expect(bad.err).toMatch(/review_loop\.passes body=3 receipt=2.*\(RECEIPT_PROSE_MISMATCH; .*troubleshooting\.md#receipt-prose-mismatch\)/);
    expect(JSON.parse(bad.out).prose.mismatches).toHaveLength(1);
  });
});
