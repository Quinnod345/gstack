/**
 * ship-queue-land — the per-PR merge step (docs/ship-policy.md#land), behind
 * `gstack-ship-queue land --pr <n>`. The PR carries an unversioned change (a
 * changelog fragment, or a legacy `[Unreleased]` section) at a pin /ship
 * reviewed; land takes the repository land lock, merges the pin with the base
 * branch (resolving release-version fields only), stamps the merged tree with
 * gstack-restamp, makes one commit whose parents are [pin, base] and whose tree
 * is the stamped tree, pushes it to the PR branch under an exact lease, waits
 * for the PR's checks there, merges with --match-head-commit, and confirms the
 * base branch's tree is the stamped tree. Every step is journaled under
 * .gstack/tmp/ship-queue/land/<pr>.json, so a rerun resumes.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { mergeChangelogs, parseChangelog } from './changelog-check';
import { fragmentSlug, readFragments } from './changelog-fragments';
import { restamp, versionAtRef } from './restamp';
import { matchesAny, type ShipPolicy } from './ship-policy';
import { ciAtHead, loadBasePolicy, type QueueContext, type StepOutput } from './ship-queue';
import { QUEUE_DIR_REL, git, writeJsonAtomic, type QueueFailure } from './ship-queue-gate';
import { bindReceipt } from './ship-receipt';

export const LAND_LOCK_REF = 'refs/notes/gstack-land';
export const MAX_RESTAMPS = 2;
const PUSH_STALE_MS = 10 * 60_000;

export interface LandJournal {
  schema_version: 1; pr: string; branch: string;
  reviewed_pin: string; last_pushed_head: string | null; stamp_commit: string | null; stamp_tree: string | null;
  base_sha: string | null; version: string | null; date: string | null; restamps: number;
  drift_main?: string; repair_pr?: string;
  phase: 'locked' | 'stamped' | 'pushed' | 'merged' | 'landed' | 'drift';
}
export interface LandLock { pr: string; holder: string; started_at: string; phase: 'stamping' | 'pushing' | 'waiting' | 'merging' | 'drift'; journal: string }
export interface LandOptions { pr: string; repair?: boolean; dryRun?: boolean; noWait?: boolean; breakLock?: boolean; allowRepoCommands?: boolean; waitTimeoutMin?: number; now?: () => Date; holder?: string }

const fail = (lines: string[], failure: QueueFailure, run: string): StepOutput => ({ ok: false, lines, failure, run });
export const landJournalRel = (pr: string) => `${QUEUE_DIR_REL}/land/${pr}.json`;

function readJson<T>(file: string): T | null { try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return null; } }

/** The remote land lock: a ref whose commit holds lock.json, or a released marker. Updated only by exact lease. */
function readLock(root: string): { sha: string; lock: LandLock | null } {
  git(root, ['fetch', '-q', 'origin', `+${LAND_LOCK_REF}:${LAND_LOCK_REF}`]);
  const sha = git(root, ['rev-parse', '--verify', '--quiet', LAND_LOCK_REF]).out;
  if (!sha) return { sha: '', lock: null };
  const body = git(root, ['show', `${sha}:lock.json`]);
  const lock = body.ok ? (JSON.parse(body.out) as LandLock | { released: true }) : null;
  return { sha, lock: lock && 'pr' in lock ? lock : null };
}

function writeLock(root: string, expected: string, value: LandLock | { released: true; by: string; at: string }): { ok: boolean; sha: string } {
  const blob = git(root, ['hash-object', '-w', '--stdin'], undefined, JSON.stringify(value, null, 2) + '\n').out;
  const tree = git(root, ['mktree'], undefined, `100644 blob ${blob}\tlock.json\n`).out;
  const commit = git(root, ['commit-tree', tree, ...(expected ? ['-p', expected] : []), '-m', 'released' in value ? `land lock released by ${value.by}` : `land lock #${value.pr} ${value.phase}`]).out;
  const push = git(root, ['push', '-q', `--force-with-lease=${LAND_LOCK_REF}:${expected}`, 'origin', `${commit}:${LAND_LOCK_REF}`]);
  if (push.ok) git(root, ['update-ref', LAND_LOCK_REF, commit]);
  return { ok: push.ok, sha: commit };
}

