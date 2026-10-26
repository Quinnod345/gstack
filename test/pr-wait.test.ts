/**
 * gstack-pr-wait (lib/pr-wait.ts, lib/pr-wait-github.ts): one stdout line per
 * real event, state under the gstack state root, required checks from rulesets
 * so an unstarted one is pending, two identical polls before green, the
 * base-moved-and-touches-this-PR event, BEHIND and DIRTY, the per-PR lock, the
 * 6-hour baseline staleness and the configurable bot lists. Every GitHub read
 * goes through a fake gh runner, as test/gstack-ci-gate.test.ts does.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { GhResult } from '../lib/ci-gate';
import { PR_WAIT_EXIT, Watcher, botLists, parsePrTarget, parsePrWaitArgs, prWaitMain, stateDir, type PrWaitEnv, type PrWaitOptions } from '../lib/pr-wait';
import { RESULT_CODES } from '../lib/result-codes';

const ROOT = join(import.meta.dir, '..');
const HEAD = 'a'.repeat(40);
const BASE_A = 'b'.repeat(40);
const BASE_B = 'c'.repeat(40);
const REPO = 'owner/project';

const ok = (stdout: string): GhResult => ({ status: 0, stdout, stderr: '' });
const err = (stderr: string, status = 1): GhResult => ({ status, stdout: '', stderr: `${stderr}\n` });
const NOT_FOUND = err('gh: Not Found (HTTP 404)');

interface Author { login: string; bot?: boolean }
const actor = ({ login, bot }: Author) => ({ login, __typename: bot ? 'Bot' : 'User' });
const comment = (id: string, author: Author, body: string) => ({ id, url: `https://github.com/${REPO}/pull/42#issuecomment-${id}`, body, author: actor(author) });
const review = (id: string, author: Author, state: string, body = '', commit: string | null = HEAD) =>
  ({ id, url: `https://github.com/${REPO}/pull/42#pullrequestreview-${id}`, state, body, commit: commit ? { oid: commit } : null, author: actor(author) });
const thread = (path: string, line: number | null, resolved: boolean, ...comments: ReturnType<typeof comment>[]) => ({ isResolved: resolved, path, line, comments: { nodes: comments } });

interface PrShape {
  state?: string; head?: string; base?: string; baseOid?: string | null; mergeState?: string;
  comments?: ReturnType<typeof comment>[]; reviews?: ReturnType<typeof review>[]; threads?: ReturnType<typeof thread>[];
}
const prJson = (shape: PrShape = {}) => JSON.stringify({
  data: {
    viewer: { login: 'me' },
    repository: {
      pullRequest: {
        url: `https://github.com/${REPO}/pull/42`, state: shape.state ?? 'OPEN', headRefOid: shape.head ?? HEAD,
        baseRefName: shape.base ?? 'main', mergeStateStatus: shape.mergeState ?? 'CLEAN', author: { login: 'author' },
        baseRef: shape.baseOid === null ? null : { target: { oid: shape.baseOid ?? BASE_A } },
        comments: { nodes: shape.comments ?? [] }, reviews: { nodes: shape.reviews ?? [] }, reviewThreads: { nodes: shape.threads ?? [] },
      },
    },
  },
});
const checksJson = (...rows: Array<[string, string] | [string, string, string]>) =>
  JSON.stringify(rows.map(([name, bucket, description]) => ({ name, bucket, link: `https://ci.example/${name}`, description: description ?? '' })));

/** Scripted replies per gh command shape; a list is consumed one poll at a time, the last reply repeating. */
interface Script {
  pr?: string | string[];
  checks?: GhResult | GhResult[];
  rulesets?: GhResult;
  protection?: GhResult;
  prFiles?: GhResult;
  compare?: Record<string, GhResult>;
  behind?: GhResult;
}
function fakeGh(script: Script) {
  const queue = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? [...value] : [value]);
  const prs = queue(script.pr).map(ok);
  const checks = queue(script.checks);
  const next = <T>(q: T[]): T | undefined => (q.length > 1 ? q.shift() : q[0]);
  const calls: string[][] = [];
  const gh = (args: string[]): GhResult => {
    calls.push(args);
    const [a, b] = args;
    if (a === 'api' && b === 'graphql') return next(prs) ?? ok(prJson());
    if (a === 'pr' && b === 'checks') return next(checks) ?? ok(checksJson());
    if (a === 'pr' && b === 'view') return ok('{"number":42}');
    if (a === 'pr' && b === 'diff') return script.prFiles ?? ok('');
    if (a === 'repo' && b === 'view') return ok(`${REPO}\n`);
    if (a === 'api' && b.includes('/rules/branches/')) return script.rulesets ?? NOT_FOUND;
    if (a === 'api' && b.includes('/protection/')) return script.protection ?? NOT_FOUND;
    if (a === 'api' && b.includes('/compare/')) {
      if (args.includes('.behind_by')) return script.behind ?? ok('0\n');
      return script.compare?.[b.split('/compare/')[1]] ?? ok('');
    }
    throw new Error(`fake gh: unexpected ${args.join(' ')}`);
  };
  return Object.assign(gh, { calls });
}

