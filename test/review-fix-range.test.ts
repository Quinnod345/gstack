/**
 * #3339: /ship Step 9 may re-review only the fix range, but a fix-range pass
 * can never be the last review. The fix base comes from the review log (never
 * the working tree or the caller), a narrowed row is never CURRENT and carries
 * no start_wtree/end_wtree for Step 11.5 to bind, and narrowed dispatches stay
 * out of specialist hit rates.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { canReuseSharedLibsAdvisory, reviewFreshness } from '../lib/review-evidence';
import { gitIn } from './helpers/scratch-repo';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin');
const W = 'a'.repeat(40);

let root: string, repo: string, env: NodeJS.ProcessEnv;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-fix-range-'));
  repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  env = { ...process.env, GSTACK_STATE_ROOT: path.join(root, 'state') };
  delete env.GSTACK_HOME;
  gitIn(repo, 'init -q -b feature');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
  gitIn(repo, 'add a.ts');
  gitIn(repo, 'commit -q -m init');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function bin(name: string, args: string[]) {
  const r = spawnSync(path.join(BIN, name), args, { cwd: repo, encoding: 'utf8', timeout: 60_000, env });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr };
}
const head = () => gitIn(repo, 'rev-parse HEAD').trim();
function fix(text: string) {
  fs.writeFileSync(path.join(repo, 'a.ts'), text);
  gitIn(repo, 'commit -q -am fix');
}
function pass(row: Record<string, unknown>, start: string[] = ['--start', 'review']) {
  const started = bin('gstack-review-log', start);
  expect(started.code).toBe(0);
  const [token, base] = started.out.split('\n');
  const logged = bin('gstack-review-log', [JSON.stringify({ skill: 'review', via: 'ship', status: 'clean', issues_found: 0, critical: 0, informational: 0, ...row }), '--finish', token!]);
  expect(logged.code).toBe(0);
  return base;
}
const fixing = { status: 'issues_found', completed: true, converged: false };
const clean = { completed: true, converged: true };
function rows(): any[] {
  return bin('gstack-review-read', []).out.split('\n---CONFIG---')[0]!.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
}
const refused = () => bin('gstack-review-log', ['--start', 'review', '--fix-range']);

describe('fix-range start', () => {
  test('after a completed fixing pass it prints the token and that pass commit as FIX_BASE', () => {
    const reviewed = head();
    pass(fixing);
    fix('export const a = 2;\n');
    expect(pass(clean, ['--start', 'review', '--fix-range'])).toBe(`FIX_BASE=${reviewed}`);
  });

  test('chained fix-range passes take the latest fixing pass as base', () => {
    pass(fixing);
    fix('export const a = 2;\n');
    const second = head();
    pass(fixing, ['--start', 'review', '--fix-range']);
    fix('export const a = 3;\n');
    expect(pass(clean, ['--start', 'review', '--fix-range'])).toBe(`FIX_BASE=${second}`);
  });

  test.each([
    ['no earlier pass', () => {}, 'no earlier pass on this branch'],
    ['a clean latest pass', () => pass(clean), 'the latest pass made no fixes'],
    ['an incomplete latest pass (coverage restoration stays full)', () => pass({ ...fixing, status: 'unavailable', completed: false }), 'the latest pass did not complete'],
    ['a Step 11 review after the latest pass', () => { pass(fixing); pass({ skill: 'adversarial-review', ...clean }, ['--start', 'adversarial-review']); }, 'a Step 11 review followed the latest pass'],
    ['content that changed during the latest pass', () => {
      const token = bin('gstack-review-log', ['--start', 'review']).out;
      fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 9;\n');
      bin('gstack-review-log', [JSON.stringify({ skill: 'review', ...fixing }), '--finish', token]);
    }, 'the latest pass has no unchanged captured content'],
    ['a base that is no longer an ancestor of HEAD', () => {
      fix('export const a = 2;\n');
      pass(fixing);
      gitIn(repo, 'reset -q --hard HEAD~1');
      fix('export const a = 3;\n');
    }, 'is not an ancestor of HEAD'],
  ])('refuses %s', (_, setup, reason) => {
    setup();
    const r = refused();
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    expect(r.err).toContain('fix-range refused: ');
    expect(r.err).toContain(reason);
    expect(r.err).toContain('run a full pass (gstack-review-log --start review)');
  });

  test('rejects an unknown start flag with usage', () => {
    expect(bin('gstack-review-log', ['--start', 'review', '--narrow']).code).toBe(2);
  });
});

describe('a fix-range pass is never the last review', () => {
  test('its row is fix-range scoped whatever the caller claims, unbindable at Step 11.5 and never CURRENT', () => {
    const reviewed = head();
    pass(fixing);
    fix('export const a = 2;\n');
    pass({ ...clean, scope: 'full', fix_base: 'f'.repeat(40), review_binding: { state: 'verified', start_wtree: W, end_wtree: W }, wtree: W },
      ['--start', 'review', '--fix-range']);
    const row = rows().at(-1);
    expect(row.scope).toBe('fix-range');
    expect(row.fix_base).toBe(reviewed);
    expect(row.review_binding.state).toBe('fix-range');
    expect(row.review_binding.range_start_wtree).toBe(row.review_binding.range_end_wtree);
    expect(row.review_binding).not.toHaveProperty('start_wtree');
    expect(row.review_binding).not.toHaveProperty('end_wtree');
    expect(row).not.toHaveProperty('wtree');
    expect(row.review_freshness).toEqual({ status: 'UNVERIFIED', reason: 'fix-range pass; only a later full pass can clear review' });
    expect(refused().err).toContain('the latest pass made no fixes');
    pass(clean);
    expect(rows().at(-1).review_freshness.status).toBe('CURRENT');
  });

  test('a caller cannot narrow a full pass by claiming fix-range', () => {
    pass({ ...clean, scope: 'fix-range', fix_base: W });
    const row = rows().at(-1);
    expect(row).not.toHaveProperty('scope');
    expect(row).not.toHaveProperty('fix_base');
    expect(row.review_freshness.status).toBe('CURRENT');
  });

  test('freshness rejects a fix-range row even with a verified-looking binding', () => {
    const rec = { skill: 'review', scope: 'fix-range', status: 'clean', issues_found: 0, critical: 0, completed: true, converged: true, wtree: W,
      review_binding: { state: 'verified', start_wtree: W, end_wtree: W } };
    expect(reviewFreshness(rec, W)?.status).toBe('UNVERIFIED');
    expect(reviewFreshness({ ...rec, scope: undefined }, W)?.status).toBe('CURRENT');
  });

  test('shared-libs advisory reuse never trusts a fix-range row', () => {
    const finding = { severity: 'INFORMATIONAL', advisory: true, action: 'skipped', evidence_paths: ['a.ts'], helper_target: { path: 'b.ts', symbol: 'b' } };
    const fp = 'shared-libs:' + 'c'.repeat(64);
    const prior = { skill: 'review', completed: true, converged: true, wtree: W, scope: 'fix-range',
      review_binding: { state: 'fix-range', range_start_wtree: W, range_end_wtree: W, branch_id: 'd'.repeat(64) } };
    expect(canReuseSharedLibsAdvisory({ ...finding, fingerprint: fp, snapshot_covered_paths: ['a.ts'] }, finding, prior,
      { wtree: W, branch_id: 'd'.repeat(64), covered_paths: ['a.ts'] })).toBe(false);
  });
});

describe('gstack-specialist-stats', () => {
  test('fix-range passes do not count toward hit rates or gate candidacy', () => {
    const entry = (scope?: string) => JSON.stringify({ ...(scope ? { scope } : {}), specialists: { testing: { dispatched: true, findings: 0 } } });
    const slug = bin('gstack-slug', []).out.match(/^SLUG=(.+)$/m)![1]!;
    const dir = path.join(root, 'state', 'projects', slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'feature-reviews.jsonl'), [...Array(9).fill(entry()), ...Array(5).fill(entry('fix-range'))].join('\n') + '\n');
    const out = bin('gstack-specialist-stats', []).out;
    expect(out).toContain('SPECIALIST_STATS: 9 reviews analyzed');
    expect(out).toContain('testing: 9/9 dispatched, 0 findings (0%)');
    expect(out).not.toContain('GATE_CANDIDATE');
  });
});

describe('ship Step 9 instructions', () => {
  const army = fs.readFileSync(path.join(ROOT, 'ship/sections/review-army.md'), 'utf8').replace(/\s+/g, ' ');
  test('the fix-range start, its base substitution and the mandatory full pass are stated', () => {
    expect(army).toContain('start with `--start review --fix-range`');
    expect(army).toContain('`FIX_BASE=<sha>`, which stands in for `origin/<base>` and `<base>` in this pass');
    expect(army).toContain('If it refuses, start a full pass.');
    expect(army).toContain('it may be a fix-range repeat');
    expect(army).toContain('continue to Step 10, and only from a full pass: after a fix-range pass, run one full Step 9 first.');
  });
});
