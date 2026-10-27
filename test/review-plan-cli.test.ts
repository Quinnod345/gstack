import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const BIN = path.join(import.meta.dir, '..', 'bin', 'gstack-review-plan');
const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

function repo(files: Record<string, string>): { dir: string; state: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-plan-'));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'review-plan-state-'));
  dirs.push(dir, state);
  const git = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', timeout: 10_000 });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'README.md'), '# x\n'); git('add', '.'); git('commit', '-qm', 'base');
  git('checkout', '-qb', 'feat');
  for (const [p, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), text); }
  git('add', '.'); git('commit', '-qm', 'feat');
  return { dir, state };
}
const run = (r: { dir: string; state: string }, args: string[]) => spawnSync(BIN, ['--base', 'main', '--gate-tagged', '0', ...args], { cwd: r.dir, encoding: 'utf8', timeout: 60_000, env: { ...process.env, GSTACK_STATE_ROOT: r.state } });

describe('gstack-review-plan', () => {
  test('a docs-only diff plans no dispatch and says why', () => {
    const r = run(repo({ 'docs/howto.md': '# How to\nStep one.\n' }), []);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('REVIEW_PLAN: class=docs pass=1 next=full dispatches=0 numbers=no');
    expect(r.stdout).toContain('SKIP: outside-voice (docs class, no numeric claims)');
  });
  test('a docs diff that publishes numbers keeps the outside voice', () => {
    const r = run(repo({ 'docs/bench.md': 'Median latency fell 42% to 180 ms.\n' }), []);
    expect(r.stdout).toContain('DISPATCH: outside-voice outside-voice effort=host');
  });
  test('--json carries the class, the next step, every dispatch with its effort and the audit effort; --no-tiers renders audits at host effort', () => {
    const r = repo({ 'src/a.ts': Array.from({ length: 80 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n' });
    const plan = JSON.parse(run(r, ['--json']).stdout);
    expect(plan).toMatchObject({ class: 'code', next: { step: 'full' }, pass: 0 });
    expect(plan.dispatches.find((d: any) => d.role === 'specialist').effort).toBe('full');
    expect(plan.audit_effort).toBe('light');
    expect(JSON.parse(run(r, ['--json', '--no-tiers']).stdout).audit_effort).toBe('host');
  });
  test('a below-floor fix after pass 1 plans one fix-check', () => {
    const r = run(repo({ 'src/a.ts': 'export const a = 1;\n' }), ['--pass', '1', '--last', 'full', '--fixed-below']);
    expect(r.stdout).toContain('next=fix-check dispatches=1');
    expect(r.stdout).toContain('DISPATCH: fix-check fix-check effort=full');
  });
  test('usage errors exit 2', () => {
    expect(spawnSync(BIN, [], { encoding: 'utf8', timeout: 10_000 }).status).toBe(2);
    expect(run(repo({ 'a.md': 'x' }), ['--last', 'later']).status).toBe(2);
  });
});