/**
 * Release-version conflicts only: the version file and release outputs take the base's side, the
 * CHANGELOG merges by section (mergeChangelogs), and a manifest or npm lockfile is re-merged with
 * every side's release version set to the base's, so a clean dependency or script edit survives and
 * a real dependency conflict still conflicts. Returns the files it could not resolve.
 */
export function resolveReleaseConflicts(wt: string, conflicts: string[], policy: ShipPolicy, versionRel: string): string[] {
  const left: string[] = [];
  const stage = (n: number, rel: string) => git(wt, ['show', `:${n}:${rel}`]);
  for (const rel of conflicts) {
    const base = path.basename(rel);
    if (policy.changelog && rel === policy.changelog) {
      const merged = mergeChangelogs(stage(2, rel).out + '\n', stage(3, rel).out + '\n');
      if (merged === null) { left.push(rel); continue; }
      fs.writeFileSync(path.join(wt, rel), merged);
    } else if (rel === versionRel || matchesAny(policy.release_outputs, rel)) {
      if (!git(wt, ['checkout', '--theirs', '--', rel]).ok) { left.push(rel); continue; }
    } else if (['package.json', 'package-lock.json', 'npm-shrinkwrap.json'].includes(base)) {
      const sides = [1, 2, 3].map(n => stage(n, rel));
      if (sides.some(s => !s.ok)) { left.push(rel); continue; }
      const theirs = JSON.parse(sides[2]!.out);
      const pin = (text: string) => {
        const o = JSON.parse(text);
        if ('version' in o) o.version = theirs.version;
        if (o.packages?.[''] && theirs.packages?.['']) o.packages[''].version = theirs.packages[''].version;
        const indent = /^\{\n( +|\t)/.exec(text)?.[1] ?? 2;
        return JSON.stringify(o, null, indent) + '\n';
      };
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-land-merge-'));
      const [b, o, t] = ['base', 'ours', 'theirs'].map((n, i) => { const f = path.join(tmp, n); fs.writeFileSync(f, pin(sides[i === 0 ? 0 : i]!.out)); return f; });
      const m = spawnSync('git', ['merge-file', '-p', o!, b!, t!], { encoding: 'utf8', timeout: 30_000 });
      fs.rmSync(tmp, { recursive: true, force: true });
      if (m.status !== 0) { left.push(rel); continue; }
      fs.writeFileSync(path.join(wt, rel), m.stdout);
    } else { left.push(rel); continue; }
    git(wt, ['add', '--', rel]);
  }
  return left;
}

/**
 * A legacy per-PR stamp (a claim-at-open repo): the pin moved VERSION past its merge base and headed its
 * own entry with that version. Before the merge, put the pin's release fields back to the merge base's
 * values and re-head that entry `[Unreleased]`, committed in the scratch worktree, so the base merge
 * meets an unstamped change and the restamp allocates the version. Returns a note, or null.
 */
function unstampLegacy(wt: string, policy: ShipPolicy, versionRel: string, mergeBase: string): string | null {
  const mb = versionAtRef(wt, mergeBase);
  const own = versionAtRef(wt, 'HEAD');
  if (!('version' in mb) || !('version' in own) || mb.version === own.version) return null;
  const touched = [versionRel];
  fs.writeFileSync(path.join(wt, versionRel), git(wt, ['show', `${mergeBase}:${versionRel}`]).out + '\n');
  for (const rel of ['package.json', 'package-lock.json', 'npm-shrinkwrap.json']) {
    const before = git(wt, ['show', `${mergeBase}:${rel}`]);
    if (!before.ok || !fs.existsSync(path.join(wt, rel))) continue;
    const text = fs.readFileSync(path.join(wt, rel), 'utf8');
    const b = JSON.parse(before.out); const cur = JSON.parse(text);
    if ('version' in cur) cur.version = b.version;
    if (cur.packages?.[''] && b.packages?.['']) cur.packages[''].version = b.packages[''].version;
    fs.writeFileSync(path.join(wt, rel), JSON.stringify(cur, null, /^\{\n( +|\t)/.exec(text)?.[1] ?? 2) + '\n');
    touched.push(rel);
  }
  const cl = policy.changelog;
  if (cl && fs.existsSync(path.join(wt, cl))) {
    const text = fs.readFileSync(path.join(wt, cl), 'utf8');
    const baseKeys = new Set(parseChangelog(git(wt, ['show', `${mergeBase}:${cl}`]).out).sections.map(s => s.version));
    const parsed = parseChangelog(text);
    const mine = parsed.sections.find(s => s.version === own.version && !baseKeys.has(s.version));
    if (mine && !parsed.sections.some(s => s.unreleased)) {
      const lines = text.split('\n'); lines[mine.start] = '## [Unreleased]';
      fs.writeFileSync(path.join(wt, cl), lines.join('\n'));
      touched.push(cl);
    }
  }
  git(wt, ['add', '--', ...touched]);
  git(wt, ['commit', '-q', '--no-verify', '-m', `land: put the legacy stamp ${own.version} back to ${mb.version} before the base merge`]);
  return `legacy: the pin stamped ${own.version} itself; its release fields go back to ${mb.version} and its entry is re-headed [Unreleased] before the merge`;
}

/**
 * Merge the pin with origin/<base> in a scratch worktree, resolve release conflicts, give a PR with
 * no entry a title-derived fragment, and stamp with gstack-restamp. Returns the stamped tree.
 */
function buildStamp(ctx: QueueContext, policy: ShipPolicy, o: { pin: string; baseSha: string; pr: string; title: string; allowRepoCommands: boolean; now: Date }): { tree: string; version: string; lines: string[] } | QueueFailure {
  const root = ctx.repoRoot;
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-land-'));
  fs.rmSync(wt, { recursive: true, force: true });
  if (!git(root, ['worktree', 'add', '--detach', '-q', wt, o.pin]).ok) return { code: 'QUEUE_LAND_CONFLICT', message: `cannot create a worktree at the pin ${o.pin.slice(0, 12)}` };
  try {
    const lines: string[] = [];
    const at = versionAtRef(root, o.baseSha);
    const versionRel = 'rel' in at ? at.rel : 'VERSION';
    const legacy = unstampLegacy(wt, policy, versionRel, git(root, ['merge-base', o.pin, o.baseSha]).out);
    if (legacy) lines.push(legacy);
    const merge = git(wt, ['merge', '--no-ff', '--no-commit', '-q', o.baseSha]);
    if (!merge.ok) {
      const conflicts = git(wt, ['diff', '--name-only', '--diff-filter=U']).out.split('\n').filter(Boolean);
      if (!conflicts.length) return { code: 'QUEUE_LAND_CONFLICT', message: `git merge failed: ${merge.err.split('\n')[0]}` };
      const left = resolveReleaseConflicts(wt, conflicts, policy, versionRel);
      if (left.length) return { code: 'QUEUE_LAND_CONFLICT', message: `#${o.pr} conflicts with origin/${ctx.base} in ${left.join(', ')}` };
      lines.push(`resolved: ${conflicts.join(', ')} (release fields only)`);
    }
    const dir = policy.changelog_fragments?.dir;
    if (dir && policy.changelog) {
      const own = readFragments(wt, null, dir, o.baseSha);
      const cl = fs.existsSync(path.join(wt, policy.changelog)) ? fs.readFileSync(path.join(wt, policy.changelog), 'utf8') : '';
      if (!own.errors.length && !own.fragments.length && !parseChangelog(cl).sections.some(s => s.unreleased)) {
        const rel = `${dir.replace(/\/+$/, '')}/land-${fragmentSlug(o.pr)}.md`;
        fs.mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true });
        fs.writeFileSync(path.join(wt, rel), `- ${o.title.replace(/\s+/g, ' ').trim()} (#${o.pr})\n`);
        git(wt, ['add', '--', rel]);
        lines.push(`entry: none in the PR, so land wrote ${rel} from the title`);
      }
    }
    if (!git(wt, ['commit', '-q', '--no-verify', '--allow-empty', '-m', `land #${o.pr}: merge origin/${ctx.base}`]).ok) return { code: 'QUEUE_LAND_CONFLICT', message: 'cannot commit the merge in the scratch worktree' };
    const r = restamp({ repoRoot: wt, base: ctx.base, next: true, policyFrom: 'base', allowRepoCommands: o.allowRepoCommands, dryRun: false, now: o.now, env: process.env });
    if (r.status !== 'stamped' && r.status !== 'noop') return { code: r.code ?? 'QUEUE_LAND_CONFLICT', message: `restamp ${r.status}: ${r.message ?? ''}`, fix: r.fix };
    lines.push(...r.stages.filter(s => s.status !== 'pending').map(s => `stage ${s.name}: ${s.status}${s.detail ? ` (${s.detail})` : ''}`));
    git(wt, ['add', '-A']);
    return { tree: git(wt, ['write-tree']).out, version: r.newVersion!, lines };
  } finally {
    git(root, ['worktree', 'remove', '--force', wt]);
    fs.rmSync(wt, { recursive: true, force: true });
  }
}

