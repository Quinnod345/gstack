/**
 * gstack-ship-queue land (docs/ship-policy.md#land): the merge step over real fixture repos (bare origin,
 * lane clone) and a gh shim that answers pr view, check runs, statuses and a squash merge against the
 * bare origin. Covers the fold-and-merge happy path, two PRs from one base landing without a collision,
 * release-field-only conflict resolution that keeps a clean dependency edit, product-conflict refusal,
 * the lock, the base moving during CI (restamp under the last-pushed lease), a foreign push, a missing
 * receipt and drift after the merge.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { BASE_POLICY, cleanup, makeFixtureRepo, readFile, runBin, type FixtureRepo } from './helpers/restamp-fixture';
import { shippedBody } from './helpers/ship-queue-train-fixture';
import { resolveReleaseConflicts } from '../lib/ship-queue-land';
import { mergePolicy } from '../lib/ship-policy';

const POLICY = { ...BASE_POLICY, release_tool: null, release_outputs: [], changelog_fragments: { dir: 'changelog.d' }, min_gstack_version: '1.92.0.0' };
const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

interface Fx { repo: FixtureRepo; data: string; env: Record<string, string>; write: (fn: (d: any) => void) => void }
function setup(policy: Record<string, unknown> = POLICY): Fx {
  const repo = makeFixtureRepo({ policy, prefix: 'gstack-land-fx-' });
  repos.push(repo);
  const dir = path.join(repo.root, 'gh-shim');
  fs.mkdirSync(dir, { recursive: true });
  const data = path.join(dir, 'data.json');
  fs.writeFileSync(data, JSON.stringify({ prs: {}, red: [], driftOnMerge: false }));
  fs.writeFileSync(path.join(dir, 'gh'), [
    '#!/usr/bin/env node',
    "const fs=require('fs');const {execFileSync}=require('child_process');",
    'const D=process.env.LAND_SHIM_DATA, O=process.env.LAND_SHIM_ORIGIN;',
    "const d=JSON.parse(fs.readFileSync(D,'utf8'));const a=process.argv.slice(2);",
    "const g=(...x)=>execFileSync('git',['--git-dir',O,...x],{encoding:'utf8'}).trim();",
    "const save=()=>fs.writeFileSync(D,JSON.stringify(d));",
    "if(a[0]==='pr'&&a[1]==='view'){const p=d.prs[a[2]];if(!p){console.error('no pr');process.exit(1)}",
    "  let head='';try{head=g('rev-parse','refs/heads/'+p.headRefName)}catch{};",
    "  console.log(JSON.stringify({...p,headRefOid:head}));process.exit(0)}",
    "if(a[0]==='pr'&&a[1]==='list'){console.log(JSON.stringify(Object.entries(d.prs).filter(([,p])=>p.state==='OPEN').map(([n,p])=>({number:Number(n),headRefOid:g('rev-parse','refs/heads/'+p.headRefName),isCrossRepository:false}))));process.exit(0)}",
    "if(a[0]==='api'){const m=/commits\\/([0-9a-f]+)\\/(check-runs|status)/.exec(a[1]);if(!m)process.exit(1);",
    "  if(m[2]==='status'){console.log(JSON.stringify({total_count:0,statuses:[]}));process.exit(0)}",
    "  const red=d.red.includes(m[1]);console.log(JSON.stringify({total_count:1,check_runs:[{id:1,name:'free-tests',status:'completed',conclusion:red?'failure':'success',completed_at:'2026-10-29T00:00:00Z',app:{id:1}}]}));process.exit(0)}",
    "if(a[0]==='pr'&&a[1]==='merge'){const p=d.prs[a[2]];const want=a[a.indexOf('--match-head-commit')+1];const head=g('rev-parse','refs/heads/'+p.headRefName);",
    "  if(head!==want){console.error('Head branch was modified');process.exit(1)}",
    "  if(d.driftOnMerge){const m=g('rev-parse','refs/heads/main');const t=g('rev-parse',m+'^{tree}');g('update-ref','refs/heads/main',g('commit-tree',t,'-p',m,'-m','outside merge'));d.driftOnMerge=false}",
    "  const main=g('rev-parse','refs/heads/main');const sq=g('commit-tree',g('rev-parse',want+'^{tree}'),'-p',main,'-m','squash #'+a[2]);g('update-ref','refs/heads/main',sq);p.state='MERGED';save();process.exit(0)}",
    "console.error('gh shim: unsupported '+a.join(' '));process.exit(1);",
    '',
  ].join('\n'), { mode: 0o755 });
  const env = { PATH: dir + ':' + (process.env.PATH ?? ''), LAND_SHIM_DATA: data, LAND_SHIM_ORIGIN: repo.origin };
  return { repo, data, env, write: fn => { const d = JSON.parse(fs.readFileSync(data, 'utf8')); fn(d); fs.writeFileSync(data, JSON.stringify(d)); } };
}

/** A PR branch from origin/main, pushed, with a fragment (or none), and a /ship receipt for its head in the shim. */
function openPr(fx: Fx, pr: string, opts: { fragment?: string | null; edit?: (work: string) => void; shipped?: boolean } = {}): string {
  const { repo } = fx;
  repo.git('checkout', '-q', 'origin/main', '-B', 'pr-' + pr);
  fs.writeFileSync(path.join(repo.work, 'pr-' + pr + '.txt'), pr + '\n');
  if (opts.fragment !== null) {
    fs.mkdirSync(path.join(repo.work, 'changelog.d'), { recursive: true });
    fs.writeFileSync(path.join(repo.work, 'changelog.d', 'pr-' + pr + '.md'), opts.fragment ?? '- #' + pr + ' change\n');
  }
  opts.edit?.(repo.work);
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', 'pr ' + pr);
  repo.git('push', '-q', '-f', 'origin', 'HEAD:refs/heads/pr-' + pr);
  const head = repo.git('rev-parse', 'HEAD');
  fx.write(d => { d.prs[pr] = { state: 'OPEN', headRefName: 'pr-' + pr, isCrossRepository: false, title: 'PR ' + pr + ' title', body: opts.shipped === false ? '' : shippedBody(pr, head) }; });
  repo.git('checkout', '-q', '--detach', 'origin/main');
  return head;
}
const land = (fx: Fx, args: string[]) => runBin(fx.repo, 'gstack-ship-queue', ['land', ...args, '--base', 'main', '--no-wait', '--allow-repo-commands'], fx.env);
const remote = (fx: Fx, ref: string) => { fx.repo.git('fetch', '-q', 'origin', '+refs/heads/*:refs/remotes/origin/*'); return fx.repo.git('rev-parse', 'origin/' + ref); };
const show = (fx: Fx, rev: string) => fx.repo.git('show', rev);

