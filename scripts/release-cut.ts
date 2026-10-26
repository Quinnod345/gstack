#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * release-cut: tag the newest green commit on main as v<VERSION>, publish a
 * GitHub Release whose notes are that span's CHANGELOG headlines, and
 * fast-forward refs/heads/stable to it (docs/releases.md). Run by
 * .github/workflows/weekly-release.yml every Monday morning and by hand for a
 * hotfix (--ref <sha on main>). Dry runs print the plan and change nothing.
 *
 *   bun scripts/release-cut.ts --repo owner/name [--ref <sha>] [--dry-run] [--summary <file>]
 *     [--required-check <name>] [--backstop-check <name>] [--notes-ref <ref>]
 *
 * The checkout needs origin's full history (fetch-depth 0). Green, for a
 * commit on main's first-parent history, means: its required check run
 * succeeded (--required-check, default free-tests: the status main requires),
 * it was gated (see below), every check run on it has completed and none
 * failed, and the trains notes ref (--notes-ref, default
 * refs/notes/gstack-trains) holds no active freeze. The newest such commit in
 * the window (7 days, 200 first-parent commits) is the candidate; a commit
 * with a check run still going is skipped, not waited for.
 *
 * Gated means one of two kinds of evidence. Either the backstop check run
 * (--backstop-check, default main-backstop) succeeded: evals-main-backstop.yml
 * publishes it, success only when a green train record covers the tree or the
 * backstop gated it green, neutral when main moved past the push before it was
 * gated. Or a train record in the notes ref (kind train, state green, merging
 * or merged) lists the commit's sha or its tree in merged[]: those entries are
 * the main commits `gstack-ship-queue verify --train` confirmed, so a neutral
 * or absent backstop run on such a commit is not held against it, and the
 * CANDIDATE line says "gated by train <nonce>". A red backstop run stays red
 * either way. A commit with neither is not green.
 *
 * stable moves only forward: a candidate behind the current stable is refused
 * (REFUSED non-fast-forward), as is a tag v<VERSION> that already names another
 * commit. A cut that stopped half-way (tag and stable pushed, release not
 * created) is finished by the next run; a completed cut reports NOTHING_NEW
 * and exits 0.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

export type Gh = (args: string[]) => { status: number | null; stdout: string; stderr: string };
export type Git = (args: string[]) => { ok: boolean; out: string };

export const REQUIRED_CHECK = 'free-tests';
export const BACKSTOP_CHECK = 'main-backstop';
export const NOTES_REF = 'refs/notes/gstack-trains';
const NOTES_LOCAL = 'refs/notes/gstack-trains-release';
const RED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);
export const WINDOW_DAYS = 7;
export const WINDOW_COMMITS = 200;
export const NOTES_CAP = 60_000;

export const runGh: Gh = (args) => {
  const r = spawnSync('gh', args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.error ? String(r.error) : r.stderr ?? '' };
};
export const gitIn = (cwd: string): Git => (args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? { ok: true, out: (r.stdout ?? '').replace(/\n$/, '') } : { ok: false, out: (r.stderr || String(r.error ?? '')).trim() };
};

function parseJson<T>(r: { status: number | null; stdout: string }): T | null {
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout) as T; } catch { return null; }
}

/** Four-part versions compare numerically, part by part. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Green names what gated the commit: the backstop check's name, or `train <nonce>`. Pending means a check run on it is still going. */
export type Verdict = { green: true; via: string } | { green: false; why: string; pending: boolean };
interface CheckRun { name: string; status: string; conclusion: string | null }

/** Main commits a green, merging or merged train record lists in merged[], by sha and by tree, each naming the train. */
export interface TrainEvidence { bySha: Map<string, string>; byTree: Map<string, string> }
export interface GateOptions { requiredCheck?: string; backstopCheck?: string; evidence?: TrainEvidence; treeOf?: (sha: string) => string | null }

