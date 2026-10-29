/**
 * Changelog fragments (docs/ship-policy.md#changelog-fragments): the reader takes only regular .md
 * blobs directly in the fragment directory, the restamp folds them under the allocated version with
 * the highest declared bump and deletes them, and the tree receipt accepts exactly that fold as a stamp.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { effectiveBump, foldIntoUnreleased, fragmentSlug, parseFragment, readFragments } from '../lib/changelog-fragments';
import { reheadChangelog } from '../lib/changelog-check';
import { mergePolicy, validatePolicy } from '../lib/ship-policy';
import { buildReceipt } from '../lib/tree-receipt';
import { BASE_POLICY, cleanup, makeFixtureRepo, readFile, restamp, type FixtureRepo } from './helpers/restamp-fixture';

const POLICY = { ...BASE_POLICY, release_tool: null, release_outputs: [], changelog_fragments: { dir: 'changelog.d' }, min_gstack_version: '1.92.0.0' };
const repos: FixtureRepo[] = [];
const fixture = () => { const r = makeFixtureRepo({ policy: POLICY }); repos.push(r); return r; };
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

function fragmentPr(repo: FixtureRepo, branch: string, fragments: Record<string, string>, extra: (work: string) => void = () => {}): string {
  repo.git('checkout', '-q', 'origin/main', '-b', branch);
  fs.writeFileSync(path.join(repo.work, `${branch}.txt`), `${branch}\n`);
  fs.mkdirSync(path.join(repo.work, 'changelog.d'), { recursive: true });
  for (const [name, text] of Object.entries(fragments)) fs.writeFileSync(path.join(repo.work, 'changelog.d', name), text);
  extra(repo.work);
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', `feat ${branch}`);
  return repo.git('rev-parse', 'HEAD');
}

describe('parseFragment', () => {
  test('body only, or bump front matter then a body', () => {
    expect(parseFragment('changelog.d/a.md', '\n- **Faster slots.** text\n\n')).toEqual({ path: 'changelog.d/a.md', body: '- **Faster slots.** text', bump: null });
    expect(parseFragment('changelog.d/a.md', '---\nbump: minor\n---\n### Added\n- x\n')).toEqual({ path: 'changelog.d/a.md', body: '### Added\n- x', bump: 'minor' });
  });
  test('refuses empty text, unknown front matter and a release heading', () => {
    expect(parseFragment('a.md', '\n\n')).toMatchObject({ code: 'CHANGELOG_FRAGMENT_INVALID', message: 'the fragment has no entry text' });
    expect(parseFragment('a.md', '---\nversion: 1.2.3\n---\n- x\n')).toMatchObject({ code: 'CHANGELOG_FRAGMENT_INVALID' });
    expect(parseFragment('a.md', '## [1.2.4.0] - 2026-10-29\n- x\n')).toMatchObject({ code: 'CHANGELOG_FRAGMENT_INVALID' });
    expect(parseFragment('a.md', '## [Unreleased]\n- x\n')).toMatchObject({ code: 'CHANGELOG_FRAGMENT_INVALID' });
  });
  test('slug is one flat path segment', () => {
    expect(fragmentSlug('gsta154/changelog-fragments')).toBe('gsta154-changelog-fragments');
    expect(fragmentSlug('../..')).toBe('change');
  });
});

describe('effectiveBump and the fold', () => {
  test('the highest declared bump wins over the policy level', () => {
    const f = (bump: any) => ({ path: 'x', body: 'b', bump });
    expect(effectiveBump('patch', [f(null)])).toBe('patch');
    expect(effectiveBump('patch', [f('minor'), f(null)])).toBe('minor');
    expect(effectiveBump('micro', [f('patch'), f('major'), f('minor')])).toBe('major');
  });
  test('fragments go above a legacy [Unreleased] entry, and re-heading moves both under one version', () => {
    const cl = '# Changelog\n\n## [Unreleased]\n\n- legacy\n\n## [1.2.3.0] - 2026-10-01\n\n- base\n';
    const folded = foldIntoUnreleased(cl, [{ path: 'changelog.d/a.md', body: '- a', bump: null }, { path: 'changelog.d/b.md', body: '- b', bump: null }]);
    const r = reheadChangelog(folded, { from: null, to: '1.2.4.0', date: '2026-10-29' });
    expect(r.text).toBe('# Changelog\n\n## [1.2.4.0] - 2026-10-29\n\n- a\n\n- b\n\n- legacy\n\n## [1.2.3.0] - 2026-10-01\n\n- base\n');
  });
  test('no fragments leaves the text unchanged', () => {
    expect(foldIntoUnreleased('# C\n', [])).toBe('# C\n');
  });
});

describe('readFragments reads blobs only', () => {
  test('a symlink, a nested file and a non-.md file refuse; README.md and base fragments are skipped', () => {
    const repo = fixture();
    const outside = path.join(repo.root, 'secret.txt');
    fs.writeFileSync(outside, 'SENTINEL-OUTSIDE\n');
    fragmentPr(repo, 'feat-a', { 'a.md': '- a\n', 'README.md': 'how to write fragments\n', 'notes.txt': 'x\n' }, work => {
      fs.symlinkSync(outside, path.join(work, 'changelog.d', 'link.md'));
      fs.mkdirSync(path.join(work, 'changelog.d', 'sub'));
      fs.writeFileSync(path.join(work, 'changelog.d', 'sub', 'deep.md'), '- deep\n');
    });
    const set = readFragments(repo.work, 'HEAD', 'changelog.d', 'origin/main');
    expect(set.fragments.map(f => f.path)).toEqual(['changelog.d/a.md']);
    expect(set.errors.map(e => e.path).sort()).toEqual(['changelog.d/link.md', 'changelog.d/notes.txt', 'changelog.d/sub/deep.md']);
    expect(set.errors.find(e => e.path === 'changelog.d/link.md')!.message).toContain('symlink');
    expect(JSON.stringify(set)).not.toContain('SENTINEL-OUTSIDE');
  });
});

describe('policy key', () => {
  test('changelog_fragments needs one contained directory and min_gstack_version at its key version', () => {
    expect(validatePolicy(POLICY)).toEqual([]);
    expect(validatePolicy({ ...POLICY, changelog_fragments: { dir: '../x' } }).map(e => e.path)).toContain('changelog_fragments.dir');
    expect(validatePolicy({ ...POLICY, changelog_fragments: { dir: 'changelog.d/*' } }).map(e => e.path)).toContain('changelog_fragments.dir');
    expect(validatePolicy({ ...POLICY, changelog_fragments: { dir: 'd', glob: '*' } }).map(e => e.path)).toContain('changelog_fragments.glob');
    const { min_gstack_version: _drop, ...noMin } = POLICY;
    expect(validatePolicy(noMin).map(e => e.path)).toContain('changelog_fragments');
  });
});

describe('restamp folds fragments', () => {
  test('a minor fragment under a patch policy stamps the next minor, folds, deletes the fragment, and the receipt calls it a stamp', () => {
    const repo = fixture();
    const pin = fragmentPr(repo, 'feat-a', { 'feat-a.md': '---\nbump: minor\n---\n- **Fragments.** feat-a\n' });
    const r = restamp(repo, ['--next']);
    expect(r.err).toBe('');
    expect(r.out).toContain('STAMP_VERSION: 1.3.0.0');
    expect(r.out).toContain('folded changelog.d/feat-a.md');
    expect(fs.existsSync(path.join(repo.work, 'changelog.d', 'feat-a.md'))).toBe(false);
    expect(readFile(repo, 'CHANGELOG.md')).toMatch(/^# Changelog\n\n## \[1\.3\.0\.0\] - \d{4}-\d{2}-\d{2}\n\n- \*\*Fragments\.\*\* feat-a\n\n## \[1\.2\.3\.0\]/);
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'stamp');
    const receipt = buildReceipt({ repoRoot: repo.work, gated: pin, current: 'HEAD', policy: mergePolicy(POLICY, 'test').policy, policyLabel: 'test' });
    if ('error' in receipt) throw new Error(receipt.error);
    expect(receipt.residual).toEqual([]);
    expect(receipt.files.find(f => f.path === 'changelog.d/feat-a.md')).toMatchObject({ rule: 'changelog_fragments', verdict: 'stamp' });
    expect(receipt.files.find(f => f.path === 'CHANGELOG.md')).toMatchObject({ rule: 'changelog-fragments', verdict: 'stamp' });
  });

  test('an edited fold, or a fragment deleted without its text, is a change', () => {
    const repo = fixture();
    const pin = fragmentPr(repo, 'feat-b', { 'feat-b.md': '- feat-b\n' });
    expect(restamp(repo, ['--next']).out).toContain('STAMP_VERSION: 1.2.4.0');
    fs.writeFileSync(path.join(repo.work, 'CHANGELOG.md'), readFile(repo, 'CHANGELOG.md').replace('- feat-b', '- feat-b, reworded'));
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'stamp plus edit');
    const policy = mergePolicy(POLICY, 'test').policy;
    const edited = buildReceipt({ repoRoot: repo.work, gated: pin, current: 'HEAD', policy, policyLabel: 'test' });
    if ('error' in edited) throw new Error(edited.error);
    expect(edited.residual.sort()).toEqual(['CHANGELOG.md', 'changelog.d/feat-b.md']);
    repo.git('checkout', '-q', pin);
    fs.rmSync(path.join(repo.work, 'changelog.d', 'feat-b.md'));
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'drop fragment only');
    const dropped = buildReceipt({ repoRoot: repo.work, gated: pin, current: 'HEAD', policy, policyLabel: 'test' });
    if ('error' in dropped) throw new Error(dropped.error);
    expect(dropped.files.find(f => f.path === 'changelog.d/feat-b.md')).toMatchObject({ verdict: 'changed' });
  });

  test('an invalid fragment refuses before anything is written', () => {
    const repo = fixture();
    fragmentPr(repo, 'feat-c', { 'feat-c.md': '## [9.9.9.9]\n- no\n' });
    const r = restamp(repo, ['--next']);
    expect(r.err).toContain('(CHANGELOG_FRAGMENT_INVALID)');
    expect(readFile(repo, 'VERSION')).toBe('1.2.3.0\n');
  });
});
