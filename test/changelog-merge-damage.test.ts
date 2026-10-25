/**
 * CHANGELOG merges that would carry damage to released history (GSTA-67,
 * from #3345 on 2026-10-22). #3345's pin 1eb7092 replaced main's
 * `## [1.91.179.0]` heading with `## [Unreleased]` instead of inserting
 * above it, and mergeChangelogs returned non-null output with 179's body
 * duplicated into [Unreleased]; the train's T1 6755ab8 carried it. The
 * fixtures under test/fixtures/merge-train-3345/ are the real CHANGELOGs at
 * those commits, cut below 1.91.177.0. A null merge means a hand resolve.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { changelogDamage, mergeChangelogs, ownEntryAboveMain, parseChangelog } from '../lib/changelog-check';

const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dir, 'fixtures', 'merge-train-3345', name), 'utf8');
const base = fixture('base-a59b5e4.md');
const pin = fixture('pin-1eb7092.md');
const main = fixture('main-4a98e40.md');
const keys = (text: string) => parseChangelog(text).sections.map(s => s.version ?? 'Unreleased');

describe('mergeChangelogs refuses damage to released history', () => {
  test('GSTA-64 repro: a released heading replaced by [Unreleased] is null, not a merge with the 1.0.1 body duplicated', () => {
    const ours = '# Changelog\n\n## [Unreleased]\n\nNew entry.\n\nOld 1.0.1 body.\n\n## [1.0.0] - d\n\nOld 1.0.0 body.\n';
    const theirs = '# Changelog\n\n## [1.0.2] - d\n\nMain body.\n\n## [1.0.1] - d\n\nOld 1.0.1 body.\n\n## [1.0.0] - d\n\nOld 1.0.0 body.\n';
    expect(changelogDamage(ours, theirs)).toContain("ours's Unreleased section holds released 1.0.1 text");
    expect(mergeChangelogs(ours, theirs)).toBeNull();
    const baseText = '# Changelog\n\n## [1.0.1] - d\n\nOld 1.0.1 body.\n\n## [1.0.0] - d\n\nOld 1.0.0 body.\n';
    expect(changelogDamage(ours, theirs, baseText)).toBe('ours drops released heading 1.0.1 that the merge base carries');
  });

  test('#3345: pin 1eb7092 against main 4a98e40 is null with or without the merge base; the train T1 it produced duplicated 179', () => {
    expect(changelogDamage(pin, main, base)).toBe('ours drops released heading 1.91.179.0 that the merge base carries');
    expect(changelogDamage(pin, main)).toMatch(/^ours's Unreleased section holds released 1\.91\.179\.0 text/);
    expect(mergeChangelogs(pin, main, base)).toBeNull();
    expect(mergeChangelogs(pin, main)).toBeNull();
    const t1 = fixture('train-T1-6755ab8.md');
    expect(keys(t1)).toEqual(['Unreleased', '1.91.181.0', '1.91.180.0', '1.91.179.0', '1.91.178.0', '1.91.177.0']);
    expect(changelogDamage(t1, main)).toMatch(/^ours's Unreleased section holds released 1\.91\.179\.0 text/);
  });

  test('either side, and a renamed heading, count as damage', () => {
    expect(changelogDamage(main, pin, base)).toBe('theirs drops released heading 1.91.179.0 that the merge base carries');
    const renamed = main.replace('## [1.91.178.0]', '## [1.91.178.9]');
    expect(changelogDamage(renamed, main, base)).toBe('ours drops released heading 1.91.178.0 that the merge base carries');
    expect(changelogDamage(renamed, main)).toMatch(/^ours's 1\.91\.178\.9 section holds released 1\.91\.178\.0 text/);
  });

  test('negative controls: the real hand resolve, an entry above a newer main, a shared tentative stamp and two [Unreleased] blocks are not damage', () => {
    const fixed = pin.replace(/\n\n\*\*docsync-fault-interface/, '\n\n## [1.91.179.0] - 2026-10-22\n\n**docsync-fault-interface');
    expect(keys(fixed)).toEqual(['Unreleased', '1.91.179.0', '1.91.178.0', '1.91.177.0']);
    expect(changelogDamage(fixed, main, base)).toBeNull();
    const merged = mergeChangelogs(fixed, main, base)!;
    expect(keys(merged)).toEqual(['Unreleased', '1.91.181.0', '1.91.180.0', '1.91.179.0', '1.91.178.0', '1.91.177.0']);
    expect(merged.split('**docsync-fault-interface fits its budgets').length).toBe(2);
    const b = '## [1.2.3.0] - d\n\n- base release entry\n';
    expect(mergeChangelogs(`# C\n\n## [1.2.4.0] - d\n\n- mine, a new entry\n\n${b}`, `# C\n\n## [1.2.4.0] - e\n\n- theirs, a new entry\n\n${b}`, `# C\n\n${b}`)).not.toBeNull();
    expect(changelogDamage(`# C\n\n## [Unreleased]\n\n- #2 change, its entry\n\n${b}`, `# C\n\n## [Unreleased]\n\n- #1 change, its entry\n\n${b}`, `# C\n\n${b}`)).toBeNull();
  });
});

describe("ownEntryAboveMain: a merged-in head's CHANGELOG however it was resolved", () => {
  const dir = path.join(import.meta.dir, 'fixtures', 'merge-train-3345');
  const diff = spawnSync('git', ['diff', '--no-index', '--unified=0', '--no-color', path.join(dir, 'base-a59b5e4.md'), path.join(dir, 'pin-1eb7092.md')], { encoding: 'utf8', timeout: 30_000 }).stdout;
  const authored = new Set(diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1)));
  const stamped = fixture('stamped-de23f5d.md');

  test("#3345's stamped head de23f5d is main 4a98e40's CHANGELOG plus its own entry; the damaged train T1 is not", () => {
    expect(authored.has('### Fixed')).toBe(true);
    expect(authored.has('## [1.91.179.0] - 2026-10-22')).toBe(false);
    expect(ownEntryAboveMain(stamped, main, authored)).toBeNull();
    expect(ownEntryAboveMain(fixture('train-T1-6755ab8.md'), main, authored)).toMatch(/^the PR's entry holds a line its pin never added: "\*\*docsync-fault-interface/);
  });

  test('negative controls: an invented line, a dropped or edited main section, a changed header and a duplicate heading are refused', () => {
    expect(ownEntryAboveMain(stamped.replace('### Fixed\n', '### Fixed\n- added after the gate\n'), main, authored)).toBe('the PR\'s entry holds a line its pin never added: "- added after the gate"');
    expect(ownEntryAboveMain(stamped.replace(/## \[1\.91\.180\.0\][^\n]*\n/, ''), main, authored)).toBe("main's ## [1.91.181.0] - 2026-10-23 is not carried unchanged below the PR's entry");
    expect(ownEntryAboveMain(stamped.replace('## [1.91.178.0]', '## [1.91.178.0]\n\n- smuggled'), main, authored)).toBe("main's ## [1.91.178.0] - 2026-10-22 is not carried unchanged below the PR's entry");
    expect(ownEntryAboveMain(stamped.replace('# Changelog', '# Change log'), main, authored)).toBe('the header differs from main');
    expect(ownEntryAboveMain(stamped.replace('## [1.91.182.0]', '## [1.91.181.0]'), main, authored)).toMatch(/is headed twice$/);
  });
});
