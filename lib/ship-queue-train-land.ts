/**
 * `train land --train <nonce> --pr <n>` (docs/ship-policy.md#train-land, GSTA-154 PR B): the merge step for
 * one slot of a stamped train (changelog_fragments). The train built S_1..S_k and gated S_k; slot i
 * publishes S_i exactly. With main's tree equal to S_(i-1)'s (slot 1: the train base), land commits S_i's
 * tree with parents [pin_i, main], labels the PR evals-no-debounce (a tool-made head gets no later push,
 * so the quiet window protects nothing), pushes under --force-with-lease=<branch>:<pin>, waits for the
 * PR's checks on that commit (CI runs live at the slot until GSTA-156's reuse is on main), merges with
 * --match-head-commit and confirms main's tree is S_i. Any other main is the freeze path
 * (QUEUE_TRAIN_TREE_MISMATCH), as for verify. Journaled beside the train record; a rerun resumes.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ciAtHead, type QueueContext } from './ship-queue';
import { git, writeJsonAtomic } from './ship-queue-gate';
import { waitChecks } from './ship-queue-land';
import { bindShippedReceipt } from './ship-receipt-depth';
import { checkRun, prInfo } from './ship-queue-train-github';
import { activeFreeze, attemptsOf, trainFile } from './ship-queue-train-record';
import { fetchBase, fetchTrainBranch, findTrain, frozenLines, nextFor, outFailed, outOk, outPending, outRefused, trainEnv, type TrainOut } from './ship-queue-train';
import { confirmMerged, stopped } from './ship-queue-train-verify';

const Q = 'gstack-ship-queue';
interface SlotJournal { schema_version: 1; pr: string; pin: string; stamp_commit: string; base: string }

export async function trainLand(ctx: QueueContext, o: { train: string; pr: string; noWait?: boolean; timeoutMin?: number }): Promise<TrainOut> {
  const fetchErr = fetchBase(ctx);
  const env = trainEnv(ctx);
  if ('code' in env) return outRefused(env, [], 'none', 'none');
  if (fetchErr) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: fetchErr }, [], 'none', 'none');
  const t = findTrain(env, o.train);
  if (!t) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: `no train record ${o.train} here or in refs/notes/gstack-trains` }, [], `${Q} train status`, 'none');
  const run = trainFile(t.nonce);
  const i = t.slots.findIndex(s => s.pr === o.pr);
  if (i < 0) return outRefused({ code: 'QUEUE_GATE_MISSING', message: `train ${t.nonce} does not include #${o.pr}` }, [], nextFor(t), run);
  if (!t.stamped) return outRefused({ code: 'QUEUE_GATE_MISSING', message: `train ${t.nonce} was built without stamped prefixes; merge it with the slot stamp and ${Q} verify` }, [], `${Q} verify --pr ${o.pr} --train ${t.nonce}`, run);
  const gate = attemptsOf(t).filter(a => a.purpose !== 'bisect').at(-1);
  if (gate?.outcome !== 'GREEN' || !['green', 'merging', 'merged'].includes(t.state)) return outRefused({ code: 'QUEUE_GATE_MISSING', message: `train ${t.nonce} has no green record (state ${t.state}, last gate ${gate?.outcome ?? 'none'})` }, [], nextFor(t), run);
  const check = checkRun(ctx, t.head, env.train.full_gate_check);
  if (check?.conclusion !== 'success') return outRefused({ code: 'QUEUE_GATE_MISSING', message: `no successful ${env.train.full_gate_check} check run on the train head ${t.head.slice(0, 12)}` }, [], `${Q} train verdict --train ${t.nonce}`, run);
  if (!fetchTrainBranch(env, t)) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: `the train's prefix commits are not here and ${t.branch} could not be fetched` }, [], `${Q} train status --train ${t.nonce}`, run);
  const freeze = activeFreeze(env.repo.keys);
  if (freeze && freeze.repair?.train !== t.nonce) return outRefused({ code: 'QUEUE_TRAIN_FROZEN', message: `the queue is frozen (${freeze.reason}); only the admitted repair train merges` }, frozenLines(freeze), `${Q} train build --repair --prs <repair-pr>@<sha>`, run);

  const root = ctx.repoRoot;
  const s = t.stamped[i]!;
  const pred = i === 0 ? { index: 0, tree: t.prefixes[0]!.tree } : t.stamped[i - 1]!;
  const pin = t.slots[i]!.head;
  const mainNow = () => { fetchBase(ctx); const sha = git(root, ['rev-parse', `${env.remote}/${ctx.base}`]).out; return { sha, tree: git(root, ['rev-parse', `${sha}^{tree}`]).out }; };
  const lines = [`TRAIN_LAND: ${t.nonce} slot ${i + 1}/${t.slots.length} #${o.pr} pin ${pin} -> S${s.index} v${s.version} tree ${s.tree}`];
  let main = mainNow();
  if (main.tree === s.tree) return confirmMerged(env, t, o.pr, main.sha, s.index, [...lines, `main: ${main.sha} is S${s.index} exactly`]);
  if (main.tree !== pred.tree) return stopped(env, t, 'QUEUE_TRAIN_TREE_MISMATCH', `main ${main.sha.slice(0, 12)} is neither S${pred.index} nor S${s.index} exactly`, main.sha, lines, true);

  const file = path.join(path.dirname(run), `land-${o.pr}.json`);
  let j: SlotJournal | null = null;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')) as SlotJournal; } catch { j = null; }
  const info = prInfo(ctx, o.pr);
  if ('error' in info) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: info.error }, lines, `${Q} train land --train ${t.nonce} --pr ${o.pr}`, run);
  if (info.isCrossRepository) return outRefused({ code: 'QUEUE_TRAIN_UNTRUSTED', message: `#${o.pr} is a fork head; train land pushes only crew branches` }, lines, 'none', run);
  if (!j || j.base !== main.sha) {
    if (info.headRefOid !== pin && info.headRefOid !== j?.stamp_commit) return stopped(env, t, 'QUEUE_TRAIN_MOVED', `#${o.pr}'s head is ${info.headRefOid.slice(0, 12)}, not its pin ${pin.slice(0, 12)}`, main.sha, lines, true);
    const shipped = bindShippedReceipt(root, `refs/remotes/${env.remote}/${ctx.base}`, info.body, o.pr, [pin]);
    lines.push(shipped.line, ...(shipped.depthLine ? [shipped.depthLine] : []));
    if (!shipped.ok) return outRefused({ code: shipped.code, message: shipped.message }, lines, `#${o.pr}'s lane runs /ship at its pin and READYs again`, run);
    const commit = git(root, ['commit-tree', s.tree, '-p', pin, '-p', main.sha, '-m', `v${s.version} stamp: train ${t.nonce} S${s.index} (#${o.pr})`]).out;
    const label = ctx.gh(['pr', 'edit', o.pr, '--add-label', 'evals-no-debounce']);
    lines.push(`LABEL: evals-no-debounce ${label.ok ? 'added' : `not added (${(label.err ?? label.out).trim().slice(0, 80)}); the 10-minute quiet window applies`}`);
    const lease = j?.stamp_commit && info.headRefOid === j.stamp_commit ? j.stamp_commit : pin;
    const push = git(root, ['push', '-q', `--force-with-lease=refs/heads/${info.headRefName}:${lease}`, env.remote, `${commit}:refs/heads/${info.headRefName}`]);
    if (!push.ok) return stopped(env, t, 'QUEUE_TRAIN_MOVED', `#${o.pr}'s branch moved off ${lease.slice(0, 12)} before the stamp push; train land never overwrites it`, main.sha, lines, true);
    j = { schema_version: 1, pr: o.pr, pin, stamp_commit: commit, base: main.sha };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomic(file, j);
    lines.push(`PUSHED: ${commit} (tree S${s.index}, parents [pin, main ${main.sha.slice(0, 12)}]) to ${info.headRefName}`);
    const next = `gstack-pr-wait ${o.pr} --until green && ${Q} train land --train ${t.nonce} --pr ${o.pr}`;
    if (o.noWait) return outPending({ code: 'QUEUE_NOT_READY', message: `checks run on the stamp commit ${commit.slice(0, 12)}` }, lines, next, run);
    waitChecks(ctx, commit, o.timeoutMin ?? 60);
  }
  const head = prInfo(ctx, o.pr);
  if ('error' in head || head.headRefOid !== j.stamp_commit) return stopped(env, t, 'QUEUE_TRAIN_MOVED', `#${o.pr}'s head is not the stamp commit ${j.stamp_commit.slice(0, 12)}`, main.sha, lines, true);
  const ci = ciAtHead(ctx, j.stamp_commit);
  lines.push(`CI: ${ci.line}`);
  if (!ci.green) return outPending({ code: 'QUEUE_NOT_READY', message: `checks on the stamp commit ${j.stamp_commit.slice(0, 12)} are not green` }, lines, `gstack-pr-wait ${o.pr} --until green && ${Q} train land --train ${t.nonce} --pr ${o.pr}`, run);
  main = mainNow();
  if (main.sha !== j.base) return stopped(env, t, 'QUEUE_TRAIN_TREE_MISMATCH', `main moved to ${main.sha.slice(0, 12)} during the slot's checks (stamped on ${j.base.slice(0, 12)})`, main.sha, lines, true);
  const m = ctx.gh(['pr', 'merge', o.pr, '--squash', '--match-head-commit', j.stamp_commit]);
  if (!m.ok) return outFailed({ code: 'QUEUE_NOT_READY', message: `gh pr merge refused: ${(m.err ?? m.out).trim().slice(0, 200)}` }, lines, `${Q} train land --train ${t.nonce} --pr ${o.pr}`, run);
  main = mainNow();
  if (main.tree !== s.tree) return stopped(env, t, 'QUEUE_TRAIN_TREE_MISMATCH', `after the merge main ${main.sha.slice(0, 12)} is not S${s.index} exactly`, main.sha, lines, true);
  return confirmMerged(env, t, o.pr, main.sha, s.index, [...lines, `MERGED: #${o.pr} as ${main.sha}; main's tree is S${s.index} exactly`]);
}
