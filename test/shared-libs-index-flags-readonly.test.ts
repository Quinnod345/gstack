/**
 * Train gate 40619718717 (798a37d8) slice 14, shared-libs-review-index-flags, assume-unchanged trial: while
 * gathering evidence the actor ran `git update-index --really-refresh`, which cleared the assume-unchanged flag
 * the checker reads, so the prerequisite binding went stale. The skill's evidence step now says it is read-only.
 */
import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fixtureGit, type SharedLibsFixture } from './helpers/shared-libs-eval-fixture';
import { checkPathReviewPrerequisites, preparePathEligibilityFixture } from './helpers/shared-libs-path-fixture';

const ROOT = path.resolve(import.meta.dir, '..');
const fixtures: SharedLibsFixture[] = [];
afterAll(() => { for (const f of fixtures) fs.rmSync(f.root, { recursive: true, force: true }); });

test.each(['review', 'ship'])('%s: the shared-code evidence step forbids the index refresh the captured actor ran', skill => {
  const section = fs.readFileSync(path.join(ROOT, skill, 'sections/shared-code-reuse.md'), 'utf8');
  const step = section.slice(section.indexOf('1. **Read the evidence.**'), section.indexOf('2. **Run the checker.**')).replace(/\s+/g, ' ');
  expect(step).toContain('read-only: `git update-index`, even `--really-refresh`, clears the index flags the checker reads');
});

test.each([
  ['captured refresh', 'git update-index --really-refresh >/dev/null 2>&1; echo "(no index mutation above intended)"', false],
  ['captured read-only inspection', 'git ls-files -v; git status --porcelain=v1; git hash-object --no-filters -- src/retry-route.ts; git ls-files --debug src/retry-route.ts', true],
] as const)('%s against the assume-unchanged fixture: the prerequisite detector sees it (%s)', (_, command, unchanged) => {
  const prepared = preparePathEligibilityFixture('assume-unchanged');
  const f = prepared.fixture;
  fixtures.push(f);
  const before = checkPathReviewPrerequisites(f, prepared.resumed.input);
  expect(before.settled).toBe(true);
  expect(fixtureGit(f, 'ls-files', '-v', 'src/retry-route.ts')).toMatch(/^h /);
  execFileSync('bash', ['-c', command], { cwd: f.repo, env: { ...process.env, ...f.env }, encoding: 'utf8', timeout: 30_000 });
  const after = checkPathReviewPrerequisites(f, prepared.resumed.input);
  if (unchanged) expect(after).toEqual(before);
  else {
    expect(fixtureGit(f, 'ls-files', '-v', 'src/retry-route.ts')).toMatch(/^H /);
    expect({ current: after.current, settled: after.settled }).toEqual({ current: false, settled: false });
  }
});
