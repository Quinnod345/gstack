/**
 * factory-scorecard — one window of a repository's shipping numbers, read from
 * GitHub through `gh` (bin/gstack-factory-scorecard; /retro Step 7.5;
 * docs/recommended-harness.md#the-factory-scorecard). Every line prints its
 * counting rule next to the number, and a line whose input cannot be read says
 * so ("unavailable: <reason>") instead of printing 0.
 *
 * Inputs, all REST reads (no write, no paid work):
 *   merged PRs           pulls?state=closed&base=<base>, merged_at inside the window;
 *                        crew = --crew logins, else author_association OWNER/MEMBER/COLLABORATOR
 *   lead time            PR created_at -> merged_at (median, p90); ready -> merged when
 *                        a PR comment matches --ready-marker (first such comment)
 *   gate runs            <gate workflow> runs in the window (workflow_dispatch by default),
 *                        kind by head branch (train/<nonce>) and run title (screen #, backstop);
 *                        cost from the run's report-verdict artifact (collector-outcomes.json
 *                        .verdict.costUsd), else the "**$N** rule/judge cost" / "cost=$N" line of
 *                        the PR's verdict comment, else unknown
 *   flaky events         flake-records-a<n> artifacts of gate runs (paid, one record per case
 *                        that failed once and passed its one rerun) and flake-ledger-* artifacts
 *                        of <free workflow> runs on <base> (free-suite serial retries); the same
 *                        two sources the daily flaky pass reads
 *   issues               search/issues created / closed inside the window
 *   releases             releases published inside the window (drafts excluded)
 *
 * Reads are injectable (ScorecardSource) so the tests replay recorded gh
 * responses from a fixture file and never touch the network.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  GH_CLIENT, downloadRunArtifacts, filesUnder, historyFetcher, listWorkflowRuns, readFlakeLedgerDir, unavailableReason,
  type GhClient,
} from '../scripts/lib/ci-history';

export interface ScorecardSource {
  getJson(apiPath: string): unknown;
  /** Downloaded, unzipped artifact directories of one run whose names match. */
  artifactDirs(runId: number, match: (name: string) => boolean): string[];
}

export interface ScorecardOptions {
  repo: string;
  base: string;
  now: number;
  sinceDays: number;
  /** Crew logins; null means the author_association rule. */
  crew: string[] | null;
  gateWorkflow: string;
  gateEvent: string | null;
  freeWorkflow: string;
  trainPrefix: string;
  readyMarker: RegExp;
  /** Newest runs whose artifacts are read; the rest count without cost or flake data. */
  maxArtifactRuns: number;
}

export const DEFAULTS = {
  base: 'main', sinceDays: 7, gateWorkflow: 'evals.yml', gateEvent: 'workflow_dispatch', freeWorkflow: 'free-tests.yml',
  trainPrefix: 'train/', readyMarker: 'READY #\\d+|SHIP_RECEIPT:|gstack-ship-receipt', maxArtifactRuns: 60,
} as const;

export const CREW_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const PAGE = 100;
const COST_LINE = /\*\*\$(\d+(?:\.\d+)?)\*\* rule\/judge cost|\bcost=\$(\d+(?:\.\d+)?)/g;

export interface MergedPr {
  number: number; author: string; association: string; crew: boolean; title: string;
  createdAt: string; mergedAt: string; readyAt: string | null; commentCostUsd: number | null;
}
export type GateKind = 'train' | 'screen' | 'backstop' | 'other';
export type GateOutcome = 'green' | 'red' | 'cancelled';
export interface GateRun {
  id: number; kind: GateKind; outcome: GateOutcome; createdAt: string; branch: string; title: string; pr: number | null;
  costUsd: number | null; costSource: 'artifact' | 'comment' | null; flakes: number; flakeRerunUsd: number;
}
export interface FreeRetryRun { id: number; conclusion: string | null; retries: number }
export interface Scorecard {
  repo: string; base: string; windowStart: string; windowEnd: string;
  prs: MergedPr[]; gates: GateRun[]; freeRuns: FreeRetryRun[]; artifactRunsRead: number;
  issuesOpened: number | null; issuesClosed: number | null; releases: Array<{ tag: string; publishedAt: string }>;
  unavailable: string[];
}
export interface ScorecardRow { id: string; metric: string; value: string; benchmark: string; rule: string }

// --- Sources ---

export function ghSource(repo: string, cacheDir: string, client: GhClient = GH_CLIENT): ScorecardSource {
  const fetcher = historyFetcher(client);
  return {
    getJson: apiPath => client.getJson(apiPath),
    artifactDirs: (runId, match) => downloadRunArtifacts({ repo, run: { id: runId }, match, cacheDir, fetcher }),
  };
}