let dir: string;
let stdout: string[];
let stderr: string[];
let clock: number;
let alive: Set<number>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pr-wait-'));
  stdout = [];
  stderr = [];
  clock = 1_700_000_000_000;
  alive = new Set([4242]);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function env(gh: PrWaitEnv['gh'], pid = 4242, vars: Record<string, string> = {}): PrWaitEnv {
  return {
    gh, vars: { HOME: dir, GSTACK_STATE_ROOT: join(dir, 'state'), ...vars }, pid,
    now: () => clock, sleep: () => {}, out: t => stdout.push(t), err: t => stderr.push(t), pidAlive: p => alive.has(p),
  };
}
const watcher = (script: Script, until: PrWaitOptions['until'] = 'ready', vars: Record<string, string> = {}) => {
  const e = env(fakeGh(script), 4242, vars);
  return new Watcher(e, REPO, 42, until, 20, botLists(e.vars));
};
/** Run polls until one returns a code or the budget is spent; the first poll is the baseline. */
function pollUntilDone(w: Watcher, budget = 6): number | null {
  for (let i = 0; i < budget; i++) {
    const code = w.poll();
    if (code !== null) return code;
    w.save();
    w.baseline = false;
  }
  return null;
}
const lines = () => stdout.join('').split('\n').filter(Boolean);
const RULESETS = ok('free-tests\nwindows-free-tests\n');

