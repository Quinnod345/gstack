/**
 * Paths a branch removes (deleted files and the old name of a rename) never fail
 * `lanes` with PREGATE_NO_LANE on their own (issue #3529, gbrain#7829). Each one
 * prints a visible `removed (no lane owed): <path> — <why>` line: a deleted test
 * runs its owning suite (the remaining tests of the files it exercised) or says
 * which subjects lost their last test; a modified file whose only test was
 * deleted still fails, and an unreadable deleted test fails closed.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BASE_PREGATE, cleanup, commit, makeFixtureRepo, runBin, write, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
const fixture = (opts?: Parameters<typeof makeFixtureRepo>[0]) => { const r = makeFixtureRepo(opts); repos.push(r); return r; };
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const UTIL_V2 = "const test = require('node:test');\nconst assert = require('node:assert');\nconst { add } = require('../lib/util.js');\ntest('adds again', () => assert.strictEqual(add(2, 2), 4));\n";

function lanes(repo: FixtureRepo) {
  const r = runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'tests']);
  const out = JSON.parse(fs.readFileSync(path.join(repo.work, '.gstack/tmp/pregate.json'), 'utf8'));
  const check = out.checks.find((c: { id: string }) => c.id === 'lanes');
  const lines: string[] = check.lines ?? [];
  return { status: r.status, check, lines, removed: lines.filter(l => l.startsWith('removed (no lane owed): ')), ran: lines.find(l => l.startsWith('ran: ')) ?? '' };
}

function move(repo: FixtureRepo, from: string, to: string, edit?: [string, (text: string) => string]) {
  repo.git('mv', from, to);
  if (edit) { const file = path.join(repo.work, edit[0]); fs.writeFileSync(file, edit[1](fs.readFileSync(file, 'utf8'))); }
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', 'move');
}

describe('removed paths in lanes (#3529)', () => {
  test('a deleted test runs its owning suite: the remaining tests of the files it exercised', () => {
    const repo = fixture({ baseFiles: { 'test/util-v2.test.js': UTIL_V2 } });
    commit(repo, { 'test/util.test.js': null });
    const r = lanes(repo);
    expect(r.check.code).not.toBe('PREGATE_NO_LANE');
    expect(r.check.status).toBe('pass');
    expect(r.removed).toEqual(['removed (no lane owed): test/util.test.js — owning suite runs: test/util-v2.test.js']);
    expect(r.ran).toContain('test/util-v2.test.js');
    expect(r.ran).not.toContain("'test/util.test.js'");
    expect(r.check.detail).toContain('1 removed path(s)');
  });

  test('deleting the only test of a file says coverage removed, in the line and in the detail', () => {
    const repo = fixture();
    commit(repo, { 'test/util.test.js': null });
    const r = lanes(repo);
    expect(r.check.status).toBe('pass');
    expect(r.removed).toEqual(['removed (no lane owed): test/util.test.js — coverage removed: lib/util.js has no remaining test']);
    expect(r.check.detail).toContain('1 removed path(s); 1 subject(s) lost their last test');
  });

  test('deleting a file and its test together notes both and loses no coverage of a file that still exists', () => {
    const repo = fixture();
    commit(repo, { 'test/util.test.js': null, 'lib/util.js': null });
    const r = lanes(repo);
    expect(r.check.status).toBe('pass');
    expect(r.removed).toEqual([
      'removed (no lane owed): lib/util.js — no remaining test references it',
      'removed (no lane owed): test/util.test.js — it exercised no file still in the tree',
    ]);
    expect(r.check.detail).not.toContain('lost their last test');
  });

  test('a renamed test runs under its new name; its old name is noted', () => {
    const repo = fixture();
    move(repo, 'test/util.test.js', 'test/util2.test.js');
    const r = lanes(repo);
    expect(r.check.status).toBe('pass');
    expect(r.removed).toEqual(['removed (no lane owed): test/util.test.js — old name of test/util2.test.js']);
    expect(r.ran).toContain('test/util2.test.js');
  });

  test('a renamed source keeps the lane of its new name; its old name is noted', () => {
    const repo = fixture();
    move(repo, 'lib/util.js', 'lib/util2.js', ['test/util.test.js', t => t.replace('../lib/util.js', '../lib/util2.js')]);
    const r = lanes(repo);
    expect(r.check.status).toBe('pass');
    expect(r.removed).toEqual(['removed (no lane owed): lib/util.js — old name of lib/util2.js']);
    expect(r.ran).toContain('test/util.test.js');
  });

  test('a deleted file no test covered is noted, not failed', () => {
    const repo = fixture();
    commit(repo, { 'lib/orphan.js': null });
    const r = lanes(repo);
    expect(r.check.status).toBe('pass');
    expect(r.removed).toEqual(['removed (no lane owed): lib/orphan.js — no remaining test references it']);
  });

  test('an unstaged deletion behaves like a committed one: the missing test is never selected', () => {
    const repo = fixture({ baseFiles: { 'test/util-v2.test.js': UTIL_V2 } });
    fs.rmSync(path.join(repo.work, 'test/util.test.js'));
    const r = lanes(repo);
    expect(r.check.status).toBe('pass');
    expect(r.removed).toEqual(['removed (no lane owed): test/util.test.js — owning suite runs: test/util-v2.test.js']);
    expect(r.ran).not.toContain("'test/util.test.js'");
  });

  test('a deleted executable test is read at its merge-base mode', () => {
    const repo = fixture({ baseFiles: { 'test/util-v2.test.js': UTIL_V2 } });
    fs.chmodSync(path.join(repo.work, 'test/util.test.js'), 0o755);
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'exec'); repo.git('push', '-q', 'origin', 'HEAD:main');
    commit(repo, { 'test/util.test.js': null });
    const r = lanes(repo);
    expect(r.check.status).toBe('pass');
    expect(r.removed).toEqual(['removed (no lane owed): test/util.test.js — owning suite runs: test/util-v2.test.js']);
  });

  test('a shared test helper the deleted test imported selects no suite and never reads as lost coverage', () => {
    const helper = "exports.check = (a, b) => a === b;\n";
    const usesHelper = "const test = require('node:test');\nconst { check } = require('./helpers/h.js');\ntest('helper', () => check(1, 1));\n";
    const util = "const test = require('node:test');\nconst assert = require('node:assert');\nconst { check } = require('./helpers/h.js');\nconst { add } = require('../lib/util.js');\ntest('adds', () => assert.ok(check(add(1, 2), 3)));\n";
    const repo = fixture({ baseFiles: { 'test/helpers/h.js': helper, 'test/helper-user.test.js': usesHelper, 'test/util.test.js': util, 'test/util-v2.test.js': UTIL_V2 } });
    commit(repo, { 'test/util.test.js': null });
    const r = lanes(repo);
    expect(r.removed).toEqual(['removed (no lane owed): test/util.test.js — owning suite runs: test/util-v2.test.js']);
    expect(r.ran).not.toContain('helper-user');
  });

  describe('negative controls', () => {
    test('a modified file whose only test was deleted still fails PREGATE_NO_LANE', () => {
      const repo = fixture();
      commit(repo, { 'test/util.test.js': null, 'lib/util.js': "exports.add = (a, b) => b + a;\n" });
      const r = lanes(repo);
      expect(r.status).toBe(1);
      expect(r.check.code).toBe('PREGATE_NO_LANE');
      expect(r.check.detail).toContain('lib/util.js');
      expect(r.check.detail).not.toContain('test/util.test.js');
      expect(r.removed).toEqual(['removed (no lane owed): test/util.test.js — coverage removed: lib/util.js has no remaining test']);
    });

    test('a deleted file a remaining test still imports selects that test, which fails loudly', () => {
      const repo = fixture();
      commit(repo, { 'lib/util.js': null });
      const r = lanes(repo);
      expect(r.removed).toEqual([]);
      expect(r.ran).toContain('test/util.test.js');
      expect(r.check.code).toBe('PREGATE_LANE_FAILED');
    });

    test('an explicit dependencies mapping for a deleted path still selects its mapped test', () => {
      const repo = fixture({ pregate: { ...BASE_PREGATE, dependencies: { ...BASE_PREGATE.dependencies, 'test/util.test.js': ['test/retry.test.js'] } } });
      commit(repo, { 'test/util.test.js': null });
      const r = lanes(repo);
      expect(r.check.status).toBe('pass');
      expect(r.removed).toEqual([]);
      expect(r.ran).toContain('test/retry.test.js');
    });

    test('a deleted markdown file keeps its docs/no-tests label', () => {
      const repo = fixture({ baseFiles: { 'notes/plan.md': '# plan\n' } });
      commit(repo, { 'notes/plan.md': null });
      const r = lanes(repo);
      expect(r.check.status).toBe('pass');
      expect(r.removed).toEqual([]);
      expect(r.lines).toContain('docs/no-tests (empty lane): notes/plan.md');
    });

    test('a deleted test whose merge-base text cannot be read (over 1 MiB) fails closed', () => {
      const big = "const test = require('node:test');\nrequire('../lib/util.js');\n// " + 'x'.repeat(1024 * 1024) + '\n';
      const repo = fixture({ baseFiles: { 'test/big.test.js': big } });
      commit(repo, { 'test/big.test.js': null });
      const r = lanes(repo);
      expect(r.status).toBe(1);
      expect(r.check.code).toBe('PREGATE_NO_LANE');
      expect(r.check.detail).toContain('test/big.test.js');
    });
  });
});