interface PrInfo { state: string; headRefName: string; headRefOid: string; isCrossRepository: boolean; body: string; title: string }
function prInfo(ctx: QueueContext, pr: string): PrInfo | QueueFailure {
  const r = ctx.gh(['pr', 'view', pr, '--json', 'state,headRefName,headRefOid,isCrossRepository,body,title']);
  try { return JSON.parse(r.out) as PrInfo; } catch { return { code: 'QUEUE_NOT_READY', message: `gh pr view ${pr} failed: ${(r.err ?? r.out).trim().slice(0, 160)}` }; }
}

function waitGreen(ctx: QueueContext, pr: string, minutes: number): boolean {
  const bin = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'gstack-pr-wait');
  const r = spawnSync(bin, [pr, '--until', 'green', '--timeout', String(minutes)], { cwd: ctx.repoRoot, stdio: ['ignore', 'inherit', 'inherit'], timeout: (minutes + 5) * 60_000 });
  return r.status === 0;
}

/** `land --census`: what land would do with each open PR before a repository turns fragments on. Reads only. */
export function census(ctx: QueueContext): StepOutput {
  const root = ctx.repoRoot;
  const loaded = loadBasePolicy(ctx);
  if ('message' in loaded) return fail([], loaded, 'none');
  const policy = loaded.policy;
  git(root, ['fetch', '-q', 'origin', ctx.base]);
  const baseSha = git(root, ['rev-parse', `origin/${ctx.base}`]).out;
  const list = ctx.gh(['pr', 'list', '--state', 'open', '--base', ctx.base, '--limit', '200', '--json', 'number,headRefOid,isCrossRepository']);
  let prs: Array<{ number: number; headRefOid: string; isCrossRepository: boolean }> = [];
  try { prs = JSON.parse(list.out); } catch { return fail([], { code: 'QUEUE_NOT_READY', message: 'gh pr list failed' }, 'none'); }
  const at = versionAtRef(root, baseSha);
  const versionRel = 'rel' in at ? at.rel : 'VERSION';
  const lines = [`CENSUS: ${prs.length} open PR(s) against origin/${ctx.base}@${baseSha.slice(0, 12)} (fragments: ${policy.changelog_fragments ? policy.changelog_fragments.dir : 'off'})`];
  for (const p of prs.sort((a, b) => a.number - b.number)) {
    if (p.isCrossRepository) { lines.push(`#${p.number} fork: refused (QUEUE_TRAIN_UNTRUSTED)`); continue; }
    git(root, ['fetch', '-q', 'origin', `+refs/pull/${p.number}/head:refs/gstack-census/${p.number}`]);
    const head = p.headRefOid;
    const mt = git(root, ['merge-tree', '--write-tree', '--name-only', '--no-messages', baseSha, head]);
    const conflicts = mt.ok ? [] : mt.out.split('\n').slice(1).filter(Boolean);
    const product = conflicts.filter(c => c !== policy.changelog && c !== versionRel && !matchesAny(policy.release_outputs, c) && !['package.json', 'package-lock.json', 'npm-shrinkwrap.json'].includes(path.basename(c)));
    const frags = policy.changelog_fragments ? readFragments(root, head, policy.changelog_fragments.dir, baseSha) : { fragments: [], errors: [] };
    const cl = policy.changelog ? git(root, ['show', `${head}:${policy.changelog}`]).out : '';
    const legacy = parseChangelog(cl).sections.some(s => s.unreleased);
    const hv = versionAtRef(root, head);
    const bumped = 'version' in hv && 'version' in at && hv.version !== at.version;
    const entry = frags.errors.length ? `invalid fragment ${frags.errors[0]!.path}` : frags.fragments.length ? `fold ${frags.fragments.map(f => path.basename(f.path)).join(', ')}` : legacy ? 're-head legacy [Unreleased]' : 'no entry (land writes one from the title)';
    lines.push(`#${p.number} ${head.slice(0, 12)}: ${product.length ? `refuse (product conflict: ${product.join(', ')})` : entry}${bumped ? `; rewrite its tentative ${'version' in hv ? hv.version : ''} through restamp` : ''}${conflicts.length && !product.length ? `; resolve ${conflicts.join(', ')} (release fields only)` : ''}`);
  }
  return { ok: true, run: 'none', lines };
}