/** Recorded gh responses: { responses: { "<api path>": <json> }, artifacts: { "<run id>": { "<artifact name>": { "<file>": "<text>" } } } }. */
export interface FixtureFile { responses: Record<string, unknown>; artifacts?: Record<string, Record<string, Record<string, string>>> }

export function fixtureSource(fixture: FixtureFile, scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-scorecard-'))): ScorecardSource & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getJson: apiPath => {
      calls.push(apiPath);
      if (!(apiPath in fixture.responses)) throw new Error(`no recorded response for ${apiPath}`);
      return fixture.responses[apiPath];
    },
    artifactDirs: (runId, match) => {
      const dirs: string[] = [];
      for (const [name, files] of Object.entries(fixture.artifacts?.[String(runId)] ?? {})) {
        if (!match(name)) continue;
        const dir = path.join(scratch, String(runId), name);
        for (const [file, text] of Object.entries(files)) {
          fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
          fs.writeFileSync(path.join(dir, file), text);
        }
        dirs.push(dir);
      }
      return dirs;
    },
  };
}

// --- Reads ---

function pullsPage(source: ScorecardSource, o: ScorecardOptions, page: number): any[] {
  const body = source.getJson(`repos/${o.repo}/pulls?state=closed&base=${encodeURIComponent(o.base)}&sort=updated&direction=desc&per_page=${PAGE}&page=${page}`);
  return Array.isArray(body) ? body : [];
}

/** Every PR merged into base inside the window; pages stop once a page's oldest update predates the window. */
export function readMergedPrs(source: ScorecardSource, o: ScorecardOptions, since: string): MergedPr[] {
  const out: MergedPr[] = [];
  const crewLogins = o.crew ? new Set(o.crew.map(l => l.toLowerCase())) : null;
  for (let page = 1; page <= 20; page++) {
    const pulls = pullsPage(source, o, page);
    for (const pr of pulls) {
      const mergedAt = typeof pr.merged_at === 'string' ? pr.merged_at : null;
      if (!mergedAt || mergedAt < since) continue;
      const author = String(pr.user?.login ?? '');
      const association = String(pr.author_association ?? 'NONE');
      const comments = readComments(source, o.repo, Number(pr.number), o.readyMarker);
      out.push({ number: Number(pr.number), author, association, title: String(pr.title ?? ''),
        crew: crewLogins ? crewLogins.has(author.toLowerCase()) : CREW_ASSOCIATIONS.has(association),
        createdAt: String(pr.created_at), mergedAt, readyAt: comments.readyAt, commentCostUsd: comments.costUsd });
    }
    const oldest = pulls[pulls.length - 1]?.updated_at;
    if (pulls.length < PAGE || (typeof oldest === 'string' && oldest < since)) break;
  }
  return out.sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));
}

/** The first READY-style comment's time and the newest verdict comment's cost, from one page of a PR's comments. */
export function readComments(source: ScorecardSource, repo: string, pr: number, readyMarker: RegExp): { readyAt: string | null; costUsd: number | null } {
  const body = source.getJson(`repos/${repo}/issues/${pr}/comments?per_page=${PAGE}&page=1`);
  const comments = Array.isArray(body) ? body : [];
  let readyAt: string | null = null;
  let costUsd: number | null = null;
  for (const c of comments) {
    const text = String(c.body ?? '');
    const at = String(c.created_at ?? '');
    if (readyMarker.test(text) && (!readyAt || at < readyAt)) readyAt = at;
    for (const m of text.matchAll(COST_LINE)) costUsd = Number(m[1] ?? m[2]);
  }
  return { readyAt, costUsd };
}

