/**
 * release-cut (free): the weekly release picks the newest green commit on
 * main's first-parent history, tags it v<VERSION>, fast-forwards stable and
 * publishes notes from the CHANGELOG headlines; a hotfix --ref promotes a
 * named main commit; stable never moves backwards; a frozen queue, a pending
 * check run or a red one keeps a commit out; a cut that stopped half-way is
 * finished by the next run (docs/releases.md).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bunIsolationArgs } from '../lib/bun-isolation';
import {
  BACKSTOP_CHECK, NOTES_CAP, NOTES_REF, REQUIRED_CHECK, changelogEntries, compareVersions, cutRelease, describePlan, gateVerdict, gitIn,
  planRelease, readTrainNotes, releaseNotes, type Gh, type Git,
} from '../scripts/release-cut';

const bases: string[] = [];
afterEach(() => { for (const b of bases.splice(0)) fs.rmSync(b, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } }).trim();
}

type CheckRun = { name: string; status: string; conclusion: string | null };
interface State { checks: Record<string, CheckRun[]>; released: Set<string>; createFails?: string; calls: string[][] }

const GREEN: CheckRun[] = [{ name: REQUIRED_CHECK, status: 'completed', conclusion: 'success' }, { name: BACKSTOP_CHECK, status: 'completed', conclusion: 'success' }, { name: 'typecheck', status: 'completed', conclusion: 'success' }];
const backstop = (status: string, conclusion: string | null): CheckRun[] => [...GREEN.filter(c => c.name !== BACKSTOP_CHECK), { name: BACKSTOP_CHECK, status, conclusion }];

function fakeGh(state: State): Gh {
  return (args) => {
    state.calls.push(args);
    const api = args[0] === 'api' ? args[args.length - 1]! : '';
    const m = /commits\/([0-9a-f]+)\/check-runs/.exec(api);
    if (m) return { status: 0, stdout: JSON.stringify([{ check_runs: state.checks[m[1]!] ?? GREEN }]), stderr: '' };
    if (args[0] === 'release' && args[1] === 'view') return state.released.has(args[2]!) ? { status: 0, stdout: '{}', stderr: '' } : { status: 1, stdout: '', stderr: 'release not found' };
    if (args[0] === 'release' && args[1] === 'create') {
      if (state.createFails === args[2]) return { status: 1, stdout: '', stderr: 'HTTP 502 Bad Gateway' };
      state.released.add(args[2]!); return { status: 0, stdout: 'https://github.com/o/r/releases/tag/' + args[2], stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'unexpected gh ' + args.join(' ') };
  };
}

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-release-cut-'));
  bases.push(base);
  const origin = path.join(base, 'origin.git');
  const seed = path.join(base, 'seed');
  const work = path.join(base, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { timeout: 30_000 });
  fs.mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'remote', 'add', 'origin', origin);
  const shas: Record<string, string> = {};
  let changelog = '# Changelog\n';
  const release = (version: string, headline: string) => {
    changelog = changelog.replace('# Changelog\n', '# Changelog\n\n## [' + version + '] - 2026-10-2' + version.slice(-1) + '\n\n**' + headline + '**\n\n### Fixed\n- a thing\n');
    fs.writeFileSync(path.join(seed, 'VERSION'), version + '\n');
    fs.writeFileSync(path.join(seed, 'CHANGELOG.md'), changelog);
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'v' + version);
    git(seed, 'push', '-q', 'origin', 'main');
    shas[version] = git(seed, 'rev-parse', 'HEAD');
    return shas[version]!;
  };
  release('1.0.0', 'First one.');
  release('1.0.1', 'Second: the updater no longer skips.');
  release('1.0.2', 'Third fixes Windows.');
  release('1.0.3', 'Fourth trims the preamble.');
  execFileSync('git', ['clone', '-q', origin, work], { timeout: 30_000 });
  const refresh = () => { git(work, 'fetch', '-q', 'origin', '+refs/heads/*:refs/remotes/origin/*'); git(work, 'fetch', '-q', '--tags', 'origin'); };
  const state: State = { checks: {}, released: new Set(), calls: [] };
  return { base, origin, seed, work, shas, release, refresh, state, gh: fakeGh(state), git: gitIn(work), repo: 'o/r' };
}

describe('release-cut: planning', () => {
  test('the newest green first-parent commit wins; a pending backstop or a red check keeps a commit out and is named', () => {
    const f = fixture();
    f.state.checks[f.shas['1.0.3']!] = backstop('in_progress', null);
    f.state.checks[f.shas['1.0.2']!] = [...GREEN, { name: 'windows-free-tests', status: 'completed', conclusion: 'failure' }];
    const r = planRelease({ repo: f.repo, git: f.git, gh: f.gh });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.plan.sha).toBe(f.shas['1.0.1']);
    expect(r.plan.version).toBe('1.0.1');
    expect(r.plan.tag).toBe('v1.0.1');
    expect(r.plan.prevStable).toBeNull();
    expect(r.plan.skipped).toEqual([
      f.shas['1.0.3']!.slice(0, 12) + ': ' + BACKSTOP_CHECK + ' is still running',
      f.shas['1.0.2']!.slice(0, 12) + ': red check runs: windows-free-tests',
    ]);
    expect(r.plan.notes).toContain('First tagged release: the 2 versions, one line each');
    expect(r.plan.notes).toContain('- **1.0.1** (2026-10-21): Second: the updater no longer skips.');
    expect(r.plan.notes).toContain('- **1.0.0**');
    expect(r.plan.notes).not.toContain('1.0.2');
    const lines = describePlan(r.plan, true);
    expect(lines.some(l => l.startsWith('DRY_RUN:'))).toBe(true);
    expect(lines).toContain('  git push origin ' + f.shas['1.0.1'] + ':refs/heads/stable');
  });

  test('a missing free-tests run, a running free-tests run, no backstop check run and a superseded (neutral) backstop are not green', () => {
    const f = fixture();
    const head = f.shas['1.0.3']!;
    f.state.checks[head] = [{ name: 'typecheck', status: 'completed', conclusion: 'success' }];
    f.state.checks[f.shas['1.0.2']!] = [{ name: REQUIRED_CHECK, status: 'in_progress', conclusion: null }];
    f.state.checks[f.shas['1.0.1']!] = GREEN.filter(c => c.name !== BACKSTOP_CHECK);
    const r = planRelease({ repo: f.repo, git: f.git, gh: f.gh });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.sha).toBe(f.shas['1.0.0']);
    expect(r.plan.skipped.map(s => s.split(': ')[1])).toEqual(['no free-tests check run', 'free-tests is still running', 'no ' + BACKSTOP_CHECK + ' check run']);
    // A push main moved past before the backstop gated it (train-backstop.ts
    // 'superseded', exit 0) publishes a neutral check run: never green.
    f.state.checks[f.shas['1.0.1']!] = backstop('completed', 'neutral');
    const neutral = planRelease({ repo: f.repo, git: f.git, gh: f.gh });
    expect(neutral.ok).toBe(true);
    if (neutral.ok) { expect(neutral.plan.sha).toBe(f.shas['1.0.0']); expect(neutral.plan.skipped[2]).toBe(f.shas['1.0.1']!.slice(0, 12) + ': ' + BACKSTOP_CHECK + ' concluded neutral'); }
  });

  test('no green commit in the window is NO_GREEN_COMMIT with every skip named; an empty window is NOTHING_NEW', () => {
    const f = fixture();
    for (const sha of Object.values(f.shas)) f.state.checks[sha] = backstop('completed', 'failure');
    const r = planRelease({ repo: f.repo, git: f.git, gh: f.gh });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('NO_GREEN_COMMIT');
    expect(r.skipped).toHaveLength(4);
    expect(r.skipped![0]).toContain(BACKSTOP_CHECK + ' concluded failure');
    const stale = planRelease({ repo: f.repo, git: f.git, gh: f.gh, now: () => Date.now() + 30 * 86_400_000 });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe('NOTHING_NEW');
  });

  // Value: protects=gateVerdict names a failed free-tests run and an unreadable check-runs API as not green, holds a commit with any check run still going as
  // pending, and merges paginated check pages; fails_when=a required-check failure is treated as red-list noise, a gh error reads as green or pending, a queued
  // unrelated check run is read as green, or only the first page of check runs is read; why_new=the planning tests cover missing, running and red runs only,
  // never a failed required run, a gh error, an unrelated running check or a second page; seam=none; no_claim=GitHub's real check-runs payload shape (a fake gh answers; unit only)
  test('gateVerdict: a failed free-tests run, an unreadable check-runs API, an unrelated running check and a paginated check list', () => {
    const checks = (runs: unknown[]): Gh => (args) => {
      const api = args[args.length - 1]!;
      if (/check-runs/.test(api)) return { status: 0, stdout: JSON.stringify(runs), stderr: '' };
      return { status: 1, stdout: '', stderr: 'unexpected gh ' + args.join(' ') };
    };
    const failed = checks([{ check_runs: [{ name: REQUIRED_CHECK, status: 'completed', conclusion: 'failure' }] }]);
    expect(gateVerdict(failed, 'o/r', 'a'.repeat(40))).toEqual({ green: false, why: REQUIRED_CHECK + ' concluded failure', pending: false });
    const unreadable: Gh = () => ({ status: 1, stdout: '', stderr: 'HTTP 403' });
    expect(gateVerdict(unreadable, 'o/r', 'a'.repeat(40))).toEqual({ green: false, why: 'cannot read its check runs', pending: false });
    const garbled: Gh = () => ({ status: 0, stdout: 'not json', stderr: '' });
    expect(gateVerdict(garbled, 'o/r', 'a'.repeat(40))).toEqual({ green: false, why: 'cannot read its check runs', pending: false });
    const queued = checks([{ check_runs: [...GREEN, { name: 'slices-report', status: 'queued', conclusion: null }] }]);
    expect(gateVerdict(queued, 'o/r', 'a'.repeat(40))).toEqual({ green: false, why: 'check runs still going: slices-report', pending: true });
    const paged = checks([{ check_runs: [{ name: 'typecheck', status: 'completed', conclusion: 'success' }, { name: BACKSTOP_CHECK, status: 'completed', conclusion: 'success' }] }, { check_runs: [{ name: REQUIRED_CHECK, status: 'completed', conclusion: 'success' }] }]);
    expect(gateVerdict(paged, 'o/r', 'a'.repeat(40))).toEqual({ green: true, via: BACKSTOP_CHECK });
    const pagedRed = checks([{ check_runs: GREEN }, { check_runs: [{ name: 'windows-free-tests', status: 'completed', conclusion: 'timed_out' }] }]);
    expect(gateVerdict(pagedRed, 'o/r', 'a'.repeat(40))).toEqual({ green: false, why: 'red check runs: windows-free-tests', pending: false });
    const cancelled = checks([{ check_runs: [...GREEN, { name: 'quality', status: 'completed', conclusion: 'cancelled' }, { name: 'docs', status: 'completed', conclusion: 'skipped' }] }]);
    expect(gateVerdict(cancelled, 'o/r', 'a'.repeat(40))).toEqual({ green: false, why: 'red check runs: quality', pending: false });
    const skipped = checks([{ check_runs: [...GREEN, { name: 'docs', status: 'completed', conclusion: 'skipped' }] }]);
    expect(gateVerdict(skipped, 'o/r', 'a'.repeat(40))).toEqual({ green: true, via: BACKSTOP_CHECK });
  });

  test('an active freeze in refs/notes/gstack-trains refuses the cut; a cleared one does not', () => {
    const f = fixture();
    const freeze = { schema: 1, kind: 'freeze', repo_key: 'k', train: 'abc', reason: 'backstop red on 2 cases', created_at: 'x', cleared_at: null };
    git(f.seed, 'notes', '--ref=' + NOTES_REF, 'add', '-m', JSON.stringify(freeze), 'HEAD');
    git(f.seed, 'push', '-q', 'origin', NOTES_REF);
    const frozen = planRelease({ repo: f.repo, git: f.git, gh: f.gh });
    expect(frozen.ok).toBe(false);
    if (!frozen.ok) { expect(frozen.code).toBe('REFUSED'); expect(frozen.message).toContain('queue frozen since train abc: backstop red on 2 cases'); }
    git(f.seed, 'notes', '--ref=' + NOTES_REF, 'add', '-f', '-m', JSON.stringify({ ...freeze, cleared_at: 'y' }), 'HEAD');
    git(f.seed, 'push', '-q', '-f', 'origin', NOTES_REF);
    expect(planRelease({ repo: f.repo, git: f.git, gh: f.gh }).ok).toBe(true);
  });

  // Value: protects=one read of the trains notes ref feeds both gates: a fetch failure other than a missing ref refuses the plan with its message, a
  // missing ref is no freeze and no evidence, a blob that is not JSON, is JSON that is not an object (null, an array, a string, a number), carries a
  // malformed merged[] or a non-string nonce, or is a train without a nonce is skipped while a freeze and a train in the same
  // ref are both read (the freeze still wins over the evidence); fails_when=a fetch error is read as "no notes" and a frozen or ungated main is
  // released, an unparsable note aborts the read, or evidence from a later note is lost once a freeze is seen; why_new=the freeze test covers one
  // readable freeze record only and the evidence tests never mix record kinds or break the fetch; seam=none; no_claim=a real origin outage
  test('readTrainNotes: a fetch error refuses, a missing ref holds nothing, junk notes are skipped, and a freeze beside train evidence still refuses', () => {
    const f = fixture();
    const head = f.shas['1.0.3']!;
    const failing: Git = (args) => (args[0] === 'fetch' ? { ok: false, out: 'fatal: unable to access the remote: Could not resolve host' } : f.git(args));
    const broken = planRelease({ repo: f.repo, git: failing, gh: f.gh });
    expect(broken).toEqual({ ok: false, code: 'REFUSED', message: 'cannot fetch ' + NOTES_REF + ': fatal: unable to access the remote: Could not resolve host' });
    const absent = readTrainNotes(f.git);
    expect([absent.error, absent.freeze, absent.evidence.bySha.size, absent.evidence.byTree.size]).toEqual([null, null, 0, 0]);

    const add = (record: string, on: string) => git(f.seed, 'notes', '--ref=' + NOTES_REF, 'add', '-f', '-m', record, on);
    add('not json {', f.shas['1.0.0']!);
    for (const junk of ['null', '[]', '"train"', '7', JSON.stringify({ kind: 'train', nonce: 'bad1', state: 'green', merged: 'x' }), JSON.stringify({ kind: 'train', nonce: 'bad2', state: 'green', merged: [null, 'y', { sha: 3, tree: ['t'] }, { sha: '', tree: '' }] }), JSON.stringify({ kind: 'train', nonce: 9, state: 'green', merged: [{ sha: f.shas['1.0.0'] }] })]) {
      add(junk, f.shas['1.0.0']!);
      git(f.seed, 'push', '-q', '-f', 'origin', NOTES_REF);
      const read = readTrainNotes(f.git);
      expect([junk, read.error, read.freeze, read.evidence.bySha.size, read.evidence.byTree.size]).toEqual([junk, null, null, 0, 0]);
    }
    add(JSON.stringify({ schema: 1, kind: 'train', state: 'merged', merged: [{ sha: f.shas['1.0.1'], tree: 't1' }] }), f.shas['1.0.1']!);
    add(JSON.stringify({ schema: 1, kind: 'train', nonce: 'ok1', state: 'green', merged: [{ pr: '2' }, { sha: f.shas['1.0.2'] }, { tree: 'tree-only' }] }), f.shas['1.0.2']!);
    add(JSON.stringify({ schema: 1, kind: 'freeze', train: 'ok1', reason: 'backstop red', cleared_at: null }), head);
    git(f.seed, 'push', '-q', '-f', 'origin', NOTES_REF);
    const mixed = readTrainNotes(f.git);
    expect(mixed.error).toBeNull();
    expect(mixed.freeze).toBe('queue frozen since train ok1: backstop red');
    expect([...mixed.evidence.bySha]).toEqual([[f.shas['1.0.2']!, 'ok1']]);
    expect([...mixed.evidence.byTree]).toEqual([['tree-only', 'ok1']]);
    f.state.checks[f.shas['1.0.2']!] = backstop('completed', 'neutral');
    const frozen = planRelease({ repo: f.repo, ref: f.shas['1.0.2'], git: f.git, gh: f.gh });
    expect(frozen).toEqual({ ok: false, code: 'REFUSED', message: 'queue frozen since train ok1: backstop red' });
    add(JSON.stringify({ schema: 1, kind: 'freeze', train: 'ok1', reason: 'backstop red', cleared_at: 'y' }), head);
    git(f.seed, 'push', '-q', '-f', 'origin', NOTES_REF);
    const thawed = planRelease({ repo: f.repo, ref: f.shas['1.0.2'], git: f.git, gh: f.gh });
    expect(thawed.ok, JSON.stringify(thawed)).toBe(true);
    if (thawed.ok) expect(thawed.plan.via).toBe('train ok1');
  });
});

describe('release-cut: train evidence gates a commit whose backstop never settled', () => {
  const train = (nonce: string, state: string, merged: Array<{ sha: string; tree: string }>) =>
    ({ schema: 1, kind: 'train', nonce, state, merged: merged.map(m => ({ pr: '1', at: 'x', ...m })), updated_at: 'x' });
  const note = (f: ReturnType<typeof fixture>, record: unknown, on: string, ref = NOTES_REF) => {
    git(f.seed, 'notes', '--ref=' + ref, 'add', '-f', '-m', JSON.stringify(record), on);
    git(f.seed, 'push', '-q', '-f', 'origin', ref);
  };
  const treeOf = (f: ReturnType<typeof fixture>, sha: string) => git(f.seed, 'rev-parse', sha + '^{tree}');

  // Value: protects=a main commit whose main-backstop check run is neutral (superseded) or absent is released when a green, merging or merged train record's
  // merged[] names its sha or its tree, and the CANDIDATE line says which train gated it; fails_when=the gate still needs a successful backstop run on
  // every commit (the weekly cut returns NO_GREEN_COMMIT for a week of train-merged commits), evidence is matched on sha only, or the plan hides what gated
  // the commit; why_new=the planning tests know only the backstop check run as evidence; seam=none; no_claim=real refs/notes/gstack-trains content (a
  // fixture record shaped like lib/ship-queue-train-record.ts TrainRecord)
  test('a neutral backstop plus a train record naming the sha, or only the tree, is a candidate gated by that train', () => {
    const f = fixture();
    const head = f.shas['1.0.3']!;
    f.state.checks[head] = backstop('completed', 'neutral');
    note(f, train('t1', 'merged', [{ sha: head, tree: treeOf(f, head) }]), head);
    const bySha = planRelease({ repo: f.repo, git: f.git, gh: f.gh });
    expect(bySha.ok, JSON.stringify(bySha)).toBe(true);
    if (!bySha.ok) return;
    expect(bySha.plan.sha).toBe(head);
    expect(bySha.plan.via).toBe('train t1');
    expect(describePlan(bySha.plan, true)[0]).toBe('CANDIDATE: ' + head + ' (' + bySha.plan.date + ') gated by train t1');

    const byTree = fixture();
    const head2 = byTree.shas['1.0.3']!;
    delete byTree.state.checks[head2];
    byTree.state.checks[head2] = GREEN.filter(c => c.name !== BACKSTOP_CHECK);
    note(byTree, train('t2', 'green', [{ sha: 'f'.repeat(40), tree: treeOf(byTree, head2) }]), head2);
    const r = planRelease({ repo: byTree.repo, git: byTree.git, gh: byTree.gh });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) { expect(r.plan.sha).toBe(head2); expect(r.plan.via).toBe('train t2'); }

    const plain = planRelease({ repo: f.repo, ref: f.shas['1.0.2'], git: f.git, gh: f.gh });
    expect(plain.ok).toBe(true);
    if (plain.ok) { expect(plain.plan.via).toBe(BACKSTOP_CHECK); expect(describePlan(plain.plan, false)[0]).toBe('CANDIDATE: ' + f.shas['1.0.2'] + ' (' + plain.plan.date + ') [hotfix: --ref] gated by ' + BACKSTOP_CHECK); }
  });

  // Value: protects=train evidence never relaxes the rest of the gate: a covered commit still needs a successful required check run (also when
  // --required-check and --backstop-check name the same check, where evidence substitutes for nothing), no red check run (a red backstop included),
  // nothing still running, and only a green, merging or merged record counts; fails_when=a covered commit with a failed free-tests run, a red windows lane
  // or a red backstop is released, a running check is not waited for, a red or superseded train record is read as evidence, or equal check names let a
  // covered commit with zero check runs through; why_new=the first train test covers the accepting path only; seam=none; no_claim=none beyond protects
  test('a covered commit is still refused by a red check run, a red backstop, a missing or failed required run, a running run, or a red/superseded record', () => {
    const f = fixture();
    const head = f.shas['1.0.3']!;
    const tree = treeOf(f, head);
    note(f, train('t1', 'merging', [{ sha: head, tree }]), head);
    const gate = (checks: CheckRun[]) => { f.state.checks[head] = checks; const v = planRelease({ repo: f.repo, ref: head, git: f.git, gh: f.gh }); return v.ok ? 'green' : v.message; };
    expect(gate([...backstop('completed', 'neutral'), { name: 'windows-free-tests', status: 'completed', conclusion: 'failure' }])).toBe('--ref ' + head.slice(0, 12) + ' is not green: red check runs: windows-free-tests');
    expect(gate(backstop('completed', 'failure'))).toBe('--ref ' + head.slice(0, 12) + ' is not green: red check runs: ' + BACKSTOP_CHECK);
    expect(gate([{ name: BACKSTOP_CHECK, status: 'completed', conclusion: 'neutral' }])).toBe('--ref ' + head.slice(0, 12) + ' is not green: no ' + REQUIRED_CHECK + ' check run');
    expect(gate([{ name: REQUIRED_CHECK, status: 'completed', conclusion: 'failure' }, { name: BACKSTOP_CHECK, status: 'completed', conclusion: 'neutral' }])).toBe('--ref ' + head.slice(0, 12) + ' is not green: ' + REQUIRED_CHECK + ' concluded failure');
    expect(gate(backstop('in_progress', null))).toBe('--ref ' + head.slice(0, 12) + ' is not green: ' + BACKSTOP_CHECK + ' is still running');
    expect(gate([...backstop('completed', 'neutral'), { name: 'slices-report', status: 'queued', conclusion: null }])).toBe('--ref ' + head.slice(0, 12) + ' is not green: check runs still going: slices-report');
    expect(gate(backstop('completed', 'neutral'))).toBe('green');
    f.state.checks[head] = [];
    const same = planRelease({ repo: f.repo, ref: head, git: f.git, gh: f.gh, requiredCheck: 'ci', backstopCheck: 'ci' });
    expect(same.ok ? 'green' : same.message).toBe('--ref ' + head.slice(0, 12) + ' is not green: no ci check run');
    f.state.checks[head] = [{ name: 'ci', status: 'completed', conclusion: 'success' }];
    const sameGreen = planRelease({ repo: f.repo, ref: head, git: f.git, gh: f.gh, requiredCheck: 'ci', backstopCheck: 'ci' });
    expect(sameGreen.ok ? sameGreen.plan.via : sameGreen.message).toBe('ci');

    for (const state of ['red', 'superseded', 'incomplete', 'free-green']) {
      note(f, train('t1', state, [{ sha: head, tree }]), head);
      expect([state, gate(backstop('completed', 'neutral'))]).toEqual([state, '--ref ' + head.slice(0, 12) + ' is not green: ' + BACKSTOP_CHECK + ' concluded neutral']);
    }

    for (const sha of Object.values(f.shas)) f.state.checks[sha] = backstop('completed', 'neutral');
    const none = planRelease({ repo: f.repo, git: f.git, gh: f.gh });
    expect(none.ok).toBe(false);
    if (none.ok) return;
    expect(none.code).toBe('NO_GREEN_COMMIT');
    expect(none.message).toBe('no green commit among 4 on origin/main; see the skipped list');
    expect(none.skipped).toEqual(Object.values(f.shas).reverse().map(s => s.slice(0, 12) + ': ' + BACKSTOP_CHECK + ' concluded neutral'));
    note(f, train('other', 'merged', [{ sha: f.shas['1.0.1']!, tree: treeOf(f, f.shas['1.0.1']!) }]), head);
    const older = planRelease({ repo: f.repo, git: f.git, gh: f.gh });
    expect(older.ok, JSON.stringify(older)).toBe(true);
    if (!older.ok) return;
    expect(older.plan.sha).toBe(f.shas['1.0.1']);
    expect(older.plan.via).toBe('train other');
    expect(older.plan.skipped).toEqual([head.slice(0, 12) + ': ' + BACKSTOP_CHECK + ' concluded neutral', f.shas['1.0.2']!.slice(0, 12) + ': ' + BACKSTOP_CHECK + ' concluded neutral']);
  });

  // Value: protects=--required-check, --backstop-check and --notes-ref rename what the gate reads so another repository can run the script, and the
  // defaults stay free-tests, main-backstop and refs/notes/gstack-trains for weekly-release.yml; fails_when=a renamed check is still looked up under the
  // default name, the train notes are read from the default ref only, or a flag is misread by the CLI; why_new=every other test runs under the defaults;
  // seam=none; no_claim=none beyond protects
  test('--required-check, --backstop-check and --notes-ref rename what the gate reads, through planRelease and the CLI', () => {
    const f = fixture();
    const head = f.shas['1.0.3']!;
    const renamed: CheckRun[] = [{ name: 'ci', status: 'completed', conclusion: 'success' }, { name: 'nightly-backstop', status: 'completed', conclusion: 'success' }];
    for (const sha of Object.values(f.shas)) f.state.checks[sha] = renamed;
    const defaults = planRelease({ repo: f.repo, git: f.git, gh: f.gh });
    expect(defaults.ok).toBe(false);
    if (!defaults.ok) expect(defaults.skipped![0]).toBe(head.slice(0, 12) + ': no ' + REQUIRED_CHECK + ' check run');
    const flagged = planRelease({ repo: f.repo, git: f.git, gh: f.gh, requiredCheck: 'ci', backstopCheck: 'nightly-backstop' });
    expect(flagged.ok, JSON.stringify(flagged)).toBe(true);
    if (flagged.ok) { expect(flagged.plan.sha).toBe(head); expect(flagged.plan.via).toBe('nightly-backstop'); }

    f.state.checks[head] = [{ name: 'ci', status: 'completed', conclusion: 'success' }, { name: 'nightly-backstop', status: 'completed', conclusion: 'neutral' }];
    note(f, train('t9', 'merged', [{ sha: head, tree: treeOf(f, head) }]), head, 'refs/notes/other-trains');
    const defaultRef = planRelease({ repo: f.repo, ref: head, git: f.git, gh: f.gh, requiredCheck: 'ci', backstopCheck: 'nightly-backstop' });
    expect(defaultRef.ok).toBe(false);
    if (!defaultRef.ok) expect(defaultRef.message).toBe('--ref ' + head.slice(0, 12) + ' is not green: nightly-backstop concluded neutral');
    const otherRef = planRelease({ repo: f.repo, ref: head, git: f.git, gh: f.gh, requiredCheck: 'ci', backstopCheck: 'nightly-backstop', notesRef: 'refs/notes/other-trains' });
    expect(otherRef.ok, JSON.stringify(otherRef)).toBe(true);
    if (otherRef.ok) expect(otherRef.plan.via).toBe('train t9');

    if (process.platform === 'win32') return;
    const shim = path.join(f.base, 'shim');
    fs.mkdirSync(shim);
    fs.writeFileSync(path.join(shim, 'gh'), '#!/usr/bin/env bash\ncase "$*" in\n  *check-runs*) echo \'' + JSON.stringify([{ check_runs: f.state.checks[head] }]) + '\' ;;\n  *) exit 1 ;;\nesac\n', { mode: 0o755 });
    const run = (...args: string[]) => spawnSync(process.execPath, [...bunIsolationArgs(), 'run', path.join(path.resolve(import.meta.dir, '..'), 'scripts', 'release-cut.ts'), ...args],
      { cwd: f.work, encoding: 'utf8', timeout: 60_000, env: { ...process.env, PATH: shim + path.delimiter + process.env.PATH } });
    const cli = run('--repo', f.repo, '--dry-run', '--ref', head, '--required-check', 'ci', '--backstop-check', 'nightly-backstop', '--notes-ref', 'refs/notes/other-trains');
    expect(cli.status, cli.stdout + cli.stderr).toBe(0);
    expect(cli.stdout.split('\n')[0]).toBe('CANDIDATE: ' + head + ' (' + git(f.seed, 'show', '-s', '--format=%cs', head) + ') [hotfix: --ref] gated by train t9');
    const unnamed = run('--repo', f.repo, '--dry-run', '--ref', head, '--required-check', 'ci', '--backstop-check', 'nightly-backstop');
    expect(unnamed.status).toBe(1);
    expect(unnamed.stdout.split('\n')[0]).toBe('REFUSED: --ref ' + head.slice(0, 12) + ' is not green: nightly-backstop concluded neutral');
  });
});

describe('release-cut: cutting, hotfixes and the forward-only stable', () => {
  test('a cut tags, moves stable and publishes; re-running reports nothing new; a hotfix ref promotes a later main commit with a compare link', () => {
    const f = fixture();
    const first = planRelease({ repo: f.repo, git: f.git, gh: f.gh });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.plan.sha).toBe(f.shas['1.0.3']);
    const cut = cutRelease(first.plan, { repo: f.repo, git: f.git, gh: f.gh, notesDir: f.base });
    expect(cut.ok, cut.lines.join('\n')).toBe(true);
    expect(cut.lines).toEqual(['TAG: v1.0.3 -> ' + f.shas['1.0.3']!.slice(0, 12) + ' pushed', 'STABLE: none -> ' + f.shas['1.0.3']!.slice(0, 12), 'RELEASE: v1.0.3 published https://github.com/o/r/releases/tag/v1.0.3']);
    expect(git(f.origin, 'rev-parse', 'refs/heads/stable')).toBe(f.shas['1.0.3']);
    expect(git(f.origin, 'rev-parse', 'v1.0.3^{commit}')).toBe(f.shas['1.0.3']);
    expect(git(f.origin, 'cat-file', '-t', 'v1.0.3')).toBe('tag');
    const create = f.state.calls.find(c => c[0] === 'release' && c[1] === 'create')!;
    expect(create).toContain('--verify-tag');
    expect(fs.readFileSync(create[create.indexOf('--notes-file') + 1]!, 'utf8')).toContain('Fourth trims the preamble.');

    f.refresh();
    const again = planRelease({ repo: f.repo, git: f.git, gh: f.gh });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.code).toBe('NOTHING_NEW');

    const hot = f.release('1.0.4', 'Hotfix: the lease never blocks.');
    f.refresh();
    const promo = planRelease({ repo: f.repo, ref: hot, git: f.git, gh: f.gh });
    expect(promo.ok, JSON.stringify(promo)).toBe(true);
    if (!promo.ok) return;
    expect(promo.plan.hotfix).toBe(true);
    expect(promo.plan.prevStable).toBe(f.shas['1.0.3']);
    expect(promo.plan.prevTag).toBe('v1.0.3');
    expect(promo.plan.notes).toContain('## gstack v1.0.4 (hotfix release)');
    expect(promo.plan.notes).toContain('1 version since v1.0.3');
    expect(promo.plan.notes).toContain('compare/v1.0.3...v1.0.4');
    expect(promo.plan.notes).toContain('- **1.0.4**');
    expect(promo.plan.notes).not.toContain('- **1.0.3**');
    const cut2 = cutRelease(promo.plan, { repo: f.repo, git: f.git, gh: f.gh, notesDir: f.base });
    expect(cut2.ok, cut2.lines.join('\n')).toBe(true);
    expect(git(f.origin, 'rev-parse', 'refs/heads/stable')).toBe(hot);
    f.refresh();
    const redo = cutRelease(promo.plan, { repo: f.repo, git: f.git, gh: f.gh, notesDir: f.base });
    expect(redo.lines).toEqual(['TAG: v1.0.4 already names ' + hot.slice(0, 12), 'STABLE: ' + f.shas['1.0.3']!.slice(0, 12) + ' -> ' + hot.slice(0, 12), 'RELEASE: v1.0.4 already published']);
  });

  // Value: protects=a cut that pushed the tag and stable but failed to create the release is finished by the next run (same commit, notes against the release
  // before, release created) instead of being refused as 'already stable' forever; fails_when=planRelease drops stable itself from the candidates, the notes
  // compare the commit with itself, or a finished cut is cut again; why_new=the cut test re-runs only a completed cut (NOTHING_NEW); seam=none; no_claim=none beyond protects
  test('a cut that stopped after pushing the tag and stable is finished by the next run, by window or by --ref', () => {
    const f = fixture();
    f.state.createFails = 'v1.0.3';
    const first = planRelease({ repo: f.repo, git: f.git, gh: f.gh });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const half = cutRelease(first.plan, { repo: f.repo, git: f.git, gh: f.gh, notesDir: f.base });
    expect(half.ok).toBe(false);
    expect(half.lines.at(-1)).toContain('RELEASE: create failed: HTTP 502');
    expect(git(f.origin, 'rev-parse', 'refs/heads/stable')).toBe(f.shas['1.0.3']);
    delete f.state.createFails;

    f.refresh();
    let resumed = first.plan;
    for (const ref of [undefined, f.shas['1.0.3']]) {
      const again = planRelease({ repo: f.repo, ref, git: f.git, gh: f.gh });
      expect(again.ok, JSON.stringify(again)).toBe(true);
      if (!again.ok) return;
      resumed = again.plan;
      expect(again.plan.sha).toBe(f.shas['1.0.3']);
      expect(again.plan.stableAt).toBe(true);
      expect(again.plan.tagExists).toBe('same');
      expect(again.plan.prevVersion).toBeNull();
      expect(again.plan.notes).toContain('First tagged release: the 4 versions, one line each');
      expect(describePlan(again.plan, true)[2]).toBe('STABLE: already at ' + f.shas['1.0.3']!.slice(0, 12) + ' (finishing an earlier cut)');
    }
    const done = cutRelease(resumed, { repo: f.repo, git: f.git, gh: f.gh, notesDir: f.base });
    expect(done.ok, done.lines.join('\n')).toBe(true);
    expect(done.lines).toEqual(['TAG: v1.0.3 already names ' + f.shas['1.0.3']!.slice(0, 12), 'STABLE: already at ' + f.shas['1.0.3']!.slice(0, 12), 'RELEASE: v1.0.3 published https://github.com/o/r/releases/tag/v1.0.3']);

    // A later half-done cut reads its notes against the release before it.
    f.state.createFails = 'v1.0.4';
    const hot = f.release('1.0.4', 'Hotfix: the lease never blocks.');
    f.refresh();
    const promo = planRelease({ repo: f.repo, ref: hot, git: f.git, gh: f.gh });
    expect(promo.ok).toBe(true);
    if (!promo.ok) return;
    expect(cutRelease(promo.plan, { repo: f.repo, git: f.git, gh: f.gh, notesDir: f.base }).ok).toBe(false);
    delete f.state.createFails;
    f.refresh();
    const finish = planRelease({ repo: f.repo, git: f.git, gh: f.gh });
    expect(finish.ok, JSON.stringify(finish)).toBe(true);
    if (!finish.ok) return;
    expect(finish.plan.sha).toBe(hot);
    expect(finish.plan.prevTag).toBe('v1.0.3');
    expect(finish.plan.notes).toContain('1 version since v1.0.3');
    expect(finish.plan.notes).toContain('compare/v1.0.3...v1.0.4');
    expect(finish.plan.notes).not.toContain('- **1.0.3**');
    const once = planRelease({ repo: f.repo, git: f.git, gh: f.gh });
    expect(cutRelease(finish.plan, { repo: f.repo, git: f.git, gh: f.gh, notesDir: f.base }).ok).toBe(true);
    expect(once.ok).toBe(true);
    f.refresh();
    const nothing = planRelease({ repo: f.repo, git: f.git, gh: f.gh });
    expect(nothing.ok).toBe(false);
    if (!nothing.ok) expect(nothing.message).toBe('origin/main ' + hot.slice(0, 12) + ' is already released as v1.0.4; nothing newer is green');
  });

  test('stable never moves backwards, a side-branch ref is refused, and a tag naming another commit is refused', () => {
    const f = fixture();
    git(f.seed, 'push', '-q', 'origin', f.shas['1.0.2'] + ':refs/heads/stable');
    f.refresh();
    const back = planRelease({ repo: f.repo, ref: f.shas['1.0.1'], git: f.git, gh: f.gh });
    expect(back.ok).toBe(false);
    if (!back.ok) { expect(back.code).toBe('REFUSED'); expect(back.message).toContain('non-fast-forward'); }

    // Value: protects=a hotfix --ref that is not green or not a commit is REFUSED (exit 1 in the workflow), never promoted; fails_when=--ref skips the gate or an unknown
    // ref falls through to the window; why_new=the hotfix test promotes a green ref only and the side-branch case covers first-parent, not the gate; seam=none;
    // no_claim=none beyond protects
    f.state.checks[f.shas['1.0.3']!] = backstop('completed', 'failure');
    const red = planRelease({ repo: f.repo, ref: f.shas['1.0.3'], git: f.git, gh: f.gh });
    expect(red.ok).toBe(false);
    if (!red.ok) { expect(red.code).toBe('REFUSED'); expect(red.message).toBe('--ref ' + f.shas['1.0.3']!.slice(0, 12) + ' is not green: ' + BACKSTOP_CHECK + ' concluded failure'); }
    const unknown = planRelease({ repo: f.repo, ref: 'f'.repeat(40), git: f.git, gh: f.gh });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) { expect(unknown.code).toBe('REFUSED'); expect(unknown.message).toContain('is not a commit here'); }
    delete f.state.checks[f.shas['1.0.3']!];

    git(f.seed, 'checkout', '-q', '-b', 'side', f.shas['1.0.3']!);
    fs.writeFileSync(path.join(f.seed, 'side.txt'), 'x');
    git(f.seed, 'add', '-A'); git(f.seed, 'commit', '-q', '-m', 'side');
    const side = git(f.seed, 'rev-parse', 'HEAD');
    git(f.seed, 'push', '-q', 'origin', 'side');
    f.refresh();
    const off = planRelease({ repo: f.repo, ref: side, git: f.git, gh: f.gh });
    expect(off.ok).toBe(false);
    if (!off.ok) expect(off.message).toContain("not on main's first-parent history");

    git(f.seed, 'tag', 'v1.0.3', f.shas['1.0.0']!);
    git(f.seed, 'push', '-q', 'origin', 'refs/tags/v1.0.3');
    f.refresh();
    const clash = planRelease({ repo: f.repo, git: f.git, gh: f.gh });
    expect(clash.ok).toBe(false);
    if (!clash.ok) expect(clash.message).toContain('tag v1.0.3 already names');
  });
});

describe.skipIf(process.platform === 'win32')('release-cut: the workflow entry point', () => {
  // Value: protects=the CLI weekly-release.yml runs: --dry-run plans, prints CANDIDATE/DRY_RUN lines, appends the plan and notes to --summary and pushes nothing,
  // exits 0 on NOTHING_NEW, 1 on REFUSED and 2 without --repo; fails_when=an argument is misread, an exit code flips so the workflow goes red on a quiet week or
  // green on a refusal, or a dry run pushes; why_new=every other test calls the exported functions, never the argv/exit/summary boundary the workflow uses; seam=none;
  // no_claim=GitHub's API or a real gh (a gh shim answers from PATH; the git side is a real bare origin)
  test('--dry-run plans and pushes nothing, the summary carries the plan and notes, and the exit codes are the workflow contract', () => {
    const f = fixture();
    const shim = path.join(f.base, 'shim');
    fs.mkdirSync(shim);
    fs.writeFileSync(path.join(shim, 'gh'), '#!/usr/bin/env bash\necho "gh $*" >> "' + path.join(f.base, 'gh.log') + '"\ncase "$*" in\n  *check-runs*) echo \'' + JSON.stringify([{ check_runs: GREEN }]) + '\' ;;\n  "release view v1.0.3 "*) echo \'{\"tagName\":\"v1.0.3\"}\' ;;\n  *) exit 1 ;;\nesac\n', { mode: 0o755 });
    const run = (...args: string[]) => spawnSync(process.execPath, [...bunIsolationArgs(), 'run', path.join(path.resolve(import.meta.dir, '..'), 'scripts', 'release-cut.ts'), ...args],
      { cwd: f.work, encoding: 'utf8', timeout: 60_000, env: { ...process.env, PATH: shim + path.delimiter + process.env.PATH } });

    const summary = path.join(f.base, 'summary.md');
    const dry = run('--repo', f.repo, '--dry-run', '--summary', summary);
    expect(dry.status, dry.stdout + dry.stderr).toBe(0);
    expect(dry.stdout).toContain('CANDIDATE: ' + f.shas['1.0.3'] + ' (');
    expect(dry.stdout).toContain('VERSION: 1.0.3 -> tag v1.0.3');
    expect(dry.stdout).toContain('DRY_RUN: nothing pushed, nothing created.');
    expect(dry.stdout).not.toContain('--- notes ---');
    const written = fs.readFileSync(summary, 'utf8');
    expect(written).toContain('- CANDIDATE: ' + f.shas['1.0.3']);
    expect(written).toContain('<details><summary>Release notes</summary>');
    expect(written).toContain('- **1.0.3** (2026-10-23): Fourth trims the preamble.');
    expect(execFileSync('git', ['ls-remote', f.origin, 'refs/heads/stable', 'refs/tags/v1.0.3'], { encoding: 'utf8', timeout: 30_000 }).trim()).toBe('');
    expect(fs.readFileSync(path.join(f.base, 'gh.log'), 'utf8')).not.toContain('gh release');

    const usage = run('--dry-run');
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain('usage: release-cut.ts --repo owner/name');

    git(f.seed, 'tag', 'v1.0.3', f.shas['1.0.3']!);
    git(f.seed, 'push', '-q', 'origin', 'refs/tags/v1.0.3', f.shas['1.0.3'] + ':refs/heads/stable');
    f.refresh();
    const quiet = run('--repo', f.repo, '--dry-run');
    expect(quiet.status, quiet.stdout + quiet.stderr).toBe(0);
    expect(quiet.stdout.split('\n')[0]).toBe('NOTHING_NEW: origin/main ' + f.shas['1.0.3']!.slice(0, 12) + ' is already released as v1.0.3; nothing newer is green');

    const refused = run('--repo', f.repo, '--dry-run', '--ref', f.shas['1.0.1']!);
    expect(refused.status).toBe(1);
    expect(refused.stdout).toContain('REFUSED: non-fast-forward');

    // Nothing green: the real cut goes red (exit 1), a dry run has answered (exit 0) and names every skip.
    fs.writeFileSync(path.join(shim, 'gh'), '#!/usr/bin/env bash\ncase "$*" in\n  *check-runs*) echo \'' + JSON.stringify([{ check_runs: GREEN.filter(c => c.name !== BACKSTOP_CHECK) }]) + '\' ;;\n  *) exit 1 ;;\nesac\n', { mode: 0o755 });
    git(f.seed, 'push', '-q', '--delete', 'origin', 'stable', 'refs/tags/v1.0.3');
    f.refresh(); git(f.work, 'tag', '-d', 'v1.0.3');
    const noneDry = run('--repo', f.repo, '--dry-run');
    expect(noneDry.status, noneDry.stdout + noneDry.stderr).toBe(0);
    expect(noneDry.stdout.split('\n')[0]).toContain('NO_GREEN_COMMIT: no green commit among 4 on origin/main');
    expect(noneDry.stdout).toContain('SKIPPED: ' + f.shas['1.0.3']!.slice(0, 12) + ': no ' + BACKSTOP_CHECK + ' check run');
    const noneCut = run('--repo', f.repo);
    expect(noneCut.status).toBe(1);
    expect(execFileSync('git', ['ls-remote', f.origin, 'refs/heads/stable', 'refs/tags/*'], { encoding: 'utf8', timeout: 30_000 }).trim()).toBe('');
  });
});

describe('release-cut: notes', () => {
  test('changelog headlines are the bold first line of each entry; versions order numerically', () => {
    const entries = changelogEntries('# Changelog\n\n## [1.91.221.0] - 2026-10-25\n\n**The updater no longer skips.** More.\n\n### Fixed\n- x\n\n## [1.91.99.0] - 2026-10-01\n\n| a | b |\n\n**Older.**\n');
    expect(entries).toEqual([{ version: '1.91.221.0', date: '2026-10-25', headline: 'The updater no longer skips.' }, { version: '1.91.99.0', date: '2026-10-01', headline: 'Older.' }]);
    expect(changelogEntries('## [1.0.0] - 2026-01-01\n\nPlain lead with **some** bold.\n')[0]!.headline).toBe('Plain lead with some bold.');
    expect(compareVersions('1.91.221.0', '1.91.99.0')).toBeGreaterThan(0);
    expect(compareVersions('1.91.9.0', '1.91.10.0')).toBeLessThan(0);
  });

  test('a span of a thousand versions stays under the notes cap and says how many were cut', () => {
    const entries = Array.from({ length: 1000 }, (_, i) => ({ version: '1.91.' + (i + 1) + '.0', date: '2026-10-20', headline: 'Headline number ' + i + ' with enough words to take some room in the body.' }));
    const notes = releaseNotes({ repo: 'o/r', version: '1.91.1000.0', date: '2026-10-26', prevVersion: '1.91.0.0', prevTag: null, entries, hotfix: false });
    expect(notes.length).toBeLessThanOrEqual(NOTES_CAP);
    expect(notes).toMatch(/- \.\.\.and \d+ more versions; see CHANGELOG\.md/);
    expect(notes).toContain('1000 versions since v1.91.0.0');
    expect(notes.split('\n')[0]).toBe('## gstack v1.91.1000.0 (weekly release)');
  });
});