/** Why a commit is not releasable, or green and through which evidence. */
export function gateVerdict(gh: Gh, repo: string, sha: string, o: GateOptions = {}): Verdict {
  const required = o.requiredCheck ?? REQUIRED_CHECK;
  const backstop = o.backstopCheck ?? BACKSTOP_CHECK;
  const paged = parseJson<unknown>(gh(['api', '--paginate', '--slurp', `repos/${repo}/commits/${sha}/check-runs?per_page=100`]));
  if (!paged) return { green: false, why: 'cannot read its check runs', pending: false };
  const pages = (Array.isArray(paged) ? paged : [paged]) as Array<{ check_runs?: CheckRun[] }>;
  const runs = pages.flatMap(p => p.check_runs ?? []);
  let via = backstop;
  for (const name of [required, backstop]) {
    const named = runs.filter(c => c.name === name);
    if (named.some(c => c.status !== 'completed')) return { green: false, why: `${name} is still running`, pending: true };
    if (named.some(c => c.conclusion === 'success')) continue;
    const train = name === backstop && name !== required && o.evidence ? o.evidence.bySha.get(sha) ?? o.evidence.byTree.get(o.treeOf?.(sha) ?? '') : undefined;
    if (train) { via = `train ${train}`; continue; }
    if (named.length === 0) return { green: false, why: `no ${name} check run`, pending: false };
    return { green: false, why: `${name} concluded ${named.map(c => c.conclusion).join(',')}`, pending: false };
  }
  const red = runs.filter(c => c.status === 'completed' && RED.has(c.conclusion ?? ''));
  if (red.length > 0) return { green: false, why: `red check runs: ${[...new Set(red.map(c => c.name))].join(', ')}`, pending: false };
  const running = runs.filter(c => c.status !== 'completed');
  if (running.length > 0) return { green: false, why: `check runs still going: ${[...new Set(running.map(c => c.name))].join(', ')}`, pending: true };
  return { green: true, via };
}

export interface TrainNotes { error: string | null; freeze: string | null; evidence: TrainEvidence }
interface NoteRecord { kind?: string; state?: string; nonce?: string; merged?: Array<{ sha?: string; tree?: string }>; cleared_at?: string | null; reason?: string; train?: string }

/**
 * One read of the trains notes ref (fetched from origin): the active freeze
 * record (kind freeze, cleared_at null) and the train evidence (lib/
 * ship-queue-train-record.ts TrainRecord: kind train, state green, merging or
 * merged, merged[].sha and .tree). A fetch failure other than a missing ref is
 * an error; a missing ref holds nothing.
 */
