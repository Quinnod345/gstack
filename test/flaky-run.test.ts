/**
 * gstack-flaky run (GSTA-158): the JUnit reader against reports captured from
 * Playwright 1.64 and bun 1.4 (test/fixtures/junit, paths rewritten to /repo),
 * the rerun-once rules, and the bin end to end with a fake runner.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { JunitError, parseJunit, readJunit, testId } from '../lib/junit';
import { renderResult, rerunSelection, runFlaky, safeExcerpt, stepSummary, unreportedFailures } from '../lib/flaky-run';

const ROOT = path.resolve(import.meta.dir, '..');
const FIX = path.join(ROOT, 'test', 'fixtures', 'junit');
const fixture = (name: string) => fs.readFileSync(path.join(FIX, name), 'utf-8');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-flaky-'));
const tmp = () => fs.mkdtempSync(path.join(TMP, 't-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe('JUnit reader', () => {
  test('bun: nested describe path, skip, failure excerpt', () => {
    const r = parseJunit(fixture('bun.xml'));
    expect(r.runner).toBe('bun');
    expect(r.tests.map(t => [t.id, t.attempts.join(',')])).toEqual([
      ['a.test.ts::::outer > inner > passes', 'pass'],
      ['a.test.ts::::outer > inner > fails', 'fail'],
      ['a.test.ts::::outer > skipped', 'skip'],
      ['a.test.ts::::top level', 'pass'],
    ]);
    expect(r.tests[1]!.excerpt[0]).toContain('expect(received).toBe(expected)');
  });

  test('playwright: one id per project, retry-aware attempts', () => {
    const r = parseJunit(fixture('playwright-r2-inc.xml'));
    expect(r.runner).toBe('playwright');
    expect(r.retriesHidden).toBe(false);
    const byId = Object.fromEntries(r.tests.map(t => [t.id, t.attempts.join(',')]));
    expect(byId['a.spec.ts::alpha::group one > fails always']).toBe('fail,fail,fail');
    expect(byId['a.spec.ts::beta::group one > fails always']).toBe('fail,fail,fail');
    expect(byId['a.spec.ts::alpha::group one > flaky once']).toBe('fail,pass');
    expect(byId['a.spec.ts::alpha::group one > skipped']).toBe('skip');
    expect(byId['a.spec.ts::alpha::group one > title with $(rm -rf) [x] (y)? *']).toBe('pass');
  });

  test('playwright retries without retry data are detected, not read as one attempt', () => {
    expect(parseJunit(fixture('playwright-r2.xml')).retriesHidden).toBe(true);
    expect(parseJunit(fixture('playwright-r0.xml')).retriesHidden).toBe(false);
  });

  test('missing, empty, zero-testcase and malformed reports are errors, never green', () => {
    const dir = tmp();
    const code = (fn: () => unknown) => { try { fn(); return 'ok'; } catch (e) { return (e as JunitError).code; } };
    expect(code(() => readJunit(path.join(dir, 'absent.xml')))).toBe('FLAKY_NO_RESULTS');
    fs.writeFileSync(path.join(dir, 'empty.xml'), '  \n');
    expect(code(() => readJunit(path.join(dir, 'empty.xml')))).toBe('FLAKY_NO_RESULTS');
    expect(code(() => parseJunit('<testsuites name="x"><testsuite name="s" tests="0"/></testsuites>'))).toBe('FLAKY_NO_RESULTS');
    expect(code(() => parseJunit('<testsuites><testsuite name="s"><testcase name="a"></testsuite></testsuites>'))).toBe('FLAKY_JUNIT_INVALID');
  });

  test('generic runners (jest, pytest): file from the testcase, entities decoded', () => {
    const r = parseJunit('<?xml version="1.0"?><testsuites><testsuite name="pytest"><testcase classname="tests.test_a" name="test_x[a&amp;b]" file="tests/test_a.py"><error message="boom"/></testcase></testsuite></testsuites>');
    expect(r.runner).toBe('generic');
    expect(r.tests[0]!.id).toBe('tests/test_a.py::::test_x[a&b]');
    expect(r.tests[0]!.attempts).toEqual(['fail']);
  });
});

describe('rerun selection', () => {
  const pw = parseJunit(fixture('playwright-r0.xml')).tests.find(t => t.path.at(-1)!.startsWith('title with') && t.project === 'beta')!;
  test('playwright: file and title regex-escaped, project kept, each one argv element', () => {
    expect(rerunSelection('playwright', pw)).toEqual([
      'a\\.spec\\.ts', '--grep', '(?:^|\\s)group one title with \\$\\(rm -rf\\) \\[x\\] \\(y\\)\\? \\*(?:\\s|$)', '--project', 'beta',
    ]);
  });
  test('bun: anchored space-joined path', () => {
    const t = parseJunit(fixture('bun.xml')).tests[1]!;
    expect(rerunSelection('bun', t)).toEqual(['a.test.ts', '--test-name-pattern', '^outer inner fails$']);
  });
  test('generic: templates substitute into single argv elements; none given is a coded refusal', () => {
    const t = parseJunit('<testsuites><testsuite name="s"><testcase name="a b; rm x" file="t.py"><failure/></testcase></testsuite></testsuites>').tests[0]!;
    expect(rerunSelection('generic', t, ['{file}', '-k', '{title}'])).toEqual(['t.py', '-k', 'a b; rm x']);
    expect(() => rerunSelection('generic', t)).toThrow(JunitError);
  });
});

/** A fake runner: argv selection decides which canned report the attempt writes. */
function fakeRun(reports: (argv: string[], n: number) => string | null, exits: (argv: string[], n: number) => number, outputs: (argv: string[], n: number) => string = () => '') {
  const calls: string[][] = [];
  return {
    calls,
    spawn(junit: string) {
      return async (argv: string[], _env: NodeJS.ProcessEnv, cwd: string) => {
        calls.push(argv);
        const xml = reports(argv, calls.length);
        if (xml !== null) fs.writeFileSync(path.resolve(cwd, junit), xml);
        return { exit: exits(argv, calls.length), output: outputs(argv, calls.length) };
      };
    },
  };
}