/**
 * `land --repair --pr <n>` after QUEUE_LAND_DRIFT: a merge outside land slipped in beside #n, so what it
 * brought has no release of its own. Open a PR from the base whose only change is a fragment for it: each
 * fragment the outside merge left unfolded on the base moves to repair-<n>-<name>.md (so it counts as new),
 * or, with none, one entry naming the outside commits. That PR goes through /ship and land like any other;
 * its land takes over #n's drift lock and releases it.
 */
function repair(ctx: QueueContext, policy: ShipPolicy, j: LandJournal | null, file: string, run: string): StepOutput {
  const root = ctx.repoRoot;
  if (!j || j.phase !== 'drift' || !j.drift_main || !j.base_sha) return fail([], { code: 'QUEUE_NOT_READY', message: `#${j?.pr ?? '?'} has no drift record; --repair runs only after QUEUE_LAND_DRIFT` }, run);
  const lines = [`REPAIR: #${j.pr} landed on ${j.drift_main.slice(0, 12)} beside a merge outside land`];
  if (j.repair_pr) return { ok: true, run, lines: [...lines, `REPAIR_PR: #${j.repair_pr} (already open)`, `NEXT: run /ship on #${j.repair_pr}, then gstack-ship-queue land --pr ${j.repair_pr}`] };
  const dir = policy.changelog_fragments?.dir?.replace(/\/+$/, '');
  if (!dir) return fail(lines, { code: 'QUEUE_NOT_READY', message: 'changelog_fragments is off: write the [Unreleased] entry for the outside merge by hand and land it' }, run);
  git(root, ['fetch', '-q', 'origin', ctx.base]);
  const main = git(root, ['rev-parse', `origin/${ctx.base}`]).out;
  const outside = git(root, ['log', '--first-parent', '--format=%h %s', `${j.base_sha}..${j.drift_main}^1`]).out.split('\n').filter(Boolean);
  const stray = readFragments(root, main, dir, null);
  const branch = `gstack-land-repair/${j.pr}`;
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-land-repair-'));
  fs.rmSync(wt, { recursive: true, force: true });
  if (!git(root, ['worktree', 'add', '--detach', '-q', wt, main]).ok) return fail(lines, { code: 'QUEUE_NOT_READY', message: `cannot create a worktree at ${main.slice(0, 12)}` }, run);
  try {
    for (const f of stray.fragments) {
      fs.renameSync(path.join(wt, f.path), path.join(wt, dir, `repair-${j.pr}-${path.basename(f.path)}`));
      lines.push(`moved: ${f.path} (left unfolded by the outside merge)`);
    }
    if (!stray.fragments.length) {
      fs.mkdirSync(path.join(wt, dir), { recursive: true });
      fs.writeFileSync(path.join(wt, dir, `repair-${j.pr}.md`), `- Changes merged outside land beside #${j.pr}: ${outside.map(c => c.slice(c.indexOf(' ') + 1)).join('; ') || 'unknown'}\n`);
      lines.push(`entry: ${dir}/repair-${j.pr}.md names ${outside.length} outside commit(s)`);
    }
    git(wt, ['add', '-A', '--', dir]);
    if (!git(wt, ['commit', '-q', '--no-verify', '-m', `land: release entry for the merge outside land beside #${j.pr}`]).ok) return fail(lines, { code: 'QUEUE_NOT_READY', message: 'cannot commit the repair' }, run);
    const head = git(wt, ['rev-parse', 'HEAD']).out;
    const push = git(root, ['push', '-q', `--force-with-lease=refs/heads/${branch}:`, 'origin', `${head}:refs/heads/${branch}`]);
    if (!push.ok) return fail(lines, { code: 'QUEUE_TRAIN_MOVED', message: `${branch} already exists on origin; open or land its PR` }, run);
    const pr = ctx.gh(['pr', 'create', '--base', ctx.base, '--head', branch, '--title', `Release entry for the merge outside land beside #${j.pr}`, '--body', `QUEUE_LAND_DRIFT repair (docs/troubleshooting.md#queue-land-drift). Outside commits: ${outside.join(', ') || 'unknown'}.`]);
    const n = /\/pull\/(\d+)/.exec(pr.out)?.[1];
    if (!pr.ok || !n) return fail(lines, { code: 'QUEUE_NOT_READY', message: `gh pr create failed: ${(pr.err ?? pr.out).trim().slice(0, 160)}` }, run);
    j.repair_pr = n; writeJsonAtomic(file, j);
    return { ok: true, run, lines: [...lines, `REPAIR_PR: #${n} ${branch} ${head}`, `NEXT: run /ship on #${n}, then gstack-ship-queue land --pr ${n} (it takes over #${j.pr}'s drift lock and releases it)`] };
  } finally {
    git(root, ['worktree', 'remove', '--force', wt]);
    fs.rmSync(wt, { recursive: true, force: true });
  }
}