export function readTrainNotes(git: Git, notesRef = NOTES_REF): TrainNotes {
  const notes: TrainNotes = { error: null, freeze: null, evidence: { bySha: new Map(), byTree: new Map() } };
  const f = git(['fetch', '--no-tags', '-q', 'origin', `+${notesRef}:${NOTES_LOCAL}`]);
  if (!f.ok) {
    if (!/couldn't find remote ref|no such ref/i.test(f.out)) notes.error = `cannot fetch ${notesRef}: ${f.out.slice(0, 160)}`;
    return notes;
  }
  const listed = git(['notes', `--ref=${NOTES_LOCAL}`, 'list']);
  if (!listed.ok || !listed.out.trim()) return notes;
  for (const line of listed.out.split('\n')) {
    const blob = line.split(' ')[0];
    if (!blob) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(git(['cat-file', 'blob', blob]).out); } catch { continue; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const r = parsed as NoteRecord;
    if (r.kind === 'freeze' && !r.cleared_at) notes.freeze = `queue frozen since train ${r.train ?? '?'}: ${r.reason ?? 'red backstop'}`;
    if (r.kind !== 'train' || typeof r.nonce !== 'string' || !r.nonce || !['green', 'merging', 'merged'].includes(r.state ?? '')) continue;
    for (const m of Array.isArray(r.merged) ? r.merged : []) {
      if (!m || typeof m !== 'object') continue;
      if (typeof m.sha === 'string' && m.sha) notes.evidence.bySha.set(m.sha, r.nonce);
      if (typeof m.tree === 'string' && m.tree) notes.evidence.byTree.set(m.tree, r.nonce);
    }
  }
  return notes;
}

export interface ChangelogEntry { version: string; date: string; headline: string }

/** Every "## [X.Y.Z.W] - date" entry of a CHANGELOG with its first prose line, markdown stripped. */
export function changelogEntries(text: string): ChangelogEntry[] {
  const out: ChangelogEntry[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^## \[(\d+(?:\.\d+)+)\](?: - (\S+))?/.exec(lines[i]!);
    if (!m) continue;
    let headline = '';
    for (let j = i + 1; j < lines.length && !lines[j]!.startsWith('## '); j++) {
      const l = lines[j]!.trim();
      if (!l || l.startsWith('#') || l.startsWith('|') || l.startsWith('-') || l.startsWith('```')) continue;
      const bold = /^\*\*(.+?)\*\*/.exec(l);
      headline = (bold ? bold[1]! : l.replace(/\*\*/g, '')).replace(/\s+/g, ' ');
      break;
    }
    out.push({ version: m[1]!, date: m[2] ?? '', headline });
  }
  return out;
}

export interface NotesInput { repo: string; version: string; date: string; prevVersion: string | null; prevTag: string | null; entries: ChangelogEntry[]; hotfix: boolean; first?: boolean }

/** Release notes: one headline per version in (prev, version], capped at NOTES_CAP. */
export function releaseNotes(n: NotesInput): string {
  const span = n.entries.filter(e => compareVersions(e.version, n.version) <= 0 && (!n.prevVersion || compareVersions(e.version, n.prevVersion) > 0))
    .sort((a, b) => compareVersions(b.version, a.version));
  const plural = span.length === 1 ? '' : 's';
  const changelogUrl = 'https://github.com/' + n.repo + '/blob/v' + n.version + '/CHANGELOG.md';
  const compare = n.prevTag ? '[Compare](https://github.com/' + n.repo + '/compare/' + n.prevTag + '...v' + n.version + ') or read ' : 'Read ';
  const head = [
    '## gstack v' + n.version + (n.hotfix ? ' (hotfix release)' : ' (weekly release)'),
    '',
    n.first || !n.prevVersion
      ? 'First tagged release: the ' + span.length + ' version' + plural + (n.prevVersion ? ' since v' + n.prevVersion + ' (the week before it)' : '') + ', one line each; the [full changelog](' + changelogUrl + ') has every earlier one.'
      : span.length + ' version' + plural + ' since v' + n.prevVersion + ', one line each. ' + compare + 'the [full changelog](' + changelogUrl + ').',
    '',
    'Team-mode installs follow the stable branch, which now points here; gstack-config set update_channel main follows every merge instead ([docs/releases.md](https://github.com/' + n.repo + '/blob/v' + n.version + '/docs/releases.md)).',
    '',
  ].join('\n');
  const bullets = span.map(e => '- **' + e.version + '**' + (e.date ? ' (' + e.date + ')' : '') + ': ' + (e.headline || 'see CHANGELOG.md'));
  let body = head + bullets.join('\n') + '\n';
  if (body.length > NOTES_CAP) {
    const kept: string[] = [];
    let size = head.length;
    for (const b of bullets) { if (size + b.length + 1 > NOTES_CAP - 200) break; kept.push(b); size += b.length + 1; }
    body = head + kept.join('\n') + '\n- ...and ' + (bullets.length - kept.length) + ' more versions; see CHANGELOG.md\n';
  }
  return body;
}

export interface Plan {
  sha: string; version: string; tag: string; date: string; hotfix: boolean; via: string;
  prevStable: string | null; prevVersion: string | null; prevTag: string | null;
  tagExists: 'no' | 'same' | 'other'; stableAt: boolean; notes: string; skipped: string[];
}
export type PlanResult = { ok: true; plan: Plan } | { ok: false; code: 'NOTHING_NEW' | 'NO_GREEN_COMMIT' | 'REFUSED'; message: string; skipped?: string[] };

export interface PlanOptions {
  repo: string; ref?: string; git: Git; gh: Gh; now?: () => number; windowDays?: number; windowCommits?: number;
  requiredCheck?: string; backstopCheck?: string; notesRef?: string;
}

export function planRelease(o: PlanOptions): PlanResult {
  const { git, gh, repo } = o;
  const windowDays = o.windowDays ?? WINDOW_DAYS;
  const skipped: string[] = [];
  const mainHead = git(['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}']);
  if (!mainHead.ok) return { ok: false, code: 'REFUSED', message: 'origin/main is not fetched: ' + mainHead.out };
  const stable = git(['rev-parse', '--verify', '-q', 'refs/remotes/origin/stable^{commit}']);
  const prevStable = stable.ok ? stable.out : null;
  const trains = readTrainNotes(git, o.notesRef);
  const frozen = trains.error ?? trains.freeze;
  if (frozen) return { ok: false, code: 'REFUSED', message: frozen };
  const gate: GateOptions = {
    requiredCheck: o.requiredCheck, backstopCheck: o.backstopCheck, evidence: trains.evidence,
    treeOf: (sha) => { const t = git(['rev-parse', sha + '^{tree}']); return t.ok ? t.out : null; },
  };

  let candidates: string[];
  if (o.ref) {
    const r = git(['rev-parse', '--verify', o.ref + '^{commit}']);
    if (!r.ok) return { ok: false, code: 'REFUSED', message: '--ref ' + o.ref + ' is not a commit here: ' + r.out };
    const fp = git(['rev-list', '--first-parent', 'refs/remotes/origin/main']);
    if (!fp.out.split('\n').includes(r.out)) return { ok: false, code: 'REFUSED', message: '--ref ' + r.out.slice(0, 12) + " is not on main's first-parent history; a release is always a merge commit of main" };
    candidates = [r.out];
  } else {
    const since = new Date((o.now?.() ?? Date.now()) - windowDays * 86_400_000).toISOString();
    const list = git(['rev-list', '--first-parent', '--max-count=' + (o.windowCommits ?? WINDOW_COMMITS), '--since=' + since, 'refs/remotes/origin/main']);
    candidates = list.ok && list.out ? list.out.split('\n') : [];
    if (candidates.length === 0) return { ok: false, code: 'NOTHING_NEW', message: 'no commit on origin/main in the last ' + windowDays + ' days' };
  }

  // stable itself stays a candidate so a cut that stopped half-way (tag and
  // stable pushed, release missing) is finished; nothing older is looked at.
  let sha: string | null = null;
  let via = '';
  for (const c of candidates) {
    const v = gateVerdict(gh, repo, c, gate);
    if (v.green) { sha = c; via = v.via; break; }
    skipped.push(c.slice(0, 12) + ': ' + v.why);
    if (prevStable && c === prevStable) { skipped.push(c.slice(0, 12) + ': already stable; nothing newer is green'); break; }
  }
  if (!sha) {
    if (o.ref) return { ok: false, code: 'REFUSED', message: '--ref ' + candidates[0]!.slice(0, 12) + ' is not green: ' + (skipped[0] ?? '').split(': ').slice(1).join(': '), skipped };
    return { ok: false, code: 'NO_GREEN_COMMIT', message: 'no green commit among ' + candidates.length + ' on origin/main; see the skipped list', skipped };
  }
  if (prevStable && sha !== prevStable && !git(['merge-base', '--is-ancestor', prevStable, sha]).ok) {
    return { ok: false, code: 'REFUSED', message: 'non-fast-forward: stable ' + prevStable.slice(0, 12) + ' is not an ancestor of ' + sha.slice(0, 12) + '; stable only moves forward along main' };
  }

  const version = git(['show', sha + ':VERSION']).out.trim();
  if (!/^\d+(\.\d+)+$/.test(version)) return { ok: false, code: 'REFUSED', message: 'VERSION at ' + sha.slice(0, 12) + " is not a version: '" + version + "'" };
  const tag = 'v' + version;
  const existing = git(['rev-parse', '--verify', '-q', 'refs/tags/' + tag + '^{commit}']);
  const tagExists: Plan['tagExists'] = !existing.ok ? 'no' : existing.out === sha ? 'same' : 'other';
  if (tagExists === 'other') return { ok: false, code: 'REFUSED', message: 'tag ' + tag + ' already names ' + existing.out.slice(0, 12) + ', not ' + sha.slice(0, 12) + '; a version is stamped once per merge, so this needs a look' };
  if (prevStable === sha && tagExists === 'same' && gh(['release', 'view', tag, '--repo', repo, '--json', 'tagName']).status === 0) {
    return { ok: false, code: 'NOTHING_NEW', message: 'origin/main ' + sha.slice(0, 12) + ' is already released as ' + tag + '; nothing newer is green' };
  }

  // The release this one follows: stable, or when stable already sits here
  // (a cut that stopped half-way), the newest release tag behind it.
  let before = prevStable;
  if (prevStable === sha) {
    const prior = git(['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', '--first-parent', sha + '^']);
    const resolved = prior.ok && prior.out ? git(['rev-parse', '--verify', '-q', prior.out + '^{commit}']) : null;
    before = resolved?.ok ? resolved.out : null;
  }
  let prevVersion: string | null = null, prevTag: string | null = null;
  if (before) {
    const shown = git(['show', before + ':VERSION']);
    prevVersion = shown.ok ? shown.out.trim() || null : null;
    if (prevVersion && git(['rev-parse', '--verify', '-q', 'refs/tags/v' + prevVersion + '^{commit}']).ok) prevTag = 'v' + prevVersion;
  } else {
    const date = git(['show', '-s', '--format=%cI', sha]).out;
    const before = new Date(new Date(date).getTime() - windowDays * 86_400_000).toISOString();
    const older = git(['rev-list', '--first-parent', '-1', '--before=' + before, sha]);
    if (older.ok && older.out) prevVersion = git(['show', older.out + ':VERSION']).out.trim() || null;
  }
  const changelog = git(['show', sha + ':CHANGELOG.md']);
  const date = git(['show', '-s', '--format=%cs', sha]).out;
  const notes = releaseNotes({ repo, version, date, prevVersion, prevTag, entries: changelog.ok ? changelogEntries(changelog.out) : [], hotfix: Boolean(o.ref), first: !before });
  return { ok: true, plan: { sha, version, tag, date, hotfix: Boolean(o.ref), via, prevStable, prevVersion, prevTag, tagExists, stableAt: prevStable === sha, notes, skipped } };
}

export interface CutResult { ok: boolean; lines: string[] }

/** Tag, push stable and create the release for a plan; each step is skipped when already done. */
export function cutRelease(p: Plan, o: { repo: string; git: Git; gh: Gh; notesDir?: string }): CutResult {
  const { git, gh } = o;
  const lines: string[] = [];
  const existing = git(['rev-parse', '--verify', '-q', 'refs/tags/' + p.tag + '^{commit}']);
  if (existing.ok && existing.out !== p.sha) return { ok: false, lines: ['TAG: ' + p.tag + ' already names ' + existing.out.slice(0, 12) + ', not ' + p.sha.slice(0, 12)] };
  if (!existing.ok) {
    const t = git(['tag', '-a', p.tag, p.sha, '-m', 'gstack ' + p.tag + (p.hotfix ? ' (hotfix release)' : ' (weekly release)')]);
    if (!t.ok) return { ok: false, lines: [...lines, 'TAG: failed: ' + t.out] };
    const push = git(['push', 'origin', 'refs/tags/' + p.tag]);
    if (!push.ok) return { ok: false, lines: [...lines, 'TAG: push failed: ' + push.out] };
    lines.push('TAG: ' + p.tag + ' -> ' + p.sha.slice(0, 12) + ' pushed');
  } else {
    lines.push('TAG: ' + p.tag + ' already names ' + p.sha.slice(0, 12));
  }
  if (!p.stableAt) {
    const push = git(['push', 'origin', p.sha + ':refs/heads/stable']);
    if (!push.ok) return { ok: false, lines: [...lines, 'STABLE: push failed: ' + push.out] };
    lines.push('STABLE: ' + (p.prevStable ? p.prevStable.slice(0, 12) : 'none') + ' -> ' + p.sha.slice(0, 12));
  } else {
    lines.push('STABLE: already at ' + p.sha.slice(0, 12));
  }
  const view = gh(['release', 'view', p.tag, '--repo', o.repo, '--json', 'tagName']);
  if (view.status === 0) {
    lines.push('RELEASE: ' + p.tag + ' already published');
  } else {
    const dir = o.notesDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-release-'));
    const file = path.join(dir, p.tag + '.md');
    fs.writeFileSync(file, p.notes);
    const created = gh(['release', 'create', p.tag, '--repo', o.repo, '--verify-tag', '--title', 'gstack ' + p.tag, '--notes-file', file]);
    if (created.status !== 0) return { ok: false, lines: [...lines, 'RELEASE: create failed: ' + created.stderr.trim().slice(0, 300)] };
    lines.push(('RELEASE: ' + p.tag + ' published ' + created.stdout.trim()).trim());
  }
  return { ok: true, lines };
}

export function describePlan(p: Plan, dryRun: boolean): string[] {
  const lines = [
    'CANDIDATE: ' + p.sha + ' (' + p.date + ')' + (p.hotfix ? ' [hotfix: --ref]' : '') + ' gated by ' + p.via,
    'VERSION: ' + p.version + ' -> tag ' + p.tag + (p.tagExists === 'same' ? ' (exists at this commit)' : ''),
    'STABLE: ' + (p.stableAt ? 'already at ' + p.sha.slice(0, 12) + ' (finishing an earlier cut)' : (p.prevStable ? p.prevStable.slice(0, 12) + ' (v' + (p.prevVersion ?? '?') + ')' : 'none yet') + ' -> ' + p.sha.slice(0, 12)),
    'NOTES: ' + p.notes.split('\n').filter(l => l.startsWith('- ')).length + ' version lines, ' + p.notes.length + ' chars',
  ];
  for (const s of p.skipped) lines.push('SKIPPED: ' + s);
  if (dryRun) {
    lines.push('DRY_RUN: nothing pushed, nothing created. The cut would run:',
      '  git tag -a ' + p.tag + ' ' + p.sha + ' && git push origin refs/tags/' + p.tag,
      '  git push origin ' + p.sha + ':refs/heads/stable',
      '  gh release create ' + p.tag + ' --verify-tag --title "gstack ' + p.tag + '" --notes-file <notes>');
  }
  return lines;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (import.meta.main) {
  const repo = arg('--repo');
  const dryRun = process.argv.includes('--dry-run');
  const summary = arg('--summary');
  if (!repo) { console.error('usage: release-cut.ts --repo owner/name [--ref <sha>] [--dry-run] [--summary <file>] [--required-check <name>] [--backstop-check <name>] [--notes-ref <ref>]'); process.exit(2); }
  const git = gitIn(process.cwd());
  const emit = (lines: string[]) => {
    for (const l of lines) console.log(l);
    if (summary) fs.appendFileSync(summary, lines.map(l => '- ' + l).join('\n') + '\n');
  };
  const planned = planRelease({ repo, ref: arg('--ref'), git, gh: runGh, requiredCheck: arg('--required-check'), backstopCheck: arg('--backstop-check'), notesRef: arg('--notes-ref') });
  if (!planned.ok) {
    emit([planned.code + ': ' + planned.message, ...(planned.skipped ?? []).map(s => 'SKIPPED: ' + s)]);
    // A dry run that finds nothing green has done its job (the skips say why);
    // the real cut goes red so someone looks.
    process.exit(planned.code === 'NOTHING_NEW' || (dryRun && planned.code === 'NO_GREEN_COMMIT') ? 0 : 1);
  }
  emit(describePlan(planned.plan, dryRun));
  if (summary) fs.appendFileSync(summary, '\n<details><summary>Release notes</summary>\n\n' + planned.plan.notes + '\n</details>\n');
  else console.log('--- notes ---\n' + planned.plan.notes);
  if (dryRun) process.exit(0);
  const cut = cutRelease(planned.plan, { repo, git, gh: runGh });
  emit(cut.lines);
  process.exit(cut.ok ? 0 : 1);
}