const suite = (cases: string) => `<testsuites name="bun test"><testsuite name="a.test.ts" file="a.test.ts">${cases}</testsuite></testsuites>`;
const pass = (name: string) => `<testcase name="${name}" classname="" file="a.test.ts"/>`;
const fail = (name: string, msg = 'boom') => `<testcase name="${name}" classname="" file="a.test.ts"><failure message="${msg}"/></testcase>`;

describe('runFlaky', () => {
  const base = (spawn: ReturnType<typeof fakeRun>, dir: string, extra: Partial<Parameters<typeof runFlaky>[0]> = {}) =>
    runFlaky({ command: ['bun', 'test'], junit: 'r.xml', maxReruns: 3, cwd: dir, spawn: spawn.spawn('r.xml'), env: {}, now: () => new Date('2026-10-29T00:00:00Z'), ...extra });

  test('a failed test that passes on rerun is a flaky pass and goes on the ledger', async () => {
    const dir = tmp();
    const f = fakeRun((argv, n) => n === 1 ? suite(pass('a') + fail('b')) : suite(pass('b')), (_a, n) => n === 1 ? 1 : 0);
    const r = await base(f, dir);
    expect(r.exitCode).toBe(0);
    expect(f.calls[1]).toEqual(['bun', 'test', 'a.test.ts', '--test-name-pattern', '^b$']);
    expect(r.outcomes.map(o => [o.status, o.attempts.join(',')])).toEqual([['flaky-pass', 'fail,pass']]);
    expect(r.ledger).toHaveLength(1);
    expect(r.ledger[0]).toMatchObject({ kind: 'flaky-pass', id: 'a.test.ts::::b', rerun_by: 'gstack-flaky', attempts: ['fail', 'pass'], excerpt: ['boom'] });
    expect(renderResult(r, '/l.jsonl').at(-1)).toBe('FLAKY_RESULT: tests=2 failed=0 flaky=1 reruns=1 command_exit=1 verdict=pass ledger=/l.jsonl');
    expect(stepSummary(r)).toContain('a.test.ts::::b');
  });

  test('a test that fails its rerun is red and is ledgered as rerun-fail', async () => {
    const dir = tmp();
    const f = fakeRun(() => suite(fail('b')), () => 1);
    const r = await base(f, dir);
    expect(r.exitCode).toBe(1);
    expect(r.outcomes[0]).toMatchObject({ status: 'rerun-fail', attempts: ['fail', 'fail'] });
    expect(r.ledger[0]!.kind).toBe('rerun-fail');
  });

  test('more failures than --max-reruns: a real red, nothing rerun', async () => {
    const dir = tmp();
    const f = fakeRun(() => suite(fail('a') + fail('b') + fail('c') + fail('d')), () => 1);
    const r = await base(f, dir);
    expect(r.exitCode).toBe(1);
    expect(f.calls).toHaveLength(1);
    expect(r.reruns).toBe(0);
    expect(r.outcomes.every(o => o.status === 'fail' && /more than --max-reruns 3/.test(o.reason!))).toBe(true);
    expect(r.ledger).toEqual([]);
  });

  test('runner retries stand: no second rerun, and a runner flaky pass is ledgered', async () => {
    const dir = tmp();
    const f = fakeRun(() => fixture('playwright-r2-inc.xml'), () => 1);
    const r = await base(f, dir);
    expect(f.calls).toHaveLength(1);
    expect(r.exitCode).toBe(1);
    expect(r.ledger.filter(l => l.kind === 'flaky-pass').map(l => [l.id, l.rerun_by])).toEqual([
      ['a.spec.ts::alpha::group one > flaky once', 'runner'], ['a.spec.ts::beta::group one > flaky once', 'runner'],
    ]);
    expect(r.outcomes.filter(o => o.status === 'fail').every(o => /already retried \(3 attempts\)/.test(o.reason!))).toBe(true);
  });

  test('hidden Playwright retries refuse with a code instead of a guess', async () => {
    const dir = tmp();
    const r = await base(fakeRun(() => fixture('playwright-r2.xml'), () => 1), dir);
    expect([r.exitCode, r.code]).toEqual([3, 'FLAKY_RETRIES_HIDDEN']);
  });

  test('no report, a stale report, and a crash with no failed test are never green', async () => {
    const dir = tmp();
    expect(await base(fakeRun(() => null, () => 0), dir)).toMatchObject({ exitCode: 3, code: 'FLAKY_NO_RESULTS' });
    fs.writeFileSync(path.join(dir, 'r.xml'), suite(pass('stale')));
    expect(await base(fakeRun(() => null, () => 0), dir)).toMatchObject({ exitCode: 3, code: 'FLAKY_NO_RESULTS' });
    expect(await base(fakeRun(() => suite(pass('a')), () => 2), dir)).toMatchObject({ exitCode: 3, code: 'FLAKY_COMMAND_FAILED', commandExit: 2 });
  });

  test('a rerun that does not report the targeted test fails it; other tests in the rerun are ignored', async () => {
    const dir = tmp();
    const f = fakeRun((_a, n) => n === 1 ? suite(fail('b')) : suite(pass('other')), (_a, n) => n === 1 ? 1 : 0);
    const r = await base(f, dir);
    expect(r.exitCode).toBe(1);
    expect(r.outcomes[0]).toMatchObject({ status: 'rerun-fail', reason: 'rerun: the report does not contain this test' });
  });

  test('a rerun whose command exits non-zero is not a flaky pass, even with a passing report', async () => {
    const dir = tmp();
    const f = fakeRun((_a, n) => n === 1 ? suite(fail('b')) : suite(pass('b')), () => 1);
    expect((await base(f, dir)).outcomes[0]).toMatchObject({ status: 'rerun-fail', reason: 'rerun: the command exited 1' });
  });

  test('a test reported twice with one failure is red and not rerun', async () => {
    const dir = tmp();
    const r = parseJunit(suite(pass('b') + fail('b')));
    expect(r.tests[0]).toMatchObject({ executions: 2, attempts: ['pass', 'fail'] });
    const f = fakeRun(() => suite(fail('b') + pass('b') + fail('c')), () => 1);
    const out = await base(f, dir);
    expect(out.outcomes.find(o => o.test.id.endsWith('::b'))).toMatchObject({ status: 'fail', reason: 'it ran 2 times in this report and one failed; not rerun' });
    expect(f.calls).toHaveLength(2);
  });

  test('the Playwright environment flag reaches every attempt', async () => {
    const dir = tmp();
    const seen: string[] = [];
    await runFlaky({ command: ['x'], junit: 'r.xml', maxReruns: 3, cwd: dir, env: {}, spawn: async (_a, env, cwd) => {
      seen.push(env.PLAYWRIGHT_JUNIT_INCLUDE_RETRIES ?? '');
      fs.writeFileSync(path.join(cwd, 'r.xml'), suite(seen.length === 1 ? fail('b') : pass('b')));
      return { exit: seen.length === 1 ? 1 : 0, output: '' };
    } });
    expect(seen).toEqual(['1', '1']);
  });

  test('bun load errors the JUnit omits keep the run red and nothing is rerun', async () => {
    const dir = tmp();
    const f = fakeRun(() => suite(fail('b')), () => 1, () => '\n 0 pass\n 3 fail\n 2 errors\nRan 3 tests across 3 files.\n');
    const r = await base(f, dir);
    expect(r).toMatchObject({ exitCode: 1, code: 'FLAKY_UNREPORTED_FAILURES', reruns: 0 });
    expect(f.calls).toHaveLength(1);
  });

  test('runner summaries: Playwright errors outside tests and count mismatches are unreported failures', () => {
    expect(unreportedFailures('playwright', '  1 error was not a part of any test, see above for details\n  1 failed\n', 1)).toContain('outside any test');
    expect(unreportedFailures('playwright', '  2 failed\n  10 passed\n', 1)).toContain('counted 2 failed');
    expect(unreportedFailures('playwright', '  1 failed\n  [chromium] x\n  10 passed\n', 1)).toBeNull();
    expect(unreportedFailures('bun', ' 4 pass\n 1 fail\n', 1)).toBeNull();
    expect(unreportedFailures('generic', '5 failed', 0)).toBeNull();
  });

  test('credentials in failure text never reach the ledger', () => {
    const key = ['sk', 'ant', 'api03', 'A'.repeat(93) + 'AA'].join('-');
    const out = safeExcerpt([`Error: request failed with key ${key}`]);
    expect(out.join('\n')).not.toContain(key);
  });
});

