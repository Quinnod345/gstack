/**
 * Paths a branch removes (deleted files and the old name of a rename) owe no lane
 * when only a renamed or deleted test, or JS, TS, Python or Dart code nothing
 * imports or names, goes (issue #3529, gbrain#7829); any other removal owes what
 * an edit owes. Each waived one
 * prints a visible `removed (no lane owed): <path> — <why>` line: a deleted test
 * runs its owning suite (the remaining tests of the files it exercised) or says
 * which subjects lost their last test; a modified file whose only test was
 * deleted still fails, and an unreadable deleted test fails closed.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildGraph, testsFor } from '../lib/pregate/import-graph';
import { BASE_PREGATE, cleanup, commit, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';

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
      'removed (no lane owed): lib/util.js — nothing in the tree references it',
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
    expect(r.removed).toEqual(['removed (no lane owed): lib/util.js — old name of lib/util2.js; nothing in the tree references it']);
    expect(r.ran).toContain('test/util.test.js');
  });

  test('a deleted file no test covered is noted, not failed', () => {
    const repo = fixture();
    commit(repo, { 'lib/orphan.js': null });
    const r = lanes(repo);
    expect(r.check.status).toBe('pass');
    expect(r.removed).toEqual(['removed (no lane owed): lib/orphan.js — nothing in the tree references it']);
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

  test('a deleted test named after a bin/ entrypoint reports that bin when it loses its last test', () => {
    const repo = fixture({ baseFiles: { 'bin/gstack-foo': '#!/bin/sh\necho foo\n', 'test/gstack-foo.test.js': "const test = require('node:test');\ntest('foo', () => {});\n" } });
    commit(repo, { 'test/gstack-foo.test.js': null });
    expect(lanes(repo).removed).toEqual(['removed (no lane owed): test/gstack-foo.test.js — coverage removed: bin/gstack-foo has no remaining test']);
  });

  test('a file declared no lane needed never reads as lost coverage', () => {
    const repo = fixture({ pregate: { ...BASE_PREGATE, dependencies: { ...BASE_PREGATE.dependencies, 'lib/util.js': [] } } });
    commit(repo, { 'test/util.test.js': null });
    const r = lanes(repo);
    expect(r.check.status).toBe('pass');
    expect(r.removed).toEqual(['removed (no lane owed): test/util.test.js — its files keep indirect or declared coverage']);
    expect(r.check.detail).not.toContain('lost their last test');
  });

  test('the owning suite is the tests that exercise the same files directly, not every test that reaches them', () => {
    const wrap = "exports.addTwice = (a) => require('./util.js').add(a, a);\n";
    const wrapTest = "const test = require('node:test');\nconst assert = require('node:assert');\nconst { addTwice } = require('../lib/wrap.js');\ntest('twice', () => assert.strictEqual(addTwice(2), 4));\n";
    const repo = fixture({ baseFiles: { 'lib/wrap.js': wrap, 'test/wrap.test.js': wrapTest, 'test/util-v2.test.js': UTIL_V2 } });
    commit(repo, { 'test/util.test.js': null });
    const r = lanes(repo);
    expect(r.removed).toEqual(['removed (no lane owed): test/util.test.js — owning suite runs: test/util-v2.test.js']);
    expect(r.ran).not.toContain('test/wrap.test.js');
  });

  test('a test renamed to a non-test path is accounted for like a deleted test', () => {
    const repo = fixture();
    move(repo, 'test/util.test.js', 'docs/util-notes.md');
    expect(lanes(repo).removed).toEqual(['removed (no lane owed): test/util.test.js — coverage removed: lib/util.js has no remaining test']);
  });

  test('a deleted Rust module selects its crate\'s tests', () => {
    const repo = fixture({ baseFiles: { 'crates/demo/Cargo.toml': '[package]\nname = "demo"\nversion = "0.1.0"\n', 'crates/demo/src/lib.rs': 'pub mod gone;\n#[cfg(test)]\nmod tests {\n  #[test]\n  fn t() {}\n}\n', 'crates/demo/src/gone.rs': 'pub fn f() {}\n' } });
    commit(repo, { 'crates/demo/src/gone.rs': null });
    const g = buildGraph(repo.work, { extraFiles: ['crates/demo/src/gone.rs'] });
    expect(testsFor(g, 'crates/demo/src/gone.rs').tests).toEqual(['crates/demo/src/lib.rs']);
  });

  describe('negative controls', () => {
    test('deleting every file of a fixture directory a remaining test reads selects that test', () => {
      const reader = "const test = require('node:test');\nconst fs = require('node:fs');\ntest('reads the fixture dir', () => { fs.readdirSync('test/fixtures/data'); });\n";
      const repo = fixture({ baseFiles: { 'test/fixtures/data/a.json': '{}\n', 'test/fixtures/data/b.json': '{}\n', 'test/fixture-dir.test.js': reader } });
      commit(repo, { 'test/fixtures/data/a.json': null, 'test/fixtures/data/b.json': null });
      const r = lanes(repo);
      expect(r.removed).toEqual([]);
      expect(r.ran).toContain('test/fixture-dir.test.js');
    });

    test.each(['package.json', '.github/workflows/windows.yml', 'test/golden/digest.txt'])('deleting %s owes what editing it owes: PREGATE_NO_LANE', file => {
      const repo = fixture();
      commit(repo, { [file]: null });
      const r = lanes(repo);
      expect(r.check.code).toBe('PREGATE_NO_LANE');
      expect(r.check.detail).toContain(file);
      expect(r.removed).toEqual([]);
    });

    test('a deleted source file a remaining config still names fails closed', () => {
      const repo = fixture({ baseFiles: { 'scripts/setup.js': "console.log('setup');\n", 'bunfig.toml': '[test]\npreload = ["./scripts/setup.js"]\n' } });
      commit(repo, { 'scripts/setup.js': null });
      const r = lanes(repo);
      expect(r.check.code).toBe('PREGATE_NO_LANE');
      expect(r.check.detail).toContain('scripts/setup.js');
    });

    test.each([
      ['a relative extensionless TS import', { 'src/d.ts': 'export const d = 1;\n', 'src/u.ts': "import { d } from './d';\nexport const u = d + 1;\n" }, 'src/d.ts', 'src/u.ts'],
      ['a Python dotted import', { 'pkg/__init__.py': '', 'pkg/m.py': 'X = 1\n', 'app.py': 'from pkg import m\nprint(m.X)\n' }, 'pkg/m.py', 'app.py'],
    ])('a deleted file untested code still imports by %s fails closed', (_how, files, deleted, importer) => {
      const repo = fixture({ baseFiles: files });
      commit(repo, { [deleted]: null });
      const r = lanes(repo);
      expect(r.check.code).toBe('PREGATE_NO_LANE');
      expect(r.check.detail).toContain(deleted);
      expect(r.removed).toEqual([]);
      const why = runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'tests', '--explain']);
      expect(`${why.out}${why.err}`).toContain(`${deleted}: removed, but still imported by ${importer}`);
    });

    const GO_MOD = 'module example.com/demo\n\ngo 1.22\n';
    test.each([
      ['a Go file its package still uses', { 'go.mod': GO_MOD, 'pkg/value.go': 'package pkg\n\nfunc value() int { return 1 }\n', 'pkg/main.go': 'package pkg\n\nfunc Main() int { return value() }\n' }, 'pkg/value.go', 'not JS, TS, Python or Dart'],
      ['a Go test whose package may share its helpers', { 'go.mod': GO_MOD, 'pkg/a.go': 'package pkg\n', 'pkg/a_test.go': 'package pkg\n\nfunc helper() {}\n', 'pkg/b_test.go': 'package pkg\n' }, 'pkg/a_test.go', 'Go or Ruby test may define helpers'],
      ['a Ruby file loaded by require_relative', { 'lib/value.rb': 'VALUE = 1\n', 'lib/main.rb': "require_relative 'value'\n" }, 'lib/value.rb', 'not JS, TS, Python or Dart'],
      ['a shell helper a bin sources', { 'bin/helper.sh': 'greet() { echo hi; }\n', 'bin/tool': '#!/bin/sh\nDIR=$(dirname "$0")\n. "$DIR/helper.sh"\ngreet\n' }, 'bin/helper.sh', 'not JS, TS, Python or Dart'],
      ['a config its runner loads by name', { 'vitest.config.ts': 'export default {};\n' }, 'vitest.config.ts', 'loaded by name'],
      ['a Python startup file', { 'sitecustomize.py': 'import builtins\nbuiltins.FEATURE = True\n' }, 'sitecustomize.py', 'loaded by name'],
      ['a setup file a nested config names relative to itself', { 'packages/app/setup.ts': 'export {};\n', 'packages/app/bunfig.toml': '[test]\npreload = ["./setup.ts"]\n' }, 'packages/app/setup.ts', 'still named by packages/app/bunfig.toml'],
    ])('deleting %s fails closed', (_what, files, deleted, why) => {
      const repo = fixture({ baseFiles: files });
      commit(repo, { [deleted]: null });
      const r = lanes(repo);
      expect(r.check.code).toBe('PREGATE_NO_LANE');
      expect(r.removed).toEqual([]);
      const explain = runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'tests', '--explain']);
      expect(explain.out + explain.err).toContain(deleted + ': removed');
      expect(explain.out + explain.err).toContain(why);
    });

    test('a rename into a waived path does not waive the old name: package.json renamed to Markdown fails closed', () => {
      const repo = fixture();
      move(repo, 'package.json', 'docs/package.md');
      const r = lanes(repo);
      expect(r.check.code).toBe('PREGATE_NO_LANE');
      expect(r.check.detail).toContain('package.json');
      expect(r.removed).toEqual([]);
    });

    test('a renamed source remaining untested code still imports by its old name fails closed', () => {
      const repo = fixture({ baseFiles: { 'lib/a.js': 'exports.a = 1;\n', 'lib/u.js': "exports.u = require('./a.js').a;\n", 'notes/plan.md': '# plan\n' } });
      move(repo, 'lib/a.js', 'notes/a.md');
      const r = lanes(repo);
      expect(r.check.code).toBe('PREGATE_NO_LANE');
      expect(r.check.detail).toContain('lib/a.js');
      expect(r.removed).toEqual([]);
    });

    test('a deleted file a remaining bin reads through its directory fails closed', () => {
      const repo = fixture({ baseFiles: { 'lib/plugins/a.js': 'exports.a = 1;\n', 'lib/plugins/b.js': 'exports.b = 2;\n', 'bin/load.js': "const fs = require('node:fs');\nfor (const f of fs.readdirSync('lib/plugins')) require('../lib/plugins/' + f);\n" } });
      commit(repo, { 'lib/plugins/a.js': null });
      const r = lanes(repo);
      expect(r.check.code).toBe('PREGATE_NO_LANE');
      expect(r.removed).toEqual([]);
      const explain = runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'tests', '--explain']);
      expect(explain.out + explain.err).toContain('lib/plugins/a.js: removed, but still imported by bin/load.js');
    });

    test('a deleted file a tested loader reaches by a computed path fails closed', () => {
      const loader = "const path = require('node:path');\nexports.value = () => require(path.join(__dirname, 'lib', 'value.js')).value;\n";
      const loaderTest = "const test = require('node:test');\nconst { value } = require('../loader.js');\ntest('loads', () => value());\n";
      const repo = fixture({ baseFiles: { 'lib/value.js': 'exports.value = 1;\n', 'loader.js': loader, 'test/loader.test.js': loaderTest } });
      commit(repo, { 'lib/value.js': null });
      const r = lanes(repo);
      expect(r.check.code).toBe('PREGATE_NO_LANE');
      expect(r.removed).toEqual([]);
      const explain = runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'tests', '--explain']);
      expect(explain.out + explain.err).toContain('lib/value.js: removed, but still named by loader.js');
    });

    test('a Go test renamed into another directory is refused: its old package may still call its helpers', () => {
      const repo = fixture({ baseFiles: { 'go.mod': 'module example.com/demo\n\ngo 1.22\n', 'pkg/a.go': 'package pkg\n', 'pkg/a_test.go': 'package pkg\n\nfunc helper() {}\n', 'pkg/b_test.go': 'package pkg\n\nfunc TestB(t *testing.T) { helper() }\n', 'isolated/keep.go': 'package isolated\n' } });
      move(repo, 'pkg/a_test.go', 'isolated/a_test.go');
      const r = lanes(repo);
      expect(r.check.code).toBe('PREGATE_NO_LANE');
      expect(r.check.detail).toContain('pkg/a_test.go');
      expect(r.removed).toEqual([]);
    });

    test('a modified file whose only test was deleted still fails PREGATE_NO_LANE', () => {
      const repo = fixture();
      commit(repo, { 'test/util.test.js': null, 'lib/util.js': "exports.add = (a, b) => b + a;\n" });
      const r = lanes(repo);
      expect(r.status).toBe(1);
      expect(r.check.code).toBe('PREGATE_NO_LANE');
      expect(r.check.detail).toContain('lib/util.js');
      expect(r.check.detail).not.toContain('test/util.test.js');
      expect(r.check.detail).toContain('1 removed path(s); 1 subject(s) lost their last test');
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