describe('state lives under the gstack state root', () => {
  test('state file and lock are <root>/pr-wait/<owner>__<name>__<pr>, never ~/.local/state', () => {
    const w = watcher({});
    expect(w.stateFile).toBe(join(dir, 'state', 'pr-wait', 'owner__project__42.json'));
    expect(w.lockFile).toBe(join(dir, 'state', 'pr-wait', 'owner__project__42.lock'));
    expect(stateDir({ HOME: dir })).toBe(join(dir, '.gstack', 'pr-wait'));
    pollUntilDone(w, 1);
    expect(existsSync(w.stateFile)).toBe(true);
    expect(existsSync(join(dir, '.local'))).toBe(false);
  });

  test('a state file older than six hours is a fresh baseline: nothing from it is replayed and nothing new is reported on that poll', () => {
    const file = join(dir, 'state', 'pr-wait', 'owner__project__42.json');
    mkdirSync(join(dir, 'state', 'pr-wait'), { recursive: true });
    writeFileSync(file, JSON.stringify({ reported: [], summaries: {}, base_oid: BASE_A, merge_state: 'CLEAN' }));
    const old = new Date(clock - 7 * 3600 * 1000);
    utimesSync(file, old, old);
    const w = watcher({ pr: prJson({ comments: [comment('c1', { login: 'reviewer' }, 'looks wrong')] }) });
    expect(w.baseline).toBe(true);
    expect(w.poll()).toBeNull();
    expect(lines()).toEqual([]);
    const fresh = watcher({ pr: prJson({ comments: [comment('c1', { login: 'reviewer' }, 'looks wrong')] }) });
    expect(fresh.baseline).toBe(true);
  });

  test('a state file within six hours carries the baseline across a restart, so only what arrived meanwhile prints', () => {
    const first = watcher({ pr: prJson({ comments: [comment('c1', { login: 'reviewer' }, 'first')] }) });
    pollUntilDone(first, 1);
    expect(lines()).toEqual([]);
    clock += 60 * 60 * 1000;
    const restarted = watcher({ pr: prJson({ comments: [comment('c1', { login: 'reviewer' }, 'first'), comment('c2', { login: 'reviewer' }, 'second thought')] }) });
    expect(restarted.baseline).toBe(false);
    restarted.poll();
    expect(lines()).toEqual([expect.stringMatching(/^#42 comment from reviewer: second thought https:/)]);
  });
});

describe('events: one stdout line each, progress on stderr', () => {
  test('the baseline poll records what exists and prints nothing; the next poll prints only new comments, reviews and thread replies, never the author, the gh user, or edits', () => {
    const before = prJson({ comments: [comment('c1', { login: 'reviewer' }, 'old')] });
    const after = prJson({
      comments: [comment('c1', { login: 'reviewer' }, 'old, edited'), comment('c2', { login: 'author' }, 'mine'), comment('c3', { login: 'me' }, 'also mine'),
        comment('c4', { login: 'github-actions', bot: true }, 'deploy preview ready'), comment('c5', { login: 'reviewer' }, '<b>Please</b> &amp; fix &lt;this&gt;')],
      reviews: [review('r1', { login: 'reviewer' }, 'CHANGES_REQUESTED', 'nope'), review('r2', { login: 'lurker' }, 'COMMENTED', '')],
      threads: [thread('lib/x.ts', 12, false, comment('t1', { login: 'reviewer' }, 'rename this'), comment('t2', { login: 'author' }, 'done'))],
    });
    const w = watcher({ pr: [before, after] }, 'any-change');
    expect(w.run()).toBe(PR_WAIT_EXIT.met);
    expect(lines()).toEqual([
      '#42 comment from reviewer: Please & fix <this> https://github.com/owner/project/pull/42#issuecomment-c5',
      '#42 review from reviewer (changes requested): nope https://github.com/owner/project/pull/42#pullrequestreview-r1',
      '#42 new thread from reviewer on lib/x.ts:12: rename this https://github.com/owner/project/pull/42#issuecomment-t1',
    ]);
    expect(stderr.join('')).toContain('watching owner/project#42 until any-change; required checks: none set, so every CI check gates');
    expect(stderr.join('')).toContain('baseline recorded for owner/project#42');
  });

  test('merged ends with exit 0; closed without merging is PR_WAIT_BLOCKED', () => {
    expect(pollUntilDone(watcher({ pr: prJson({ state: 'MERGED' }) }))).toBe(0);
    expect(lines()).toEqual(['#42 merged: https://github.com/owner/project/pull/42']);
    stdout = [];
    expect(pollUntilDone(watcher({ pr: prJson({ state: 'CLOSED' }) }))).toBe(1);
    expect(lines()).toEqual(['#42 closed without merging: https://github.com/owner/project/pull/42', expect.stringContaining('stopped: action needed (PR_WAIT_BLOCKED; https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md#pr-wait-blocked)')]);
  });
});

describe('required checks and the green condition', () => {
  test('a required check named by the ruleset that has not started is pending, not green by omission', () => {
    const w = watcher({ rulesets: RULESETS, checks: ok(checksJson(['free-tests', 'pass'])) }, 'green');
    expect(pollUntilDone(w, 4)).toBeNull();
    expect(lines()).toEqual([]);
    expect(stderr.join('')).toContain('required checks: free-tests, windows-free-tests');
  });

  test('a required check that failed ends the watch at once, naming it with its link, even on the baseline poll', () => {
    const w = watcher({ rulesets: RULESETS, checks: ok(checksJson(['free-tests', 'fail'], ['windows-free-tests', 'pending'])) }, 'green');
    expect(w.poll()).toBe(PR_WAIT_EXIT.blocked);
    expect(lines()).toEqual(['#42 required check failed: free-tests https://ci.example/free-tests', expect.stringContaining('(PR_WAIT_BLOCKED;')]);
  });

  test('an unknown bucket counts as failed, as gstack-ci-gate counts it', () => {
    const w = watcher({ rulesets: RULESETS, checks: ok(checksJson(['free-tests', 'stale'], ['windows-free-tests', 'pass'])) }, 'green');
    expect(w.poll()).toBe(PR_WAIT_EXIT.blocked);
    expect(lines()[0]).toBe('#42 required check failed: free-tests https://ci.example/free-tests');
  });

  test('green needs two identical polls: a check set seen once is not stable', () => {
    const w = watcher({ rulesets: RULESETS, checks: [ok(checksJson(['free-tests', 'pass'], ['windows-free-tests', 'pass'])), ok(checksJson(['free-tests', 'pass'], ['windows-free-tests', 'pass'], ['late-check', 'pass']))], behind: ok('2\n') }, 'green');
    expect(w.poll()).toBeNull();
    w.baseline = false;
    expect(w.poll()).toBeNull();
    expect(w.poll()).toBe(PR_WAIT_EXIT.met);
    expect(lines()).toEqual(['#42 green on aaaaaaa: 3 pass; required 2/2 green; no greptile or macroscope yet; 0 unresolved threads; merge state CLEAN; 2 commits behind main']);
  });

  test('with no required checks every CI check gates except the review bots\' own, and a gating bot\'s review on the head makes it ready', () => {
    const pr = prJson({ reviews: [review('g1', { login: 'greptile-apps', bot: true }, 'COMMENTED', 'Confidence score: 4/5')] });
    const w = watcher({ pr, checks: ok(checksJson(['build', 'pass'], ['greptile-review', 'pass'], ['coderabbit', 'pending', 'Review in progress'])) });
    expect(pollUntilDone(w)).toBe(PR_WAIT_EXIT.met);
    expect(lines()).toEqual(['#42 ready on aaaaaaa: 2 pass; greptile done, coderabbit Review in progress (advisory); 0 unresolved threads; merge state CLEAN; 0 commits behind main']);
  });

  test('ready is blocked by unresolved threads and by BEHIND, in that order', () => {
    const base = { checks: ok(checksJson(['build', 'pass'])), rulesets: NOT_FOUND };
    const reviewed = review('g1', { login: 'greptile-apps', bot: true }, 'COMMENTED', '');
    expect(pollUntilDone(watcher({ ...base, pr: prJson({ reviews: [reviewed], threads: [thread('a.ts', 1, false, comment('t1', { login: 'reviewer' }, 'hm'))] }) }))).toBe(1);
    expect(lines()[0]).toBe('#42 blocked by 1 unresolved threads on aaaaaaa: https://github.com/owner/project/pull/42#issuecomment-t1');
    stdout = [];
    expect(pollUntilDone(watcher({ ...base, pr: prJson({ reviews: [reviewed], mergeState: 'BEHIND' }) }))).toBe(1);
    expect(lines()).toContain('#42 merge state is BEHIND: update the branch from main before merging');
  });
});

describe('base branch and merge state', () => {
  const compareKey = `${BASE_A}...${BASE_B}`;

  test('the base moved and its new commits touch files in this PR → one event naming the overlap', () => {
    const w = watcher({
      pr: [prJson({ baseOid: BASE_A }), prJson({ baseOid: BASE_B })],
      prFiles: ok('lib/pr-wait.ts\nREADME.md\n'),
      compare: { [compareKey]: ok('lib/pr-wait.ts\nCHANGELOG.md\n') },
    }, 'any-change');
    expect(pollUntilDone(w)).toBe(PR_WAIT_EXIT.met);
    expect(lines()).toEqual(['#42 main moved to ccccccc and touches files in this PR: lib/pr-wait.ts']);
  });

  test('the base moved without touching this PR → silence, and the new base oid is remembered', () => {
    const w = watcher({
      pr: [prJson({ baseOid: BASE_A }), prJson({ baseOid: BASE_B })],
      prFiles: ok('lib/pr-wait.ts\n'),
      compare: { [compareKey]: ok('CHANGELOG.md\n') },
    }, 'any-change');
    expect(pollUntilDone(w, 3)).toBeNull();
    expect(lines()).toEqual([]);
    expect(JSON.parse(readFileSync(w.stateFile, 'utf8')).base_oid).toBe(BASE_B);
  });

  test('a restarted watcher reports a base move that happened while no watcher ran', () => {
    const first = watcher({ pr: prJson({ baseOid: BASE_A }) });
    first.poll();
    first.save();
    const restarted = watcher({ pr: prJson({ baseOid: BASE_B }), prFiles: ok('x\n'), compare: { [compareKey]: ok('x\n') } }, 'any-change');
    expect(restarted.baseline).toBe(false);
    expect(restarted.poll()).toBe(PR_WAIT_EXIT.met);
    expect(lines()).toEqual(['#42 main moved to ccccccc and touches files in this PR: x']);
  });

  test('BEHIND is an event once per head; DIRTY ends the watch as blocked', () => {
    const behind = watcher({ pr: [prJson({ mergeState: 'CLEAN' }), prJson({ mergeState: 'BEHIND' })], checks: ok(checksJson(['build', 'pending'])) }, 'green');
    expect(pollUntilDone(behind, 4)).toBeNull();
    expect(lines()).toEqual(['#42 merge state is BEHIND: update the branch from main before merging']);
    stdout = [];
    const dirty = watcher({ pr: prJson({ mergeState: 'DIRTY' }) }, 'green');
    expect(dirty.poll()).toBe(PR_WAIT_EXIT.blocked);
    expect(lines()[0]).toBe('#42 merge state is DIRTY: the branch conflicts with main, rebase it');
  });
});

describe('review bots are configuration', () => {
  const withConfig = (yaml: string) => {
    mkdirSync(join(dir, 'state'), { recursive: true });
    writeFileSync(join(dir, 'state', 'config.yaml'), yaml);
  };

  test('defaults are tstack\'s: greptile and macroscope gate, coderabbit is advisory', () => {
    expect(botLists({ HOME: dir, GSTACK_STATE_ROOT: join(dir, 'state') })).toEqual({ gating: ['greptile', 'macroscope'], advisory: ['coderabbit'] });
  });

  test('pr_wait_gating_bots decides which bot\'s review makes the PR ready', () => {
    withConfig('pr_wait_gating_bots: macroscope\n');
    const pr = prJson({ reviews: [review('g1', { login: 'greptile-apps', bot: true }, 'COMMENTED', '')] });
    const w = watcher({ pr, checks: [ok(checksJson(['build', 'pending'])), ok(checksJson(['build', 'pass']))] });
    expect(w.bots).toEqual({ gating: ['macroscope'], advisory: ['coderabbit'] });
    expect(pollUntilDone(w, 4)).toBeNull();
    expect(lines()).toEqual([expect.stringMatching(/^#42 checks finished on aaaaaaa: 1 pass; no macroscope yet; 0 unresolved threads; merge state CLEAN$/)]);
  });

  test('none empties a list', () => {
    withConfig('pr_wait_advisory_bots: none\n');
    expect(botLists({ HOME: dir, GSTACK_STATE_ROOT: join(dir, 'state') })).toEqual({ gating: ['greptile', 'macroscope'], advisory: [] });
  });

  test('pr_wait_advisory_bots is reported but never waited on', () => {
    withConfig('pr_wait_gating_bots: greptile\npr_wait_advisory_bots: coderabbit, Sourcery\n');
    const pr = prJson({ reviews: [review('g1', { login: 'greptile-apps', bot: true }, 'COMMENTED', '')] });
    const w = watcher({ pr, checks: ok(checksJson(['build', 'pass'], ['sourcery-ai', 'pending', 'Reviewing'])) });
    expect(w.bots.advisory).toEqual(['coderabbit', 'sourcery']);
    expect(pollUntilDone(w)).toBe(PR_WAIT_EXIT.met);
    expect(lines()[0]).toContain('ready on aaaaaaa: 1 pass; greptile done, sourcery Reviewing (advisory)');
  });
});

describe('the per-PR lock', () => {
  test('a live holder refuses the second watcher with PR_WAIT_REFUSED; a dead holder is taken over and released on exit', () => {
    const first = watcher({});
    expect(first.lock()).toBeNull();
    const second = new Watcher(env(fakeGh({}), 4343), REPO, 42, 'ready', 20, botLists({}));
    expect(second.lock()).toEqual({ held: '4242' });
    alive.clear();
    expect(second.lock()).toBeNull();
    expect(readFileSync(second.lockFile, 'utf8')).toBe('4343');
    first.unlock();
    expect(existsSync(second.lockFile)).toBe(true);
    second.unlock();
    expect(existsSync(second.lockFile)).toBe(false);
  });

  test('prWaitMain refuses a duplicate watcher before any poll', () => {
    const w = watcher({});
    expect(w.lock()).toBeNull();
    const gh = fakeGh({});
    const code = prWaitMain(['42', '--repo', REPO], env(gh, 9999));
    expect(code).toBe(PR_WAIT_EXIT.refused);
    expect(lines()).toEqual([expect.stringMatching(/^gstack-pr-wait: the watcher did not start — pid 4242 already watches owner\/project#42.*\(PR_WAIT_REFUSED; https:\/\/github\.com\/garrytan\/gstack\/blob\/main\/docs\/troubleshooting\.md#pr-wait-refused\)$/)]);
    expect(gh.calls.some(c => c[1] === 'graphql')).toBe(false);
  });
});

describe('arguments and the gh layer', () => {
  test('targets: number, #number, URL (repo from the URL), --repo override; bad input is refused', () => {
    expect(parsePrTarget('42')).toEqual({ repo: undefined, pr: 42 });
    expect(parsePrTarget('#42', REPO)).toEqual({ repo: REPO, pr: 42 });
    expect(parsePrTarget('https://github.com/garrytan/gstack/pull/3481/files')).toEqual({ repo: 'garrytan/gstack', pr: 3481 });
    expect(parsePrTarget('')).toMatchObject({ error: expect.stringContaining('missing PR number') });
    expect(parsePrTarget('abc')).toMatchObject({ error: "'abc' is not a PR number or PR URL" });
    expect(parsePrTarget('0')).toMatchObject({ error: "'0' is not a valid PR number" });
    expect(parsePrTarget('42', 'nope')).toMatchObject({ error: "'nope' is not owner/name" });
    expect(parsePrWaitArgs(['42', '--until', 'green', '--interval', '2'])).toEqual({ target: '42', until: 'green', interval: 5 });
    expect(parsePrWaitArgs(['--until', 'soon'])).toMatchObject({ error: expect.stringContaining('--until needs') });
    expect(parsePrWaitArgs(['--bogus'])).toMatchObject({ error: 'unknown argument --bogus' });
    expect(parsePrWaitArgs(['--help'])).toEqual({ help: true });
  });

  test('main: --help exits 0, bad input exits 2 with the code and anchor, an unreadable PR exits 2', () => {
    expect(prWaitMain(['--help'], env(fakeGh({})))).toBe(0);
    expect(stdout.join('')).toContain('--until');
    stdout = [];
    expect(prWaitMain([], env(fakeGh({})))).toBe(2);
    expect(lines()[0]).toMatch(/missing PR number.*\(PR_WAIT_REFUSED; .*#pr-wait-refused\)$/);
    stdout = [];
    const gone = (args: string[]): GhResult => (args[1] === 'view' ? err('GraphQL: Could not resolve to a PullRequest with the number of 42. (HTTP 404)') : ok(''));
    expect(prWaitMain(['42', '--repo', REPO], env(gone))).toBe(2);
    expect(lines()[0]).toContain('cannot read owner/project#42: GraphQL: Could not resolve');
    expect(RESULT_CODES.PR_WAIT_REFUSED.anchor).toBe('pr-wait-refused');
    expect(RESULT_CODES.PR_WAIT_BLOCKED.anchor).toBe('pr-wait-blocked');
  });

  test('a transient gh failure is retried with backoff and never ends the watch; a 403 on classic protection is logged, not fatal', () => {
    let graphqlCalls = 0;
    const base = fakeGh({ checks: ok(checksJson(['build', 'pass'])), protection: err('gh: Resource not accessible by integration (HTTP 403)') });
    const flaky = (args: string[]): GhResult => {
      if (args[1] === 'graphql' && graphqlCalls++ === 0) return err('gh: Something went wrong (HTTP 502)');
      return base(args);
    };
    const e = env(flaky);
    const w = new Watcher(e, REPO, 42, 'green', 20, botLists(e.vars));
    expect(w.poll()).toBeNull();
    expect(graphqlCalls).toBe(2);
    expect(stderr.join('')).toContain('gh api graphql: gh: Something went wrong (HTTP 502); retry in 2s');
    expect(stderr.join('')).toContain('could not read required checks from repos/owner/project/branches/main/protection/required_status_checks: gh: Resource not accessible by integration (HTTP 403)');
  });

  test('the bin runs on the isolated bun shebang and prints the usage', () => {
    const result = spawnSync(join(ROOT, 'bin', 'gstack-pr-wait'), ['--help'], { encoding: 'utf8', cwd: ROOT, timeout: 30_000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('gstack-config set pr_wait_gating_bots greptile,macroscope');
    expect(readFileSync(join(ROOT, 'bin', 'gstack-pr-wait'), 'utf8').startsWith('#!/usr/bin/env -S bun --no-env-file --config=/dev/null\n')).toBe(true);
  });
});
