/**
 * Harness lane E: the /ship review loop's finding scope (lib/review-scope.ts,
 * bin/gstack-review-scope). Five Captains hit a loop that re-read the whole
 * diff each pass and fixed neighbours in pre-existing code until the cycle
 * cap. Under `review_scope: frozen` pass 1 fixes the diff and defers blocking
 * findings in unchanged code to issues; pass 2+ fixes only blocking findings
 * in the range since the previous pass (or the diff) and notes the rest.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import {
  isBlocking, kindOf, locusOf, parseHunks, renderDeferredIssue, renderDeferredSection, reviewLoopLine, scopeFindings, scopeLine, summarizeReviewLoop,
  type ScopedFinding,
} from '../lib/review-scope';
import { cleanup, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/restamp-fixture';

const repos: FixtureRepo[] = [];
const fixture = () => { const r = makeFixtureRepo({ prefix: 'review-scope-' }); repos.push(r); return r; };
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const DIFF = [
  'diff --git a/src/auth.ts b/src/auth.ts', 'index 1..2 100644', '--- a/src/auth.ts', '+++ b/src/auth.ts',
  '@@ -10,2 +10,4 @@ export function check() {', '+  const a = 1;', '+  const b = 2;', '@@ -40 +42,0 @@', '-  old();',
  'diff --git a/src/new.ts b/src/new.ts', 'new file mode 100644', '--- /dev/null', '+++ b/src/new.ts', '@@ -0,0 +1,3 @@', '+a', '+b', '+c',
  'diff --git a/src/gone.ts b/src/gone.ts', 'deleted file mode 100644', '--- a/src/gone.ts', '+++ /dev/null', '@@ -1,3 +0,0 @@', '-a', '-b', '-c',
].join('\n');

describe('hunk parsing and locus', () => {
  test('parseHunks reads new-side ranges, whole added files, untracked files, and drops deleted files', () => {
    const hunks = parseHunks(DIFF, ['scratch/untracked.ts']);
    expect(hunks['src/auth.ts']).toEqual([[10, 13], [42, 42]]);
    expect(hunks['src/new.ts']).toBe('whole');
    expect(hunks['scratch/untracked.ts']).toBe('whole');
    expect(hunks['src/gone.ts']).toBeUndefined();
  });

  test('locusOf: inside a hunk or within 3 lines is the diff, farther is outside, an added file is whole, the range wins over the diff', () => {
    const diff = parseHunks(DIFF);
    expect(locusOf({ path: 'src/auth.ts', line: 11 }, diff, null)).toBe('diff');
    expect(locusOf({ path: 'src/auth.ts', line: 16 }, diff, null)).toBe('diff');
    expect(locusOf({ path: 'src/auth.ts', line: 17 }, diff, null)).toBe('outside');
    expect(locusOf({ path: 'src/auth.ts', line: 200 }, diff, null)).toBe('outside');
    expect(locusOf({ path: 'src/auth.ts' }, diff, null)).toBe('diff');
    expect(locusOf({ path: 'src/new.ts', line: 999 }, diff, null)).toBe('diff');
    expect(locusOf({ path: 'lib/other.ts', line: 1 }, diff, null)).toBe('outside');
    expect(locusOf({ fingerprint: 'src/auth.ts:11:security' }, diff, null)).toBe('diff');
    expect(locusOf({ fingerprint: 'shared-libs:abc' }, diff, null)).toBe('outside');
    const range = parseHunks('diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -11 +11 @@\n-x\n+y\n');
    expect(locusOf({ path: 'src/auth.ts', line: 11 }, diff, range)).toBe('fix-range');
    expect(locusOf({ path: 'src/auth.ts', line: 42 }, diff, range)).toBe('diff');
  });

  test('kind and the blocking floor: CRITICAL defects block; advisories, test gaps and INFORMATIONAL items never do', () => {
    expect(kindOf({ advisory: true, severity: 'INFORMATIONAL' })).toBe('advisory');
    expect(kindOf({ category: 'test-gap', severity: 'CRITICAL' })).toBe('test-gap');
    expect(kindOf({ category: 'security', severity: 'CRITICAL' })).toBe('defect');
    expect(isBlocking({ category: 'security', severity: 'CRITICAL' })).toBe(true);
    expect(isBlocking({ category: 'security', severity: 'critical' })).toBe(true);
    expect(isBlocking({ category: 'security', severity: 'INFORMATIONAL' })).toBe(false);
    expect(isBlocking({ category: 'test-coverage', severity: 'CRITICAL' })).toBe(false);
    expect(isBlocking({ advisory: true, severity: 'CRITICAL' })).toBe(false);
  });
});

describe('scope decisions', () => {
  const diff = parseHunks(DIFF);
  const range = parseHunks('diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -11 +11 @@\n-x\n+y\n');
  const findings = [
    { fingerprint: 'src/auth.ts:11:security', path: 'src/auth.ts', line: 11, severity: 'CRITICAL', category: 'security', summary: 'in range' },
    { fingerprint: 'src/auth.ts:42:logic', path: 'src/auth.ts', line: 42, severity: 'CRITICAL', category: 'logic', summary: 'in diff' },
    { fingerprint: 'src/auth.ts:42:naming', path: 'src/auth.ts', line: 42, severity: 'INFORMATIONAL', category: 'naming', summary: 'in diff, informational' },
    { fingerprint: 'lib/legacy.ts:7:data-loss', path: 'lib/legacy.ts', line: 7, severity: 'CRITICAL', category: 'data-loss', summary: 'pre-existing' },
    { fingerprint: 'lib/legacy.ts:9:style', path: 'lib/legacy.ts', line: 9, severity: 'INFORMATIONAL', category: 'style', summary: 'pre-existing wording' },
    { fingerprint: 'shared-libs:deadbeef', severity: 'INFORMATIONAL', advisory: true, category: 'shared-libs', summary: 'advice' },
  ];
  const by = (scoped: ScopedFinding[]) => Object.fromEntries(scoped.map(f => [f.fingerprint, `${f.locus}/${f.kind}/${f.blocking ? 'blocking' : 'below'}/${f.scope}`]));

  test('all: every finding is fixed, whatever its locus (the pre-frozen loop)', () => {
    const scoped = scopeFindings(findings, { policy: 'all', pass: 2, diffHunks: diff, rangeHunks: range });
    expect(scoped.every(f => f.scope === 'fix')).toBe(true);
    expect(by(scoped)['lib/legacy.ts:7:data-loss']).toBe('outside/defect/blocking/fix');
  });

  test('frozen pass 1: the diff is fixed, blocking findings outside are deferred, the rest are notes', () => {
    const scoped = scopeFindings(findings, { policy: 'frozen', pass: 1, diffHunks: diff, rangeHunks: range });
    expect(by(scoped)).toEqual({
      'src/auth.ts:11:security': 'diff/defect/blocking/fix',
      'src/auth.ts:42:logic': 'diff/defect/blocking/fix',
      'src/auth.ts:42:naming': 'diff/defect/below/fix',
      'lib/legacy.ts:7:data-loss': 'outside/defect/blocking/defer',
      'lib/legacy.ts:9:style': 'outside/defect/below/note',
      'shared-libs:deadbeef': 'outside/advisory/below/note',
    });
    expect(scopeLine('frozen', 1, scoped)).toBe('REVIEW_SCOPE: policy=frozen pass=1 findings=6 fix=3 defer=1 note=2 blocking=3');
  });

  test('diff-plus-blocking (the documented fallback, not the default): a blocking finding outside the diff is fixed here instead of filed; everything else is as frozen', () => {
    const p1 = by(scopeFindings(findings, { policy: 'diff-plus-blocking', pass: 1, diffHunks: diff, rangeHunks: range }));
    expect(p1['lib/legacy.ts:7:data-loss']).toBe('outside/defect/blocking/fix');
    expect(p1['lib/legacy.ts:9:style']).toBe('outside/defect/below/note');
    expect(p1['src/auth.ts:42:naming']).toBe('diff/defect/below/fix');
    const p2 = by(scopeFindings(findings, { policy: 'diff-plus-blocking', pass: 2, diffHunks: diff, rangeHunks: range }));
    expect(p2['lib/legacy.ts:7:data-loss']).toBe('outside/defect/blocking/fix');
    expect(p2['src/auth.ts:42:naming']).toBe('diff/defect/below/note');
    expect(Object.values(p2).some(v => v.endsWith('/defer'))).toBe(false);
  });

  test('frozen pass 2+: only blocking findings in the range or the diff are fixed; everything below the floor is a note', () => {
    const scoped = scopeFindings(findings, { policy: 'frozen', pass: 2, diffHunks: diff, rangeHunks: range });
    expect(by(scoped)).toEqual({
      'src/auth.ts:11:security': 'fix-range/defect/blocking/fix',
      'src/auth.ts:42:logic': 'diff/defect/blocking/fix',
      'src/auth.ts:42:naming': 'diff/defect/below/note',
      'lib/legacy.ts:7:data-loss': 'outside/defect/blocking/defer',
      'lib/legacy.ts:9:style': 'outside/defect/below/note',
      'shared-libs:deadbeef': 'outside/advisory/below/note',
    });
  });
});

describe('deferral rendering', () => {
  const finding: ScopedFinding = { fingerprint: 'lib/legacy.ts:7:data-loss', path: 'lib/legacy.ts', line: 7, severity: 'CRITICAL', category: 'data-loss', summary: 'Unbounded delete\nwithout a where clause', fix: 'add the tenant filter', specialist: 'security', locus: 'outside', kind: 'defect', blocking: true, scope: 'defer' };

  test('the issue names the origin PR, the finding and a marker that keeps a rerun from filing twice; the body section references and never closes', () => {
    const issue = renderDeferredIssue(finding, { repo: 'acme/app', pr: 42, branch: 'feat/x', head: 'a'.repeat(40) });
    expect(issue.title).toBe('Deferred review finding: lib/legacy.ts:7 — Unbounded delete without a where clause');
    expect(issue.body).toContain('acme/app#42 (head aaaaaaaaaaaa)');
    expect(issue.body).toContain('- **Severity:** CRITICAL');
    expect(issue.body).toContain('- **Suggested fix:** add the tenant filter');
    expect(issue.body).toContain('- **Found by:** security');
    expect(issue.marker).toBe('<!-- gstack-deferred-finding: lib/legacy.ts:7:data-loss -->');
    expect(issue.body.trimEnd().endsWith(issue.marker)).toBe(true);
    const section = renderDeferredSection(
      [{ fingerprint: 'lib/legacy.ts:7:data-loss', path: 'lib/legacy.ts:7', severity: 'CRITICAL', summary: 'Unbounded delete', issue: 77 },
        { fingerprint: 'lib/old.ts:1:auth', path: 'lib/old.ts:1', severity: 'CRITICAL', summary: 'Missing owner check', issue: null, reason: 'gh is not installed' }],
      [{ path: 'src/auth.ts', line: 42, severity: 'INFORMATIONAL', summary: 'rename b', advisory: true }]);
    expect(section).toContain('## Deferred findings');
    expect(section).toContain('- Deferred: #77 — CRITICAL `lib/legacy.ts:7` Unbounded delete');
    expect(section).toContain('- Deferred: unfiled (gh is not installed) — CRITICAL `lib/old.ts:1` Missing owner check');
    expect(section).toContain('## Review notes');
    expect(section).toContain('- INFORMATIONAL [ADVISORY] `src/auth.ts:42` rename b');
    expect(section).not.toMatch(/\b(fixes|closes|resolves)\b/i);
    expect(renderDeferredSection([], [])).toBe('');
  });
});

describe('loop summary', () => {
  test('counts this invocation\'s passes and unique blocking, deferred, noted and fixed findings', () => {
    const rows = [
      { skill: 'review', via: 'ship', timestamp: '2026-10-26T10:00:00Z', review_scope: 'frozen', findings: [
        { fingerprint: 'a:1:x', blocking: true, action: 'auto-fixed' }, { fingerprint: 'b:1:y', blocking: true, action: 'deferred', issue: 5 }, { fingerprint: 'c:1:z', action: 'noted' }] },
      { skill: 'review', via: 'ship', timestamp: '2026-10-26T10:30:00Z', review_scope: 'frozen', findings: [
        { fingerprint: 'b:1:y', blocking: true, action: 'deferred', issue: 5 }, { fingerprint: 'c:1:z', action: 'noted' }] },
      { skill: 'review', via: 'ship', timestamp: '2026-10-26T09:00:00Z', findings: [{ fingerprint: 'old:1:q', blocking: true, action: 'fixed' }] },
      { skill: 'adversarial-review', timestamp: '2026-10-26T10:15:00Z', findings: [{ fingerprint: 'd:1:w', blocking: true }] },
      { skill: 'review', timestamp: '2026-10-26T10:40:00Z', findings: [{ fingerprint: 'e:1:v', blocking: true }] },
    ];
    const s = summarizeReviewLoop(rows, '2026-10-26T09:30:00Z');
    expect(s).toEqual({ passes: 2, blocking_found: 2, deferred: 1, noted: 1, fixed: 1, scope: 'frozen' });
    expect(reviewLoopLine(s)).toBe('REVIEW_LOOP: passes=2 blocking_found=2 deferred=1 noted=1 fixed=1 scope=frozen');
  });
});

describe('gstack-review-scope (bin)', () => {
  test('classify reads the branch diff and the pass range from git, honours the policy default, and refuses bad input with REVIEW_SCOPE_INPUT / REVIEW_SCOPE_RANGE', () => {
    const repo = fixture();
    const src = path.join(repo.work, 'src');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'legacy.ts'), Array.from({ length: 30 }, (_, i) => `legacy ${i + 1}`).join('\n') + '\n');
    fs.writeFileSync(path.join(src, 'auth.ts'), Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
    repo.git('add', '.'); repo.git('commit', '-qm', 'seed'); repo.git('push', '-q', 'origin', 'main');
    repo.git('checkout', '-qb', 'feat');
    const lines = fs.readFileSync(path.join(src, 'auth.ts'), 'utf8').split('\n');
    lines[9] = 'line 10 changed';
    fs.writeFileSync(path.join(src, 'auth.ts'), lines.join('\n'));
    repo.git('commit', '-qam', 'change line 10');
    const pass1Head = repo.git('rev-parse', 'HEAD');
    const findings = JSON.stringify([
      { fingerprint: 'src/auth.ts:10:logic', path: 'src/auth.ts', line: 10, severity: 'CRITICAL', category: 'logic', summary: 'wrong' },
      { fingerprint: 'src/auth.ts:25:logic', path: 'src/auth.ts', line: 25, severity: 'CRITICAL', category: 'logic', summary: 'neighbour' },
      { fingerprint: 'src/legacy.ts:3:security', path: 'src/legacy.ts', line: 3, severity: 'CRITICAL', category: 'security', summary: 'old' },
      { fingerprint: 'src/legacy.ts:4:style', path: 'src/legacy.ts', line: 4, severity: 'INFORMATIONAL', category: 'style', summary: 'wording' },
    ]);
    const f = path.join(repo.root, 'findings.json');
    fs.writeFileSync(f, findings);
    const p1 = runBin(repo, 'gstack-review-scope', ['classify', '--base', 'main', '--pass', '1', '--findings', f, '--json']);
    expect(p1.status).toBe(EXIT.ok);
    expect(p1.err.trim()).toBe('REVIEW_SCOPE: policy=frozen pass=1 findings=4 fix=1 defer=2 note=1 blocking=3');
    const j1 = JSON.parse(p1.out);
    expect(j1.policy).toBe('frozen');
    expect(j1.findings.map((x: ScopedFinding) => `${x.fingerprint}=${x.locus}/${x.scope}`)).toEqual([
      'src/auth.ts:10:logic=diff/fix', 'src/auth.ts:25:logic=outside/defer', 'src/legacy.ts:3:security=outside/defer', 'src/legacy.ts:4:style=outside/note']);
    // pass 1 "fixed" line 10 and touched line 25 (a regression in the fix range)
    lines[9] = 'line 10 fixed'; lines[24] = 'line 25 touched by the fix';
    fs.writeFileSync(path.join(src, 'auth.ts'), lines.join('\n'));
    repo.git('commit', '-qam', 'fix: pre-landing review fixes');
    const p2 = runBin(repo, 'gstack-review-scope', ['classify', '--base', 'main', '--pass', '2', '--range-base', pass1Head, '--findings', f, '--json']);
    expect(p2.status).toBe(EXIT.ok);
    expect(JSON.parse(p2.out).findings.map((x: ScopedFinding) => `${x.fingerprint}=${x.locus}/${x.scope}`)).toEqual([
      'src/auth.ts:10:logic=fix-range/fix', 'src/auth.ts:25:logic=fix-range/fix', 'src/legacy.ts:3:security=outside/defer', 'src/legacy.ts:4:style=outside/note']);
    const all = runBin(repo, 'gstack-review-scope', ['classify', '--base', 'main', '--pass', '2', '--range-base', pass1Head, '--policy', 'all', '--findings', f, '--json']);
    expect(JSON.parse(all.out).findings.every((x: ScopedFinding) => x.scope === 'fix')).toBe(true);
    const noRange = runBin(repo, 'gstack-review-scope', ['classify', '--base', 'main', '--pass', '2', '--findings', f]);
    expect(noRange.status).toBe(EXIT.fail);
    expect(noRange.err).toContain('(REVIEW_SCOPE_INPUT;');
    const badRange = runBin(repo, 'gstack-review-scope', ['classify', '--base', 'main', '--pass', '2', '--range-base', 'f'.repeat(40), '--findings', f]);
    expect(badRange.status).toBe(EXIT.fail);
    expect(badRange.err).toContain('(REVIEW_SCOPE_RANGE;');
    fs.writeFileSync(f, '{"not":"an array"}');
    const bad = runBin(repo, 'gstack-review-scope', ['classify', '--base', 'main', '--pass', '1', '--findings', f]);
    expect(bad.status).toBe(EXIT.fail);
    expect(bad.err).toContain('(REVIEW_SCOPE_INPUT;');
  });

  test('defer without gh keeps the finding deferred as unfiled (exit 3) and renders the PR-body sections; --dry-run files nothing', () => {
    const repo = fixture();
    const classified = path.join(repo.root, 'classified.json');
    fs.writeFileSync(classified, JSON.stringify([
      { fingerprint: 'lib/legacy.ts:7:data-loss', path: 'lib/legacy.ts', line: 7, severity: 'CRITICAL', category: 'data-loss', summary: 'Unbounded delete', locus: 'outside', kind: 'defect', blocking: true, scope: 'defer' },
      { fingerprint: 'src/auth.ts:42:naming', path: 'src/auth.ts', line: 42, severity: 'INFORMATIONAL', category: 'naming', summary: 'rename b', locus: 'diff', kind: 'defect', blocking: false, scope: 'note' },
      { fingerprint: 'src/auth.ts:11:security', path: 'src/auth.ts', line: 11, severity: 'CRITICAL', category: 'security', summary: 'fixed', locus: 'diff', kind: 'defect', blocking: true, scope: 'fix' },
    ]));
    const dry = runBin(repo, 'gstack-review-scope', ['defer', '--findings', classified, '--pr', '42', '--dry-run', '--json']);
    expect(dry.status).toBe(EXIT.ok);
    expect(JSON.parse(dry.out)).toEqual([{ fingerprint: 'lib/legacy.ts:7:data-loss', path: 'lib/legacy.ts:7', severity: 'CRITICAL', summary: 'Unbounded delete', issue: null, reason: 'dry run' }]);
    const noGh = path.join(repo.root, 'nogh');
    fs.mkdirSync(noGh);
    fs.writeFileSync(path.join(noGh, 'gh'), '#!/bin/sh\necho "gh: not logged in" >&2; exit 4\n', { mode: 0o755 });
    const out = path.join(repo.root, 'deferred.json');
    const unfiled = runBin(repo, 'gstack-review-scope', ['defer', '--findings', classified, '--pr', '42', '--out', out], { PATH: `${noGh}:${process.env.PATH}` });
    expect(unfiled.status).toBe(EXIT.refused);
    expect(unfiled.err).toMatch(/^DEFERRED: unfiled \(gh issue create failed: gh: not logged in\) CRITICAL lib\/legacy\.ts:7$/m);
    expect(unfiled.out).toContain('- Deferred: unfiled (gh issue create failed: gh: not logged in) — CRITICAL `lib/legacy.ts:7` Unbounded delete');
    const rendered = runBin(repo, 'gstack-review-scope', ['render', '--deferred', out, '--findings', classified]);
    expect(rendered.status).toBe(EXIT.ok);
    expect(rendered.out).toContain('## Deferred findings');
    expect(rendered.out).toContain('## Review notes');
    expect(rendered.out).toContain('- INFORMATIONAL `src/auth.ts:42` rename b');
    expect(rendered.out).not.toContain('src/auth.ts:11');
  });

  test('defer through gh creates one issue per deferred finding and reuses an open issue that already carries the marker', () => {
    const repo = fixture();
    const shim = path.join(repo.root, 'gh-shim');
    fs.mkdirSync(shim);
    const log = path.join(shim, 'calls.log');
    fs.writeFileSync(path.join(shim, 'gh'), [
      '#!/bin/sh', `echo "$*" >> "${log}"`,
      'if [ "$1" = issue ] && [ "$2" = list ]; then',
      `  case "$*" in *"lib/legacy.ts:7:data-loss"*) echo '[{"number":9,"url":"https://example.test/acme/app/issues/9","body":"x <!-- gstack-deferred-finding: lib/legacy.ts:7:data-loss --> y"}]' ;; *) echo '[]' ;; esac; exit 0; fi`,
      'if [ "$1" = issue ] && [ "$2" = create ]; then echo "https://example.test/acme/app/issues/10"; exit 0; fi',
      'echo "unsupported $*" >&2; exit 1', '',
    ].join('\n'), { mode: 0o755 });
    const classified = path.join(repo.root, 'classified.json');
    fs.writeFileSync(classified, JSON.stringify([
      { fingerprint: 'lib/legacy.ts:7:data-loss', path: 'lib/legacy.ts', line: 7, severity: 'CRITICAL', category: 'data-loss', summary: 'Unbounded delete', locus: 'outside', kind: 'defect', blocking: true, scope: 'defer' },
      { fingerprint: 'lib/old.ts:1:auth', path: 'lib/old.ts', line: 1, severity: 'CRITICAL', category: 'auth', summary: 'Missing owner check', fix: 'check owner', locus: 'outside', kind: 'defect', blocking: true, scope: 'defer' },
    ]));
    const r = runBin(repo, 'gstack-review-scope', ['defer', '--findings', classified, '--pr', '42', '--repo', 'acme/app', '--json'], { PATH: `${shim}:${process.env.PATH}` });
    expect(r.status).toBe(EXIT.ok);
    expect(JSON.parse(r.out)).toEqual([
      { fingerprint: 'lib/legacy.ts:7:data-loss', path: 'lib/legacy.ts:7', severity: 'CRITICAL', summary: 'Unbounded delete', issue: 9, url: 'https://example.test/acme/app/issues/9', reason: 'already filed' },
      { fingerprint: 'lib/old.ts:1:auth', path: 'lib/old.ts:1', severity: 'CRITICAL', summary: 'Missing owner check', issue: 10, url: 'https://example.test/acme/app/issues/10' },
    ]);
    expect(r.err).toContain('DEFERRED: #9 CRITICAL lib/legacy.ts:7');
    expect(r.err).toContain('DEFERRED: #10 CRITICAL lib/old.ts:1');
    const calls = fs.readFileSync(log, 'utf8');
    expect(calls.match(/^issue create /gm)?.length).toBe(1);
    expect(calls).toContain('issue create --repo acme/app --title Deferred review finding: lib/old.ts:1 — Missing owner check --body-file');
  });
});