export function classifyGate(run: { branch: string; title: string }, trainPrefix: string): GateKind {
  if (run.branch.startsWith(trainPrefix)) return 'train';
  if (/backstop/i.test(run.title)) return 'backstop';
  if (/screen #\d+/i.test(run.title)) return 'screen';
  return 'other';
}

export function gateOutcome(conclusion: string | null): GateOutcome {
  if (conclusion === 'success') return 'green';
  if (conclusion === 'cancelled' || conclusion === 'skipped') return 'cancelled';
  return 'red';
}

/** Cost from the verdict artifact (collector-outcomes.json .verdict.costUsd), null when absent or unreadable. */
export function verdictCost(dirs: string[]): number | null {
  for (const file of dirs.flatMap(dir => filesUnder(dir, base => base === 'collector-outcomes.json'))) {
    try {
      const cost = JSON.parse(fs.readFileSync(file, 'utf8'))?.verdict?.costUsd;
      if (typeof cost === 'number' && Number.isFinite(cost)) return Math.round(cost * 100) / 100;
    } catch { /* unreadable: no cost from this file */ }
  }
  return null;
}

/** gate-flake records (one per case that failed once and passed its rerun) and their known rerun spend. */
export function flakeRecords(dirs: string[]): { flakes: number; rerunUsd: number } {
  let flakes = 0;
  let rerunUsd = 0;
  for (const file of dirs.flatMap(dir => filesUnder(dir, base => base.endsWith('.jsonl')))) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec?.kind !== 'gate-flake') continue;
        flakes++;
        if (typeof rec.rerun_cost_usd === 'number') rerunUsd += rec.rerun_cost_usd;
      } catch { /* torn line */ }
    }
  }
  return { flakes, rerunUsd: Math.round(rerunUsd * 100) / 100 };
}