/** `gstack-ship-queue land --pr <n>`: one resumable pass of the merge step. */
export function land(ctx: QueueContext, o: LandOptions): StepOutput {
  const root = ctx.repoRoot;
  const run = landJournalRel(o.pr);
  const file = path.join(root, run);
  const now = o.now ?? (() => new Date());
  const holder = o.holder ?? `${os.hostname()}:${process.pid}`;
  const loaded = loadBasePolicy(ctx);
  if ('message' in loaded) return fail([], loaded, run);
  const policy = loaded.policy;
  if (o.repair) return repair(ctx, policy, readJson<LandJournal>(file), file, run);
  const info = prInfo(ctx, o.pr);
  if ('code' in info) return fail([], info, run);
  if (info.isCrossRepository) return fail([], { code: 'QUEUE_TRAIN_UNTRUSTED', message: `#${o.pr} is a fork head; land stamps and pushes only crew branches` }, run);
  if (info.state !== 'OPEN') return fail([], { code: 'QUEUE_NOT_READY', message: `#${o.pr} is ${info.state}` }, run);
  let j = readJson<LandJournal>(file);
  if (j && (j.phase === 'landed' || j.reviewed_pin !== info.headRefOid && j.last_pushed_head !== info.headRefOid)) j = null;
  const pin = j?.reviewed_pin ?? info.headRefOid;
  const lines = [`LAND: #${o.pr} branch=${info.headRefName} pin=${pin}${j ? ` (resuming at ${j.phase})` : ''}`];
  const receipt = bindReceipt(info.body ?? '', o.pr, [pin]);
  lines.push(receipt.line);
  if (!receipt.ok) return fail(lines, { code: receipt.code, message: receipt.message, fix: 'run /ship at the pinned head first' }, run);
  if (!j) {
    const ci = ciAtHead(ctx, pin);
    lines.push(`CI: ${ci.line}`);
    if (!ci.green) return fail(lines, { code: 'QUEUE_NOT_READY', message: `required checks are not green at the pin ${pin.slice(0, 12)}` }, run);
  }
  if (o.dryRun) {
    git(root, ['fetch', '-q', 'origin', ctx.base]);
    const s = buildStamp(ctx, policy, { pin, baseSha: git(root, ['rev-parse', `origin/${ctx.base}`]).out, pr: o.pr, title: info.title, allowRepoCommands: !!o.allowRepoCommands, now: now() });
    if ('code' in s) return fail(lines, s, run);
    return { ok: true, run, lines: [...lines, ...s.lines, `STAMP_VERSION: ${s.version}`, `STAMP_TREE: ${s.tree}`, 'DRY-RUN: nothing locked, pushed or merged'] };
  }

  let { sha: lockSha, lock } = readLock(root);
  const repairOf = lock && lock.pr !== o.pr && lock.phase === 'drift' ? readJson<LandJournal>(path.join(root, lock.journal)) : null;
  if (repairOf?.repair_pr === o.pr) lines.push(`LOCK: taking over #${lock!.pr}'s drift lock for its repair`);
  else if (lock && lock.pr !== o.pr) {
    const age = now().getTime() - Date.parse(lock.started_at);
    if (!o.breakLock) return fail(lines, { code: 'QUEUE_LAND_LOCKED', message: `#${lock.pr} holds the land lock (${lock.holder}, phase ${lock.phase}, since ${lock.started_at})` }, run);
    if (lock.phase === 'pushing' && age < PUSH_STALE_MS) return fail(lines, { code: 'QUEUE_LAND_LOCKED', message: `#${lock.pr}'s holder is mid-push (${Math.round(age / 1000)} s ago); --break-lock refused` }, run);
    lines.push(`LOCK: broke #${lock.pr}'s lock (${lock.holder}, phase ${lock.phase})`);
  }
  const setLock = (phase: LandLock['phase']): QueueFailure | null => {
    const w = writeLock(root, lockSha, { pr: o.pr, holder, started_at: lock?.pr === o.pr ? lock.started_at : now().toISOString(), phase, journal: run });
    if (!w.ok) return { code: 'QUEUE_LAND_LOCKED', message: 'the land lock moved under this run (another lander took it)' };
    lockSha = w.sha; lock = { pr: o.pr, holder, started_at: lock?.pr === o.pr ? lock.started_at : now().toISOString(), phase, journal: run };
    return null;
  };
  const save = () => writeJsonAtomic(file, j);
  const failed = setLock(j?.phase === 'pushed' ? 'waiting' : 'stamping');
  if (failed) return fail(lines, failed, run);
  if (!j) { j = { schema_version: 1, pr: o.pr, branch: info.headRefName, reviewed_pin: pin, last_pushed_head: null, stamp_commit: null, stamp_tree: null, base_sha: null, version: null, date: null, restamps: 0, phase: 'locked' }; save(); }

  for (;;) {
    git(root, ['fetch', '-q', 'origin', ctx.base]);
    const baseNow = git(root, ['rev-parse', `origin/${ctx.base}`]).out;
    if (j.phase === 'pushed' && j.base_sha !== baseNow) {
      if (j.restamps >= MAX_RESTAMPS) return fail(lines, { code: 'QUEUE_LAND_BASE_BUSY', message: `origin/${ctx.base} moved during CI ${j.restamps + 1} times` }, run);
      lines.push(`BASE_MOVED: ${j.base_sha?.slice(0, 12)} -> ${baseNow.slice(0, 12)}; restamping`);
      j.restamps += 1; j.phase = 'locked'; save();
    }
    if (j.phase === 'locked') {
      const s = buildStamp(ctx, policy, { pin, baseSha: baseNow, pr: o.pr, title: info.title, allowRepoCommands: !!o.allowRepoCommands, now: j.date ? new Date(`${j.date}T12:00:00Z`) : now() });
      if ('code' in s) { setLock('stamping'); return fail([...lines], s, run); }
      lines.push(...s.lines);
      const commit = git(root, ['commit-tree', s.tree, '-p', pin, '-p', baseNow, '-m', `v${s.version} stamp: merge ${ctx.base} ${baseNow.slice(0, 12)} into #${o.pr} (land)`]).out;
      Object.assign(j, { stamp_commit: commit, stamp_tree: s.tree, base_sha: baseNow, version: s.version, date: j.date ?? now().toISOString().slice(0, 10), phase: 'stamped' });
      save();
      lines.push(`STAMP_VERSION: ${s.version}`, `STAMP_COMMIT: ${commit} tree=${s.tree}`);
    }
    if (j.phase === 'stamped') {
      const lease = j.last_pushed_head ?? pin;
      const f = setLock('pushing');
      if (f) return fail(lines, f, run);
      const push = git(root, ['push', '-q', `--force-with-lease=refs/heads/${j.branch}:${lease}`, 'origin', `${j.stamp_commit}:refs/heads/${j.branch}`]);
      if (!push.ok) {
        const remote = git(root, ['ls-remote', 'origin', `refs/heads/${j.branch}`]).out.split('\t')[0];
        if (remote !== j.stamp_commit) return fail(lines, { code: 'QUEUE_TRAIN_MOVED', message: `#${o.pr}'s branch is at ${remote?.slice(0, 12) || 'unknown'}, not ${lease.slice(0, 12)}: someone else pushed; land never overwrites it` }, run);
      }
      j.last_pushed_head = j.stamp_commit; j.phase = 'pushed'; save();
      setLock('waiting');
      lines.push(`PUSHED: ${j.stamp_commit} to ${j.branch} (lease ${lease.slice(0, 12)})`);
      if (o.noWait) return { ok: true, run, lines: [...lines, `NEXT: gstack-pr-wait ${o.pr} --until green && gstack-ship-queue land --pr ${o.pr}`] };
      if (!waitGreen(ctx, o.pr, o.waitTimeoutMin ?? 60)) return fail(lines, { code: 'QUEUE_NOT_READY', message: `checks did not go green on ${j.stamp_commit!.slice(0, 12)}`, fix: `fix the failure, then gstack-ship-queue land --pr ${o.pr} (it resumes)` }, run);
      continue;
    }
    if (j.phase === 'pushed') {
      if (info.headRefOid !== j.stamp_commit) return fail(lines, { code: 'QUEUE_TRAIN_MOVED', message: `#${o.pr}'s head is ${info.headRefOid.slice(0, 12)}, not the stamp commit ${j.stamp_commit?.slice(0, 12)}` }, run);
      const ci = ciAtHead(ctx, j.stamp_commit!);
      lines.push(`CI: ${ci.line}`);
      if (!ci.green) return { ok: !ci.line.startsWith('red'), run, lines: [...lines, `NEXT: gstack-pr-wait ${o.pr} --until green && gstack-ship-queue land --pr ${o.pr}`], failure: ci.line.startsWith('red') ? { code: 'QUEUE_NOT_READY', message: `a check failed on the stamp commit ${j.stamp_commit!.slice(0, 12)}` } : undefined };
      setLock('merging');
      const m = ctx.gh(['pr', 'merge', o.pr, '--squash', '--match-head-commit', j.stamp_commit!]);
      if (!m.ok) return fail(lines, { code: 'QUEUE_NOT_READY', message: `gh pr merge refused: ${(m.err ?? m.out).trim().slice(0, 200)}` }, run);
      j.phase = 'merged'; save();
    }
    if (j.phase === 'merged') {
      git(root, ['fetch', '-q', 'origin', ctx.base]);
      const main = git(root, ['rev-parse', `origin/${ctx.base}`]).out;
      const tree = git(root, ['rev-parse', `${main}^{tree}`]).out;
      const parent = git(root, ['rev-parse', `${main}^1`]).out;
      if (tree !== j.stamp_tree || parent !== j.base_sha) {
        j.phase = 'drift'; j.drift_main = main; save(); setLock('drift');
        return fail([...lines, `MAIN: ${main} tree=${tree} parent=${parent}`], { code: 'QUEUE_LAND_DRIFT', message: `origin/${ctx.base} ${main.slice(0, 12)} is not the stamped tree on ${j.base_sha?.slice(0, 12)} (a merge outside land slipped in)`, fix: `gstack-ship-queue land --pr ${o.pr} --repair opens the PR that gives the outside merge its own release; /ship and land it, which releases the lock` }, run);
      }
      j.phase = 'landed'; save();
      if (repairOf?.repair_pr === o.pr) writeJsonAtomic(path.join(root, landJournalRel(repairOf.pr)), { ...repairOf, phase: 'landed' });
      const rel = writeLock(root, lockSha, { released: true, by: holder, at: now().toISOString() });
      return { ok: true, run, lines: [...lines, `MERGED: #${o.pr} as ${main} (${j.version})`, `LANDED: origin/${ctx.base} tree ${tree} equals the stamped tree`, `LOCK: ${rel.ok ? 'released' : 'release push failed (the next land takes it over)'}`] };
    }
    if (j.phase === 'drift') return fail(lines, { code: 'QUEUE_LAND_DRIFT', message: 'a previous land of this PR found drift', fix: `gstack-ship-queue land --pr ${o.pr} --repair` }, run);
  }
}
