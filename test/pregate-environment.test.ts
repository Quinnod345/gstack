/**
 * Lane D (GSTA-112, E6): a pregate failure the environment caused (a runner
 * binary missing from PATH, a network error before any test ran, a quota
 * refusal from the remote gate, a guard that cannot start) is classified and
 * reported apart from a failure the diff caused, under its own result code
 * `PREGATE_ENVIRONMENT` with a kind and the evidence, so a lane can waive by
 * cause instead of by test name (truther #617). A failing test whose log also
 * mentions a network error is still a diff failure: the runner's own summary
 * decides, never the log alone.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { classifyEnvironment } from '../lib/pregate/environment';
import { BASE_PREGATE, cleanup, commit, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
const fixture = (pregate: Record<string, unknown>, baseFiles?: Record<string, string>) => { const r = makeFixtureRepo({ pregate, baseFiles }); repos.push(r); return r; };
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });
const pregate = (repo: FixtureRepo, args: string[]) => runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--only', 'lanes,guards', ...args]);
const readOut = (repo: FixtureRepo) => JSON.parse(fs.readFileSync(path.join(repo.work, '.gstack/tmp/pregate.json'), 'utf8'));
const check = (repo: FixtureRepo, id: string) => readOut(repo).checks.find((c: any) => c.id === id);
const UTIL_EDIT = { 'lib/util.js': 'exports.add = (a, b) => b + a;\n' };

describe('classifyEnvironment', () => {
  // Value: protects=the classifier's vocabulary and its silence on ordinary failures; fails_when=a plain assertion failure or a
  //   non-zero exit with a test summary reads as environment, or exit 127 / ENOTFOUND / quota text does not; why_new=new module;
  //   seam=none; no_claim=completeness of the vocabulary
  test('names missing-binary, network, quota and disk, and stays null for an ordinary failure', () => {
    expect(classifyEnvironment('bash: line 1: vitest: command not found', 127)?.kind).toBe('missing-binary');
    expect(classifyEnvironment('', 127)?.kind).toBe('missing-binary');
    expect(classifyEnvironment("'nope' is not recognized as an internal or external command", 1)?.kind).toBe('missing-binary');
    expect(classifyEnvironment('Error: getaddrinfo ENOTFOUND registry.example.invalid', 1)).toEqual({ kind: 'network', evidence: 'getaddrinfo ENOTFOUND registry.example.invalid' });
    expect(classifyEnvironment('curl: (7) Failed to connect to host port 443: Connection refused', 7)?.kind).toBe('network');
    expect(classifyEnvironment('ubicloud: vcpu quota exceeded (528/512)', 1)?.kind).toBe('quota');
    expect(classifyEnvironment('HTTP 429 Too Many Requests', 1)?.kind).toBe('quota');
    expect(classifyEnvironment('ENOSPC: no space left on device, write', 1)?.kind).toBe('disk');
    expect(classifyEnvironment('AssertionError: expected 3 to be 4', 1)).toBeNull();
    expect(classifyEnvironment('✖ fetches the thing\n  ECONNREFUSED 127.0.0.1:3000\nℹ tests 1\nℹ fail 1', 1)?.kind).toBe('network');
  });
});

describe('environment failures are reported apart from diff failures', () => {
  // Value: protects=a runner whose binary is missing is PREGATE_ENVIRONMENT missing-binary (incomplete, cause environment) rather
  //   than a lane failure that reads as the diff's fault; fails_when=the lane is PREGATE_LANE_FAILED with no cause (the behaviour
  //   before this change); why_new=the code and cause are new; seam=none; no_claim=none
  test('a runner binary missing from PATH is PREGATE_ENVIRONMENT missing-binary, incomplete, cause environment', () => {
    const repo = fixture({ ...BASE_PREGATE, runner: 'gstack-fixture-runner-that-does-not-exist {files}' });
    commit(repo, UTIL_EDIT);
    const r = pregate(repo, []);
    expect(r.status).toBe(EXIT.fail);
    expect(r.err).toContain('(PREGATE_ENVIRONMENT)');
    expect(r.err).not.toContain('PREGATE_LANE_FAILED');
    const c = check(repo, 'lanes');
    expect([c.status, c.code, c.cause, c.environment.kind]).toEqual(['incomplete', 'PREGATE_ENVIRONMENT', 'environment', 'missing-binary']);
    expect(c.environment.evidence).toContain('gstack-fixture-runner-that-does-not-exist');
    expect(r.out).toContain('environment: missing-binary');
    const verify = runBin(repo, 'gstack-pregate', ['verify']);
    expect(verify.status).toBe(EXIT.fail);
    expect(verify.err).toContain('(PREGATE_ENVIRONMENT)');
    expect(verify.err).toContain('blocked by the environment (missing-binary), not by the diff');
  });

  // Value: protects=a runner that dies on a network error before reporting any test is environment/network, while a test that
  //   failed and whose log also names a connection error stays a diff failure (its summary counted a failure); fails_when=either
  //   direction is misread; why_new=the summary-first rule is new; seam=none; no_claim=none
  test('a network error with no test summary is environment; a counted test failure beside a network line is still the diff', () => {
    const net = fixture({ ...BASE_PREGATE, runner: 'node scripts/net.js {files}' }, { 'scripts/net.js': "console.error('Error: getaddrinfo ENOTFOUND registry.example.invalid');\nprocess.exit(1);\n" });
    commit(net, UTIL_EDIT);
    pregate(net, []);
    const c = check(net, 'lanes');
    expect([c.status, c.code, c.cause, c.environment.kind]).toEqual(['incomplete', 'PREGATE_ENVIRONMENT', 'environment', 'network']);
    const diff = fixture({ ...BASE_PREGATE, runner: 'node scripts/fail.js {files}' }, { 'scripts/fail.js': "console.log('✖ talks to the server\\n  Error: connect ECONNREFUSED 127.0.0.1:3000\\nℹ tests 1\\nℹ pass 0\\nℹ fail 1');\nprocess.exit(1);\n" });
    commit(diff, UTIL_EDIT);
    const r = pregate(diff, []);
    expect(r.err).toContain('(PREGATE_LANE_FAILED)');
    const d = check(diff, 'lanes');
    expect([d.status, d.code, d.cause]).toEqual(['fail', 'PREGATE_LANE_FAILED', 'diff']);
    expect(d.environment).toBeUndefined();
  });

  // Value: protects=a remote gate refused by a quota (no PREGATE_REMOTE line) is environment/quota and the obligation stays
  //   uncleared; fails_when=it is a generic PREGATE_INCOMPLETE; why_new=new; seam=none; no_claim=none
  test('a remote gate that hit a quota is PREGATE_ENVIRONMENT quota and leaves the obligation uncleared', () => {
    const repo = fixture({ ...BASE_PREGATE, remote_gate: 'node scripts/gate.js' }, { 'scripts/gate.js': "console.error('ubicloud: vcpu quota exceeded (528/512)');\nprocess.exit(1);\n" });
    commit(repo, UTIL_EDIT);
    const r = pregate(repo, ['--remote', '--spend-cap', '1']);
    expect(r.status).toBe(EXIT.fail);
    expect(r.err).toContain('(PREGATE_ENVIRONMENT)');
    const c = check(repo, 'lanes');
    expect([c.status, c.cause, c.environment.kind]).toEqual(['incomplete', 'environment', 'quota']);
    expect(readOut(repo).requires_remote.find((o: any) => o.lane === 'pregate.json/remote_gate').receipt).toBeNull();
  });

  // Value: protects=guards classify the same way: a guard whose command is missing is environment, a guard that fails on its
  //   own terms is the diff; fails_when=a missing guard binary is PREGATE_GUARD_FAILED; why_new=new; seam=none; no_claim=none
  test('a guard whose binary is missing is environment; a guard that fails is the diff', () => {
    const repo = fixture({ ...BASE_PREGATE, guards: [{ id: 'absent', when: ['lib/**'], command: 'gstack-fixture-guard-that-does-not-exist --check' }, { id: 'red', when: ['lib/**'], command: 'node -e "process.exit(2)"', fix: 'fix it' }] });
    commit(repo, UTIL_EDIT);
    const r = pregate(repo, ['--only', 'guards']);
    expect(r.status).toBe(EXIT.fail);
    const g = check(repo, 'guards');
    expect([g.status, g.code, g.cause]).toEqual(['fail', 'PREGATE_GUARD_FAILED', 'diff']);
    expect(g.lines.join('\n')).toContain('environment: missing-binary');
    const only = fixture({ ...BASE_PREGATE, guards: [{ id: 'absent', when: ['lib/**'], command: 'gstack-fixture-guard-that-does-not-exist --check' }] });
    commit(only, UTIL_EDIT);
    pregate(only, ['--only', 'guards']);
    const o = check(only, 'guards');
    expect([o.status, o.code, o.cause, o.environment.kind]).toEqual(['incomplete', 'PREGATE_ENVIRONMENT', 'environment', 'missing-binary']);
  });
});