/** Gate runs in the window with kind, outcome, cost and flake records; artifacts are read for the newest maxArtifactRuns only. */
export function readGateRuns(source: ScorecardSource, o: ScorecardOptions, since: string, prCost: Map<number, number>): { gates: GateRun[]; artifactRunsRead: number } {
  const query = [`status=completed`, `per_page=${PAGE}`, `created=${encodeURIComponent(`>=${since.slice(0, 10)}`)}`,
    ...(o.gateEvent ? [`event=${encodeURIComponent(o.gateEvent)}`] : [])].join('&');
  const gates: GateRun[] = [];
  for (let page = 1; page <= 20; page++) {
    const body = source.getJson(`repos/${o.repo}/actions/workflows/${o.gateWorkflow}/runs?${query}&page=${page}`) as { workflow_runs?: any[] };
    const runs = Array.isArray(body?.workflow_runs) ? body.workflow_runs : [];
    for (const run of runs) {
      if (String(run.created_at) < since || (o.gateEvent && run.event !== o.gateEvent)) continue;
      const title = String(run.display_title ?? run.name ?? '');
      const branch = String(run.head_branch ?? '');
      const pr = Number(/#(\d+)/.exec(title)?.[1] ?? run.pull_requests?.[0]?.number ?? NaN);
      gates.push({ id: Number(run.id), kind: classifyGate({ branch, title }, o.trainPrefix), outcome: gateOutcome(run.conclusion ?? null),
        createdAt: String(run.created_at), branch, title, pr: Number.isFinite(pr) ? pr : null, costUsd: null, costSource: null, flakes: 0, flakeRerunUsd: 0 });
    }
    if (runs.length < PAGE) break;
  }
  gates.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const artifactRunsRead = Math.min(gates.length, o.maxArtifactRuns);
  gates.forEach((gate, index) => {
    if (index < artifactRunsRead) {
      gate.costUsd = verdictCost(source.artifactDirs(gate.id, name => /^report-verdict-a\d+$/.test(name)));
      if (gate.costUsd !== null) gate.costSource = 'artifact';
      const flakes = flakeRecords(source.artifactDirs(gate.id, name => /^flake-records-a\d+$/.test(name)));
      gate.flakes = flakes.flakes;
      gate.flakeRerunUsd = flakes.rerunUsd;
    }
    if (gate.costUsd === null && gate.pr !== null && prCost.has(gate.pr)) { gate.costUsd = prCost.get(gate.pr)!; gate.costSource = 'comment'; }
  });
  return { gates, artifactRunsRead };
}

/** Free-suite runs on base in the window and the flaky-pass entries their flake-ledger-* artifacts hold. */
export function readFreeRetries(source: ScorecardSource, o: ScorecardOptions, since: string): FreeRetryRun[] {
  const client: GhClient = { getJson: p => source.getJson(p), downloadZip: () => { throw new Error('not used'); } };
  const runs = listWorkflowRuns(client, o.repo, o.freeWorkflow, { since, branch: o.base });
  return runs.map((run, index) => ({ id: run.id, conclusion: run.conclusion,
    retries: index < o.maxArtifactRuns ? source.artifactDirs(run.id, name => name.startsWith('flake-ledger-')).flatMap(readFlakeLedgerDir).length : 0 }));
}

function searchCount(source: ScorecardSource, q: string): number | null {
  const body = source.getJson(`search/issues?q=${encodeURIComponent(q)}&per_page=1`) as { total_count?: number };
  return typeof body?.total_count === 'number' ? body.total_count : null;
}

export function readReleases(source: ScorecardSource, repo: string, since: string): Array<{ tag: string; publishedAt: string }> {
  const body = source.getJson(`repos/${repo}/releases?per_page=${PAGE}&page=1`);
  return (Array.isArray(body) ? body : []).filter(r => !r.draft && typeof r.published_at === 'string' && r.published_at >= since)
    .map(r => ({ tag: String(r.tag_name ?? ''), publishedAt: String(r.published_at) }));
}

/** Every read, each guarded: one unreadable input marks its lines unavailable and the rest still print. */
export function collectScorecard(source: ScorecardSource, o: ScorecardOptions): Scorecard {
  const since = new Date(o.now - o.sinceDays * 86_400_000).toISOString();
  const card: Scorecard = { repo: o.repo, base: o.base, windowStart: since, windowEnd: new Date(o.now).toISOString(),
    prs: [], gates: [], freeRuns: [], artifactRunsRead: 0, issuesOpened: null, issuesClosed: null, releases: [], unavailable: [] };
  const guard = (what: string, fn: () => void) => { try { fn(); } catch (e) { card.unavailable.push(`${what}: ${unavailableReason(e)}`); } };
  guard('merged PRs', () => { card.prs = readMergedPrs(source, o, since); });
  guard('gate runs', () => {
    const prCost = new Map(card.prs.filter(p => p.commentCostUsd !== null).map(p => [p.number, p.commentCostUsd!] as const));
    Object.assign(card, readGateRuns(source, o, since, prCost));
  });
  guard('free retries', () => { card.freeRuns = readFreeRetries(source, o, since); });
  const day = since.slice(0, 10);
  guard('issues', () => {
    card.issuesOpened = searchCount(source, `repo:${o.repo} is:issue created:>=${day}`);
    card.issuesClosed = searchCount(source, `repo:${o.repo} is:issue closed:>=${day}`);
  });
  guard('releases', () => { card.releases = readReleases(source, o.repo, since); });
  return card;
}

// --- Arithmetic and rendering ---

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

export function hours(from: string, to: string): number { return (Date.parse(to) - Date.parse(from)) / 3_600_000; }

export function fmtHours(h: number | null): string {
  if (h === null) return 'n/a';
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

const pct = (num: number, den: number) => (den === 0 ? 'n/a' : `${Math.round((num / den) * 100)}%`);
const usd = (n: number) => `$${n.toFixed(2)}`;

/** What one of the best software factories would show on each line; the honest comparison lives in docs/recommended-harness.md. */
export const BENCHMARKS: Record<string, string> = {
  merged: 'several merges a day, every day; outside contributions land in the same week',
  lead_time: 'median under 24h, p90 under 3 days (DORA elite: change lead time under a day)',
  ready_to_merge: 'under 2h from READY to merge; every merged PR carries a READY comment',
  gates: 'green on 95%+ of runs, cancelled near 0, cost known for every run',
  cost_per_merge: 'known, stable or falling week over week',
  red_train: 'under 5% of trains red (each red train costs a bisect and a rebuild)',
  flaky: '0 repeat cases; under 1 flaky case per 10 gates; free retries under 1% of runs',
  issues: 'closed >= opened over the window; nothing severe older than a week',
  releases: 'at least one tagged release a week, on schedule',
};

export function scorecardRows(card: Scorecard): ScorecardRow[] {
  const crewPrs = card.prs.filter(p => p.crew);
  const lead = card.prs.map(p => hours(p.createdAt, p.mergedAt));
  const ready = card.prs.filter(p => p.readyAt).map(p => hours(p.readyAt!, p.mergedAt));
  const gates = card.gates;
  const by = (outcome: GateOutcome, kind?: GateKind) => gates.filter(g => g.outcome === outcome && (!kind || g.kind === kind)).length;
  const known = gates.filter(g => g.costUsd !== null);
  const knownUsd = known.reduce((s, g) => s + g.costUsd!, 0);
  const trains = gates.filter(g => g.kind === 'train' && g.outcome !== 'cancelled');
  const flakes = gates.reduce((s, g) => s + g.flakes, 0);
  const flakeUsd = gates.reduce((s, g) => s + g.flakeRerunUsd, 0);
  const retries = card.freeRuns.reduce((s, r) => s + r.retries, 0);
  const retryRuns = card.freeRuns.filter(r => r.retries > 0).length;
  const unavailable = (what: string) => card.unavailable.find(u => u.startsWith(what + ':'));
  const row = (id: string, metric: string, what: string, value: () => string, rule: string): ScorecardRow =>
    ({ id, metric, value: unavailable(what) ? `unavailable (${unavailable(what)!.slice(what.length + 2)})` : value(), benchmark: BENCHMARKS[id]!, rule });
  return [
    row('merged', 'Merged PRs', 'merged PRs', () => `${card.prs.length} (crew ${crewPrs.length}, outside ${card.prs.length - crewPrs.length})`,
      `merged_at inside the window, base ${card.base}; crew by login list or author_association OWNER/MEMBER/COLLABORATOR`),
    row('lead_time', 'Lead time, created to merged', 'merged PRs', () => `median ${fmtHours(percentile(lead, 0.5))}, p90 ${fmtHours(percentile(lead, 0.9))}`,
      'PR created_at to merged_at over the merged PRs above'),
    row('ready_to_merge', 'Lead time, READY to merged', 'merged PRs', () => `median ${fmtHours(percentile(ready, 0.5))}, p90 ${fmtHours(percentile(ready, 0.9))} (${ready.length} of ${card.prs.length} PRs with a READY comment)`,
      'first PR comment matching the READY marker to merged_at; PRs without one are left out'),
    row('gates', 'Gate runs green / red / cancelled', 'gate runs', () => `${by('green')} / ${by('red')} / ${by('cancelled')}; known cost ${usd(knownUsd)} on ${known.length} of ${gates.length} runs`,
      'completed runs of the gate workflow in the window; cost from the verdict artifact, else the PR verdict comment'),
    row('cost_per_merge', 'Known gate cost per merged PR', 'gate runs', () => (card.prs.length ? `${usd(knownUsd / card.prs.length)} (${gates.length - known.length} runs without a known cost)` : 'n/a (no merges)'),
      'known gate cost divided by merged PRs; unknown-cost runs make this a floor'),
    row('red_train', 'Red-train rate', 'gate runs', () => `${pct(trains.filter(t => t.outcome === 'red').length, trains.length)} (${trains.filter(t => t.outcome === 'red').length} red of ${trains.length} trains; ${by('red', 'backstop')} red backstop, ${by('red', 'screen')} red screens)`,
      `runs whose head branch starts with the train prefix, cancelled runs excluded; red means the run's conclusion was not success`),
    row('flaky', 'Flaky events', 'gate runs', () => `${flakes} paid case(s) passed on their one rerun (rerun spend ${usd(flakeUsd)}); ${retries} free-suite retr${retries === 1 ? 'y' : 'ies'} in ${retryRuns} of ${card.freeRuns.length} runs`,
      `flake-records artifacts of the newest ${card.artifactRunsRead} gate runs and flake-ledger artifacts of free runs on the base branch`),
    row('issues', 'Issues opened / closed', 'issues', () => `${card.issuesOpened ?? 'n/a'} / ${card.issuesClosed ?? 'n/a'}`, 'GitHub search: created, closed inside the window'),
    row('releases', 'Releases cut', 'releases', () => `${card.releases.length}${card.releases.length ? ` (${card.releases.map(r => r.tag).join(', ')})` : ''}`, 'releases published inside the window, drafts excluded'),
  ];
}

export function renderMarkdown(card: Scorecard, rows: ScorecardRow[]): string {
  const days = Math.round((Date.parse(card.windowEnd) - Date.parse(card.windowStart)) / 86_400_000);
  const esc = (s: string) => s.replace(/\|/g, '\\|');
  return [
    `## Factory scorecard: ${card.repo} (${card.windowStart.slice(0, 10)} to ${card.windowEnd.slice(0, 10)}, ${days} days)`, '',
    '| Metric | This window | One of the best factories would show | Counting rule |', '|---|---|---|---|',
    ...rows.map(r => `| ${r.metric} | ${esc(r.value)} | ${esc(r.benchmark)} | ${esc(r.rule)} |`), '',
    ...(card.unavailable.length ? ['Unavailable inputs: ' + card.unavailable.join('; '), ''] : []),
    `Sources: ${card.prs.length} merged PRs, ${card.gates.length} gate runs (artifacts read for ${card.artifactRunsRead}), ${card.freeRuns.length} free runs on ${card.base}. Read-only; no paid work.`, '',
  ].join('\n');
}

export function renderCsv(card: Scorecard, rows: ScorecardRow[]): string {
  const cell = (s: string) => `"${s.replace(/"/g, '""')}"`;
  return ['repo,window_start,window_end,metric_id,metric,value,benchmark,rule',
    ...rows.map(r => [card.repo, card.windowStart, card.windowEnd, r.id, r.metric, r.value, r.benchmark, r.rule].map(cell).join(','))].join('\n') + '\n';
}