describe('land: fold, push, merge', () => {
  test('happy path: a stamp commit with parents [pin, main] and the folded tree, then a squash whose tree is that tree', () => {
    const fx = setup();
    const base = remote(fx, 'main');
    const pin = openPr(fx, '7', { fragment: '---\nbump: minor\n---\n- **Fragments.** #7\n' });
    const first = land(fx, ['--pr', '7']);
    expect(first.err).toBe('');
    expect(first.status).toBe(EXIT.ok);
    expect(first.out).toContain('STAMP_VERSION: 1.3.0.0');
    expect(first.out).toMatch(/^NEXT: gstack-pr-wait 7 --until green && gstack-ship-queue land --pr 7$/m);
    const stamp = remote(fx, 'pr-7');
    expect(fx.repo.git('rev-list', '--parents', '-n', '1', stamp).split(' ').slice(1)).toEqual([pin, base]);
    expect(show(fx, stamp + ':VERSION')).toBe('1.3.0.0');
    expect(fx.repo.git('ls-tree', '--name-only', stamp, 'changelog.d/')).toBe('');
    expect(show(fx, stamp + ':CHANGELOG.md')).toMatch(/^# Changelog\n\n## \[1\.3\.0\.0\] - \d{4}-\d{2}-\d{2}\n\n- \*\*Fragments\.\*\* #7\n\n## \[1\.2\.3\.0\]/);
    const second = land(fx, ['--pr', '7']);
    expect(second.err).toBe('');
    expect(second.out).toContain('MERGED: #7');
    expect(second.out).toMatch(/^LANDED: origin\/main tree [0-9a-f]+ equals the stamped tree$/m);
    expect(second.out).toContain('LOCK: released');
    const main = remote(fx, 'main');
    expect(fx.repo.git('rev-parse', main + '^{tree}')).toBe(fx.repo.git('rev-parse', stamp + '^{tree}'));
  }, 90_000);

  test('two PRs from one base land one after the other with no collision and no lane round trip', () => {
    const fx = setup();
    openPr(fx, '1');
    openPr(fx, '2');
    for (const pr of ['1', '2']) { expect(land(fx, ['--pr', pr]).status).toBe(EXIT.ok); expect(land(fx, ['--pr', pr]).out).toContain('LANDED:'); }
    const main = remote(fx, 'main');
    expect(show(fx, main + ':VERSION')).toBe('1.2.5.0');
    const cl = show(fx, main + ':CHANGELOG.md');
    expect(cl.indexOf('## [1.2.5.0]')).toBeLessThan(cl.indexOf('- #2 change'));
    expect(cl.indexOf('- #2 change')).toBeLessThan(cl.indexOf('## [1.2.4.0]'));
    expect(cl.indexOf('## [1.2.4.0]')).toBeLessThan(cl.indexOf('- #1 change'));
  }, 90_000);

  test('a legacy PR with its own VERSION bump and a clean dependency edit: release fields resolve to main, the dependency edit survives', () => {
    const fx = setup();
    openPr(fx, '1');
    expect(land(fx, ['--pr', '1']).status).toBe(EXIT.ok); land(fx, ['--pr', '1']);
    fx.repo.git('fetch', '-q', 'origin');
    fx.repo.git('checkout', '-q', '-B', 'pr-3', fx.repo.git('rev-parse', 'origin/main') + '~1');
    const pkg = JSON.parse(readFile(fx.repo, 'package.json'));
    pkg.version = '1.2.9'; pkg.dependencies['right-pad'] = '2.0.0';
    fs.writeFileSync(path.join(fx.repo.work, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
    fs.writeFileSync(path.join(fx.repo.work, 'VERSION'), '1.2.9.0\n');
    fs.writeFileSync(path.join(fx.repo.work, 'CHANGELOG.md'), readFile(fx.repo, 'CHANGELOG.md').replace('# Changelog\n', '# Changelog\n\n## [1.2.9.0] - 2026-10-28\n\n- legacy #3\n'));
    fx.repo.git('add', '-A'); fx.repo.git('commit', '-q', '-m', 'legacy stamped pr');
    fx.repo.git('push', '-q', '-f', 'origin', 'HEAD:refs/heads/pr-3');
    const head = fx.repo.git('rev-parse', 'HEAD');
    fx.write(d => { d.prs['3'] = { state: 'OPEN', headRefName: 'pr-3', isCrossRepository: false, title: 'legacy', body: shippedBody('3', head) }; });
    const r = land(fx, ['--pr', '3']);
    expect(r.err).toBe('');
    expect(r.out).toMatch(/^legacy: the pin stamped 1\.2\.9\.0 itself/m);
    expect(r.out).toMatch(/^resolved: .*CHANGELOG\.md/m);
    const stamp = remote(fx, 'pr-3');
    expect(show(fx, stamp + ':VERSION')).toBe('1.2.5.0');
    const merged = JSON.parse(show(fx, stamp + ':package.json'));
    expect(merged.dependencies).toEqual({ 'left-pad': '1.2.3', 'right-pad': '2.0.0' });
    expect(show(fx, stamp + ':CHANGELOG.md')).toMatch(/## \[1\.2\.5\.0\][^\n]*\n\n- legacy #3\n\n## \[1\.2\.4\.0\][^\n]*\n\n- #1 change/);
  }, 90_000);

  test('a PR with no entry gets one from its title; a product conflict refuses with nothing pushed', () => {
    const fx = setup();
    openPr(fx, '4', { fragment: null, edit: w => fs.writeFileSync(path.join(w, 'shared.txt'), 'four\n') });
    openPr(fx, '5', { edit: w => fs.writeFileSync(path.join(w, 'shared.txt'), 'five\n') });
    const r = land(fx, ['--pr', '4']);
    expect(r.out).toContain('entry: none in the PR, so land wrote changelog.d/land-4.md from the title');
    expect(show(fx, remote(fx, 'pr-4') + ':CHANGELOG.md')).toContain('- PR 4 title (#4)');
    land(fx, ['--pr', '4']);
    const pin5 = remote(fx, 'pr-5');
    const c = land(fx, ['--pr', '5']);
    expect(c.status).toBe(EXIT.refused);
    expect(c.err).toMatch(/#5 conflicts with origin\/main in shared\.txt.*\(QUEUE_LAND_CONFLICT\)/);
    expect(remote(fx, 'pr-5')).toBe(pin5);
  }, 90_000);
});

describe('land: lock, races and refusals', () => {
  test('a held lock refuses; --break-lock takes over a lock that is not mid-push', () => {
    const fx = setup();
    openPr(fx, '1'); openPr(fx, '2');
    expect(land(fx, ['--pr', '1']).status).toBe(EXIT.ok);
    const held = land(fx, ['--pr', '2']);
    expect(held.err).toMatch(/#1 holds the land lock .*phase waiting.*\(QUEUE_LAND_LOCKED\)/);
    const broke = land(fx, ['--pr', '2', '--break-lock']);
    expect(broke.out).toContain("LOCK: broke #1's lock");
  }, 90_000);

  test('the base moving during CI restamps and pushes under the last-pushed lease; a third move stops', () => {
    const fx = setup();
    openPr(fx, '1'); openPr(fx, '2');
    const pin1 = remote(fx, 'pr-1');
    expect(land(fx, ['--pr', '1']).status).toBe(EXIT.ok);
    const firstStamp = remote(fx, 'pr-1');
    const bump = (n: number) => { fx.repo.git('fetch', '-q', 'origin'); fx.repo.git('checkout', '-q', '--detach', 'origin/main'); fs.writeFileSync(path.join(fx.repo.work, 'outside-' + n + '.txt'), 'x\n'); fx.repo.git('add', '-A'); fx.repo.git('commit', '-q', '-m', 'outside ' + n); fx.repo.git('push', '-q', 'origin', 'HEAD:refs/heads/main'); };
    bump(1);
    const again = land(fx, ['--pr', '1']);
    expect(again.err).toBe('');
    expect(again.out).toMatch(/^BASE_MOVED: /m);
    const secondStamp = remote(fx, 'pr-1');
    expect(secondStamp).not.toBe(firstStamp);
    expect(fx.repo.git('rev-list', '--parents', '-n', '1', secondStamp).split(' ')[1]).toBe(pin1);
    bump(2); expect(land(fx, ['--pr', '1']).status).toBe(EXIT.ok);
    bump(3);
    expect(land(fx, ['--pr', '1']).err).toContain('(QUEUE_LAND_BASE_BUSY)');
  }, 90_000);

  test('a missing receipt refuses before the lock; a foreign push after the stamp is never overwritten', () => {
    const fx = setup();
    openPr(fx, '6', { shipped: false });
    expect(land(fx, ['--pr', '6']).err).toContain('(QUEUE_RECEIPT_MISSING)');
    openPr(fx, '8');
    expect(land(fx, ['--pr', '8']).status).toBe(EXIT.ok);
    fx.repo.git('fetch', '-q', 'origin');
    fx.repo.git('checkout', '-q', '--detach', 'origin/pr-8');
    fs.writeFileSync(path.join(fx.repo.work, 'late.txt'), 'late\n'); fx.repo.git('add', '-A'); fx.repo.git('commit', '-q', '-m', 'late');
    fx.repo.git('push', '-q', 'origin', 'HEAD:refs/heads/pr-8');
    const late = fx.repo.git('rev-parse', 'HEAD');
    const r = land(fx, ['--pr', '8', '--break-lock']);
    expect(r.err).toMatch(/QUEUE_RECEIPT_STALE/);
    expect(remote(fx, 'pr-8')).toBe(late);
  }, 90_000);

  test('drift: a merge outside land between the check and the squash fails loudly and keeps the lock', () => {
    const fx = setup();
    openPr(fx, '9');
    expect(land(fx, ['--pr', '9']).status).toBe(EXIT.ok);
    fx.write(d => { d.driftOnMerge = true; });
    const r = land(fx, ['--pr', '9']);
    expect(r.err).toContain('(QUEUE_LAND_DRIFT)');
    openPr(fx, '10');
    expect(land(fx, ['--pr', '10']).err).toMatch(/#9 holds the land lock .*phase drift.*\(QUEUE_LAND_LOCKED\)/);
  }, 90_000);

  test('census lists what land would do, writing nothing', () => {
    const fx = setup();
    openPr(fx, '1'); openPr(fx, '2', { fragment: null });
    const c = runBin(fx.repo, 'gstack-ship-queue', ['land', '--census', '--base', 'main'], fx.env);
    expect(c.status).toBe(EXIT.ok);
    expect(c.out).toMatch(/^#1 [0-9a-f]{12}: fold pr-1\.md$/m);
    expect(c.out).toMatch(/^#2 [0-9a-f]{12}: no entry \(land writes one from the title\)$/m);
  }, 90_000);
});

describe('resolveReleaseConflicts', () => {
  test('a manifest whose version conflicts keeps the clean dependency edit and takes the base version; a real dependency conflict stays a conflict', () => {
    const fx = setup();
    const { repo } = fx;
    const write = (v: string, deps: Record<string, string>) => fs.writeFileSync(path.join(repo.work, 'package.json'), JSON.stringify({ name: 'fixture', version: v, dependencies: deps }, null, 2) + '\n');
    repo.git('checkout', '-q', '-B', 'base-x', 'origin/main');
    write('1.2.3', { a: '1' }); repo.git('commit', '-qam', 'base');
    repo.git('checkout', '-q', '-B', 'ours-x'); write('1.2.9', { a: '1', b: '2' }); repo.git('commit', '-qam', 'ours');
    repo.git('checkout', '-q', '-B', 'theirs-x', 'base-x'); write('1.2.4', { a: '1' }); repo.git('commit', '-qam', 'theirs');
    repo.git('checkout', '-q', 'ours-x');
    try { repo.git('merge', '--no-commit', 'theirs-x'); } catch {}
    const policy = mergePolicy(POLICY, 'test').policy;
    expect(resolveReleaseConflicts(repo.work, ['package.json'], policy, 'VERSION')).toEqual([]);
    expect(JSON.parse(readFile(repo, 'package.json'))).toEqual({ name: 'fixture', version: '1.2.4', dependencies: { a: '1', b: '2' } });
    repo.git('merge', '--abort');
    repo.git('checkout', '-q', 'theirs-x'); write('1.2.4', { a: '3' }); repo.git('commit', '-qam', 'theirs dep');
    repo.git('checkout', '-q', 'ours-x'); write('1.2.9', { a: '2', b: '2' }); repo.git('commit', '-qam', 'ours dep');
    try { repo.git('merge', '--no-commit', 'theirs-x'); } catch {}
    expect(resolveReleaseConflicts(repo.work, ['package.json'], policy, 'VERSION')).toEqual(['package.json']);
  }, 90_000);
});