describe('bin/gstack-flaky', () => {
  test('run: a fake bun runner flakes once, the bin reruns it and exits 0 with a ledger line', () => {
    const dir = tmp();
    const runner = path.join(dir, 'runner.sh');
    fs.writeFileSync(runner, [
      '#!/usr/bin/env bash',
      'n=$(cat count 2>/dev/null || echo 0); echo $((n+1)) > count',
      `if [ "$n" = 0 ]; then printf '%s' '${suite(pass('a') + fail('b'))}' > r.xml; exit 1; fi`,
      '[ "$1" = a.test.ts ] && [ "$2" = --test-name-pattern ] && [ "$3" = "^b$" ] || exit 9',
      `printf '%s' '${suite(pass('b'))}' > r.xml`,
    ].join('\n'), { mode: 0o755 });
    const ledger = path.join(dir, 'ledger.jsonl');
    const r = spawnSync(path.join(ROOT, 'bin', 'gstack-flaky'), ['run', '--junit', 'r.xml', '--runner', 'bun', '--ledger', ledger, '--', runner], { cwd: dir, encoding: 'utf-8', timeout: 30_000, env: { ...process.env, GITHUB_ACTIONS: '', GITHUB_STEP_SUMMARY: '' } });
    expect(r.stdout).toContain('FLAKY: flaky-pass a.test.ts::::b attempts=fail,pass');
    expect(r.stdout).toContain(`verdict=pass ledger=${ledger}`);
    expect(r.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(ledger, 'utf-8').trim()).kind).toBe('flaky-pass');
  });

  test('usage and missing reports exit with their codes', () => {
    const dir = tmp();
    const bin = path.join(ROOT, 'bin', 'gstack-flaky');
    expect(spawnSync(bin, ['run', '--', 'true'], { cwd: dir, encoding: 'utf-8', timeout: 30_000 }).status).toBe(2);
    const r = spawnSync(bin, ['run', '--junit', 'r.xml', '--', 'true'], { cwd: dir, encoding: 'utf-8', timeout: 30_000 });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('(FLAKY_NO_RESULTS)');
    expect(r.stderr).toContain('fix: ');
  });

  test('ids prints one id per test', () => {
    const r = spawnSync(path.join(ROOT, 'bin', 'gstack-flaky'), ['ids', '--junit', path.join(FIX, 'bun.xml')], { encoding: 'utf-8', timeout: 30_000 });
    expect(r.stdout.trim().split('\n')).toEqual([testId('a.test.ts', '', ['outer', 'inner', 'passes']), 'a.test.ts::::outer > inner > fails', 'a.test.ts::::outer > skipped', 'a.test.ts::::top level']);
  });
});
