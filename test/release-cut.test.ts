/**
 * release-cut (free): the weekly release picks the newest green commit on
 * main's first-parent history, tags it v<VERSION>, fast-forwards stable and
 * publishes notes from the CHANGELOG headlines; a hotfix --ref promotes a
 * named main commit; stable never moves backwards; a frozen queue, a pending
 * gate or a red check run keeps a commit out (docs/releases.md).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BACKSTOP_WORKFLOW, NOTES_CAP, NOTES_REF, REQUIRED_CHECK, changelogEntries, compareVersions, cutRelease, describePlan, gitIn,
  planRelease, releaseNotes, type Gh,
} from '../scripts/release-cut';

const bases: string[] = [];
afterEach(() => { for (const b of bases.splice(0)) fs.rmSync(b, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } }).trim();
}

interface State { checks: Record<string, Array<{ name: string; status: string; conclusion: string | null }>>; backstop: Record<string, Array<{ status: string; conclusion: string | null; created_at: string }>>; released: Set<string>; calls: string[][] }

const GREEN = [{ name: REQUIRED_CHECK, status: 'completed', conclusion: 'success' }, { name: 'typecheck', status: 'completed', conclusion: 'success' }, { name: 'slices-report', status: 'queued', conclusion: null }];
const COVERED = [{ status: 'completed', conclusion: 'success', created_at: '2026-10-25T00:00:00Z' }];

function fakeGh(state: State): Gh {
  return (args) => {
    state.calls.push(args);
    const api = args[0] === 'api' ? args[args.length - 1]! : '';
    let m = /commits\/([0-9a-f]+)\/check-runs/.exec(api);
    if (m) return { status: 0, stdout: JSON.stringify([{ check_runs: state.checks[m[1]!] ?? GREEN }]), stderr: '' };
    m = new RegExp('workflows/' + BACKSTOP_WORKFLOW.replace('.', '\\.') + '/runs\\?head_sha=([0-9a-f]+)').exec(api);
    if (m) return { status: 0, stdout: JSON.stringify({ workflow_runs: state.backstop[m[1]!] ?? COVERED }), stderr: '' };
    if (args[0] === 'release' && args[1] === 'view') return state.released.has(args[2]!) ? { status: 0, stdout: '{}', stderr: '' } : { status: 1, stdout: '', stderr: 'release not found' };
    if (args[0] === 'release' && args[1] === 'create') { state.released.add(args[2]!); return { status: 0, stdout: 'https://github.com/o/r/releases/tag/' + args[2], stderr: '' }; }
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
  const state: State = { checks: {}, backstop: {}, released: new Set(), calls: [] };
  return { base, origin, seed, work, shas, release, refresh, state, gh: fakeGh(state), git: gitIn(work), repo: 'o/r' };
}

describe('release-cut: planning', () => {
  test('the newest green first-parent commit wins; a pending gate or a red check keeps a commit out and is named', () => {
    const f = fixture();
    f.state.backstop[f.shas['1.0.3']!] = [{ status: 'in_progress', conclusion: null, created_at: '2026-10-25T01:00:00Z' }];
    f.state.checks[f.shas['1.0.2']!] = [{ name: REQUIRED_CHECK, status: 'completed', conclusion: 'success' }, { name: 'windows-free-tests', status: 'completed', conclusion: 'failure' }];
    const r = planRelease({ repo: f.repo, git: f.git, gh: f.gh });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.plan.sha).toBe(f.shas['1.0.1']);
    expect(r.plan.version).toBe('1.0.1');
    expect(r.plan.tag).toBe('v1.0.1');
    expect(r.plan.prevStable).toBeNull();
    expect(r.plan.skipped).toEqual([
      f.shas['1.0.3']!.slice(0, 12) + ': Main backstop gate is still running',
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

  test('a missing free-tests run, a running free-tests run and no backstop run are not green', () => {
    const f = fixture();
    const head = f.shas['1.0.3']!;
    f.state.checks[head] = [{ name: 'typecheck', status: 'completed', conclusion: 'success' }];
    f.state.checks[f.shas['1.0.2']!] = [{ name: REQUIRED_CHECK, status: 'in_progress', conclusion: null }];
    f.state.backstop[f.shas['1.0.1']!] = [];
    const r = planRelease({ repo: f.repo, git: f.git, gh: f.gh });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.sha).toBe(f.shas['1.0.0']);
    expect(r.plan.skipped.map(s => s.split(': ')[1])).toEqual(['no free-tests check run', 'free-tests is still running', 'no Main backstop gate run']);
  });

  test('no green commit in the window is NO_GREEN_COMMIT with every skip named; an empty window is NOTHING_NEW', () => {
    const f = fixture();
    for (const sha of Object.values(f.shas)) f.state.backstop[sha] = [{ status: 'completed', conclusion: 'failure', created_at: '2026-10-25T00:00:00Z' }];
    const r = planRelease({ repo: f.repo, git: f.git, gh: f.gh });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('NO_GREEN_COMMIT');
    expect(r.skipped).toHaveLength(4);
    expect(r.skipped![0]).toContain('Main backstop gate concluded failure');
    const stale = planRelease({ repo: f.repo, git: f.git, gh: f.gh, now: () => Date.now() + 30 * 86_400_000 });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe('NOTHING_NEW');
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

  test('stable never moves backwards, a side-branch ref is refused, and a tag naming another commit is refused', () => {
    const f = fixture();
    git(f.seed, 'push', '-q', 'origin', f.shas['1.0.2'] + ':refs/heads/stable');
    f.refresh();
    const back = planRelease({ repo: f.repo, ref: f.shas['1.0.1'], git: f.git, gh: f.gh });
    expect(back.ok).toBe(false);
    if (!back.ok) { expect(back.code).toBe('REFUSED'); expect(back.message).toContain('non-fast-forward'); }

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
