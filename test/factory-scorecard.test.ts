/**
 * factory-scorecard (free): the window's merged PRs, lead times, gate runs with
 * known cost, red-train rate, flaky events, issues and releases, computed from
 * recorded gh responses (test/fixtures/factory-scorecard/recorded.json); an
 * unreadable input marks its lines unavailable and the rest still print; the
 * bin writes the table, the CSV and the JSON without touching the network.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BENCHMARKS, DEFAULTS, classifyGate, collectScorecard, fixtureSource, flakeRecords, gateOutcome, percentile, readComments, renderCsv,
  renderMarkdown, scorecardRows, verdictCost, type FixtureFile, type ScorecardOptions,
} from '../lib/factory-scorecard';

const ROOT = path.resolve(import.meta.dir, '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'factory-scorecard', 'recorded.json');
const BIN = path.join(ROOT, 'bin', 'gstack-factory-scorecard');
const NOW = Date.parse('2026-10-26T12:00:00Z');

const tmp: string[] = [];
afterEach(() => { for (const dir of tmp.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const scratch = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-scorecard-test-')); tmp.push(dir); return dir; };

const fixture = (): FixtureFile => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const options = (over: Partial<ScorecardOptions> = {}): ScorecardOptions => ({
  repo: 'acme/widgets', base: DEFAULTS.base, now: NOW, sinceDays: DEFAULTS.sinceDays, crew: null, gateWorkflow: DEFAULTS.gateWorkflow,
  gateEvent: DEFAULTS.gateEvent, freeWorkflow: DEFAULTS.freeWorkflow, trainPrefix: DEFAULTS.trainPrefix,
  readyMarker: new RegExp(DEFAULTS.readyMarker, 'm'), maxArtifactRuns: DEFAULTS.maxArtifactRuns, ...over,
});
const byId = (rows: ReturnType<typeof scorecardRows>) => Object.fromEntries(rows.map(r => [r.id, r.value]));

describe('factory-scorecard: recorded window', () => {
  test('merged PRs, lead times, gates, cost, trains, flakes, issues and releases from the recorded responses', () => {
    const source = fixtureSource(fixture(), scratch());
    const card = collectScorecard(source, options());
    expect(card.unavailable).toEqual([]);
    expect(card.prs.map(p => p.number)).toEqual([101, 103, 102]);
    expect(card.prs.map(p => p.crew)).toEqual([true, true, false]);
    expect(card.prs.find(p => p.number === 101)!.readyAt).toBe('2026-10-24T16:00:00Z');
    expect(card.prs.find(p => p.number === 101)!.commentCostUsd).toBe(12.5);
    expect(card.prs.find(p => p.number === 102)!.readyAt).toBeNull();
    expect(card.gates.map(g => [g.id, g.kind, g.outcome, g.costUsd, g.costSource, g.flakes])).toEqual([
      [9004, 'backstop', 'cancelled', null, null, 0],
      [9003, 'screen', 'green', 12.5, 'comment', 0],
      [9002, 'train', 'red', null, null, 0],
      [9001, 'train', 'green', 30.5, 'artifact', 2],
    ]);
    expect(card.gates.find(g => g.id === 9001)!.flakeRerunUsd).toBe(1.1);
    expect(card.freeRuns.map(r => [r.id, r.retries])).toEqual([[8003, 0], [8002, 0], [8001, 2]]);
    expect([card.issuesOpened, card.issuesClosed]).toEqual([5, 7]);
    expect(card.releases).toEqual([{ tag: 'v1.0.0', publishedAt: '2026-10-23T07:00:00Z' }]);

    const values = byId(scorecardRows(card));
    expect(values.merged).toBe('3 (crew 2, outside 1)');
    expect(values.lead_time).toBe('median 8.0h, p90 5.0d');
    expect(values.ready_to_merge).toBe('median 1.0h, p90 2.0h (2 of 3 PRs with a READY comment)');
    expect(values.gates).toBe('2 / 1 / 1; known cost $43.00 on 2 of 4 runs');
    expect(values.cost_per_merge).toBe('$14.33 (2 runs without a known cost)');
    expect(values.red_train).toBe('50% (1 red of 2 trains; 0 red backstop, 0 red screens)');
    expect(values.flaky).toBe('2 paid case(s) passed on their one rerun (rerun spend $1.10); 2 free-suite retries in 1 of 3 runs');
    expect(values.issues).toBe('5 / 7');
    expect(values.releases).toBe('1 (v1.0.0)');
  });

  test('a crew login list overrides the author_association rule', () => {
    const card = collectScorecard(fixtureSource(fixture(), scratch()), options({ crew: ['Alice'] }));
    expect(byId(scorecardRows(card)).merged).toBe('3 (crew 1, outside 2)');
  });

  test('a run older than the window, a non-dispatch event and a draft release are left out; the page stops once older than the window', () => {
    const source = fixtureSource(fixture(), scratch());
    const card = collectScorecard(source, options());
    expect(card.gates.map(g => g.id)).not.toContain(9000);
    expect(card.gates.map(g => g.id)).not.toContain(9005);
    expect(card.releases.map(r => r.tag)).not.toContain('v1.1.0');
    expect(source.calls.filter(c => c.includes('/pulls?'))).toHaveLength(1);
  });

  test('--max-artifact-runs caps artifact reads: later runs count without cost or flake data', () => {
    const card = collectScorecard(fixtureSource(fixture(), scratch()), options({ maxArtifactRuns: 2 }));
    expect(card.artifactRunsRead).toBe(2);
    expect(card.gates.find(g => g.id === 9001)!.costUsd).toBeNull();
    expect(card.gates.find(g => g.id === 9001)!.flakes).toBe(0);
    expect(byId(scorecardRows(card)).gates).toBe('2 / 1 / 1; known cost $12.50 on 1 of 4 runs');
  });

  test('an unreadable input marks only its lines unavailable, with the reason, and the rest still print', () => {
    const fx = fixture();
    for (const key of Object.keys(fx.responses)) if (key.startsWith('search/issues')) delete fx.responses[key];
    const card = collectScorecard(fixtureSource(fx, scratch()), options());
    expect(card.unavailable).toHaveLength(1);
    expect(card.unavailable[0]).toStartWith('issues: ');
    const values = byId(scorecardRows(card));
    expect(values.issues).toStartWith('unavailable (');
    expect(values.merged).toBe('3 (crew 2, outside 1)');
    expect(renderMarkdown(card, scorecardRows(card))).toContain('Unavailable inputs: issues: ');
  });

  test('markdown and CSV carry every row with its benchmark and counting rule', () => {
    const card = collectScorecard(fixtureSource(fixture(), scratch()), options());
    const rows = scorecardRows(card);
    expect(rows.map(r => r.id)).toEqual(Object.keys(BENCHMARKS));
    const md = renderMarkdown(card, rows);
    expect(md).toStartWith('## Factory scorecard: acme/widgets (2026-10-19 to 2026-10-26, 7 days)');
    expect(md).toContain('| Metric | This window | One of the best factories would show | Counting rule |');
    expect(md).toContain('| Red-train rate | 50% (1 red of 2 trains; 0 red backstop, 0 red screens) | under 5% of trains red');
    const csv = renderCsv(card, rows).split('\n');
    expect(csv[0]).toBe('repo,window_start,window_end,metric_id,metric,value,benchmark,rule');
    expect(csv).toHaveLength(rows.length + 2);
    expect(csv[1]).toStartWith('"acme/widgets","2026-10-19T12:00:00.000Z","2026-10-26T12:00:00.000Z","merged","Merged PRs","3 (crew 2, outside 1)"');
  });
});

describe('factory-scorecard: pieces', () => {
  test('gate kind by train prefix, backstop and screen titles; outcome by conclusion', () => {
    expect(classifyGate({ branch: 'train/gate.train-x', title: 'E2E Evals [eval-bg gate.train-x]' }, 'train/')).toBe('train');
    expect(classifyGate({ branch: 'main', title: 'E2E Evals [eval-bg gate.backstop-abc]' }, 'train/')).toBe('backstop');
    expect(classifyGate({ branch: 'main', title: 'E2E Evals [eval-bg pr.screen.narrow-x] screen #12' }, 'train/')).toBe('screen');
    expect(classifyGate({ branch: 'feature/x', title: 'E2E Evals [eval-bg pr.gate-x]' }, 'train/')).toBe('other');
    expect(classifyGate({ branch: 'queue/gate-1', title: 'gate' }, 'queue/')).toBe('train');
    expect(['success', 'failure', 'timed_out', 'cancelled', 'skipped', null].map(gateOutcome)).toEqual(['green', 'red', 'red', 'cancelled', 'cancelled', 'red']);
  });

  test('READY marker: the first matching comment wins and the newest cost line is kept', () => {
    const source = fixtureSource(fixture(), scratch());
    expect(readComments(source, 'acme/widgets', 101, /READY #\d+/m)).toEqual({ readyAt: '2026-10-24T16:00:00Z', costUsd: 12.5 });
    expect(readComments(source, 'acme/widgets', 101, /never matches/m)).toEqual({ readyAt: null, costUsd: 12.5 });
    expect(readComments(source, 'acme/widgets', 103, new RegExp(DEFAULTS.readyMarker, 'm'))).toEqual({ readyAt: '2026-10-25T03:00:00Z', costUsd: null });
  });

  test('verdict cost reads collector-outcomes.json and ignores an unreadable one; flake records skip torn lines and unknown rerun cost', () => {
    const dir = scratch();
    fs.mkdirSync(path.join(dir, 'a', 'paid-report'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a', 'paid-report', 'collector-outcomes.json'), '{not json');
    expect(verdictCost([path.join(dir, 'a')])).toBeNull();
    fs.writeFileSync(path.join(dir, 'a', 'paid-report', 'collector-outcomes.json'), JSON.stringify({ verdict: { costUsd: 23.814 } }));
    expect(verdictCost([path.join(dir, 'a')])).toBe(23.81);
    fs.writeFileSync(path.join(dir, 'a', 'flake-records.jsonl'), [
      JSON.stringify({ kind: 'gate-flake', case: 'x', rerun_cost_usd: 0.5 }), 'torn {', JSON.stringify({ kind: 'gate-flake', case: 'y', rerun_cost_usd: null }),
      JSON.stringify({ kind: 'other', case: 'z', rerun_cost_usd: 9 }), ''].join('\n'));
    expect(flakeRecords([path.join(dir, 'a')])).toEqual({ flakes: 2, rerunUsd: 0.5 });
    expect(flakeRecords([path.join(dir, 'missing')])).toEqual({ flakes: 0, rerunUsd: 0 });
  });

  test('percentile is nearest-rank: p50 and p90 of small samples, null when empty', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([4, 8, 120], 0.5)).toBe(8);
    expect(percentile([4, 8, 120], 0.9)).toBe(120);
    expect(percentile([2, 1], 0.5)).toBe(1);
  });
});

describe('factory-scorecard: the bin', () => {
  const run = (args: string[], cwd: string) => spawnSync(BIN, args, { cwd, encoding: 'utf8', timeout: 60_000, env: { ...process.env, HOME: cwd } });

  test('--fixtures replays the recorded window and writes the table, the CSV and the JSON', () => {
    const cwd = scratch();
    const r = run(['--repo', 'acme/widgets', '--fixtures', FIXTURE, '--now', '2026-10-26T12:00:00Z', '--json'], cwd);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('| Merged PRs | 3 (crew 2, outside 1) |');
    expect(r.stdout).toContain('| Known gate cost per merged PR | $14.33 (2 runs without a known cost) |');
    expect(r.stdout).toContain(`SCORECARD_CSV: ${path.join('.context', 'factory-scorecard', 'scorecard.csv')}`);
    const csv = fs.readFileSync(path.join(cwd, '.context', 'factory-scorecard', 'scorecard.csv'), 'utf8');
    expect(csv.split('\n')[0]).toBe('repo,window_start,window_end,metric_id,metric,value,benchmark,rule');
    expect(csv).toContain('"red_train","Red-train rate","50% (1 red of 2 trains; 0 red backstop, 0 red screens)"');
    expect(fs.existsSync(path.join(cwd, '.context', 'factory-scorecard', 'scorecard.md'))).toBe(true);
    const json = JSON.parse(fs.readFileSync(path.join(cwd, '.context', 'factory-scorecard', 'scorecard.json'), 'utf8'));
    expect(json.card.prs).toHaveLength(3);
    expect(json.rows).toHaveLength(Object.keys(BENCHMARKS).length);
  });

  test('--crew, --out-dir, --csv and a custom --ready-marker are honoured', () => {
    const cwd = scratch();
    const out = path.join(cwd, 'out');
    const r = run(['--repo', 'acme/widgets', '--fixtures', FIXTURE, '--now', '2026-10-26T12:00:00Z', '--crew', 'alice,bo', '--out-dir', out,
      '--csv', path.join(cwd, 'card.csv'), '--ready-marker', 'ship receipt follows'], cwd);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('| Merged PRs | 3 (crew 2, outside 1) |');
    expect(r.stdout).toContain('(1 of 3 PRs with a READY comment)');
    expect(fs.existsSync(path.join(cwd, 'card.csv'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'scorecard.md'))).toBe(true);
  });

  test('bad usage exits 2 with the usage text; --help exits 0', () => {
    const cwd = scratch();
    expect(run(['--since-days', 'soon'], cwd).status).toBe(2);
    expect(run(['--ready-marker', '(', '--fixtures', FIXTURE], cwd).status).toBe(2);
    const stray = run(['stray'], cwd);
    expect(stray.status).toBe(2);
    expect(stray.stderr).toContain('unexpected argument: stray');
    const help = run(['--help'], cwd);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('gstack-factory-scorecard');
  });

  test('the retro template runs the bin from the runtime root and reads its table', () => {
    const tmpl = fs.readFileSync(path.join(ROOT, 'retro', 'SKILL.md.tmpl'), 'utf8');
    expect(tmpl).toContain('"{{RUNTIME_ROOT}}/bin/gstack-factory-scorecard"');
    expect(tmpl).toContain('### Step 7.5: Factory scorecard');
    expect(fs.readFileSync(path.join(ROOT, 'retro', 'SKILL.md'), 'utf8')).toContain('$HOME/.claude/skills/gstack/bin/gstack-factory-scorecard');
  });
});
