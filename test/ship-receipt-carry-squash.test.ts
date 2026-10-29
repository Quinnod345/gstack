/**
 * gstack-ship-receipt carry for a stacked child after its parent squash-merges (#3570,
 * docs/ship-policy.md#receipt-carry): the receipt reviewed the child's own range against the parent
 * branch, and that range must be HEAD's whole product diff against the base the PR now targets.
 * Anything else (the parent not landed, the child changed) fails closed.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { extractReceipt, renderReceiptBlock } from '../lib/ship-receipt';
import { cleanup, commit, makeFixtureRepo, runBin, write, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });
const receiptIn = (body: string) => extractReceipt(fs.readFileSync(body, 'utf8')).receipt!;
const carry = (repo: FixtureRepo, body: string) => runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--base', 'main']);
const SUB = "exports.add = (a, b) => a + b;\nexports.sub = (a, b) => a - b;\n";

/** main <- parent (lib/util.js) <- feature (lib/retry.js, its /ship receipt written against the parent branch). */
function stack(repo: FixtureRepo): { parent: string; child: string; body: string } {
  repo.git('checkout', '-q', '-b', 'parent');
  const parent = commit(repo, { 'lib/util.js': SUB }, 'parent: sub');
  repo.git('push', '-q', 'origin', 'parent');
  repo.git('checkout', '-q', 'feature');
  repo.git('reset', '-q', '--hard', parent);
  const child = commit(repo, { 'lib/retry.js': "exports.MAX_RETRIES = 4;\nexports.TIMEOUT_MS = 5000;\nexports.retry = (fn) => fn();\n" }, 'child: four retries');
  const body = path.join(repo.root, 'body.md');
  const w = runBin(repo, 'gstack-ship-receipt', ['write', '--pr', '8', '--base', 'parent', '--version', '1.0.0', '--session-kind', 'unattended', '--body', body]);
  expect(w.status).toBe(EXIT.ok);
  return { parent, child, body };
}
/** Land `files` on main as one commit (the parent's squash merge; none when the parent never lands), then an unrelated main commit, and merge main into the child. */
function landOnMain(repo: FixtureRepo, files: Record<string, string>): void {
  repo.git('checkout', '-q', 'main');
  if (Object.keys(files).length) {
    for (const [rel, text] of Object.entries(files)) write(repo.work, rel, text);
    repo.git('add', '-A'); repo.git('commit', '-qm', 'squash: parent (#7)');
  }
  write(repo.work, 'docs/README.md', '# docs after the parent\n');
  repo.git('add', '-A'); repo.git('commit', '-qm', 'main moves on');
  repo.git('push', '-q', 'origin', 'main');
  repo.git('checkout', '-q', 'feature');
  repo.git('merge', '-q', '--no-edit', 'origin/main');
}

describe('carry after a stack parent squash-merges (#3570)', () => {
  // Value: protects=a stacked child keeps its receipt when its parent squash-merges and main is merged in (gstack-evals#19
  // paid a full /ship for it); fails_when=carry compares the child's whole diff from the old fork point; seam=none;
  // no_claim=gh pr edit (--body stands in)
  test('the child carries when the range it was reviewed for is HEAD\'s whole product diff against main', () => {
    const repo = makeFixtureRepo(); repos.push(repo);
    const { child, body } = stack(repo);
    const reviewed = receiptIn(body).product_patch_id;
    landOnMain(repo, { 'lib/util.js': SUB });
    const head = repo.git('rev-parse', 'HEAD');
    const out = carry(repo, body);
    expect(out.status).toBe(EXIT.ok);
    expect(out.out).toContain(`CARRY: carried from ${child.slice(0, 12)} to ${head.slice(0, 12)}`);
    const r = receiptIn(body);
    expect(r.head).toBe(head);
    expect(r.carry!.reason).toBe('stack parent parent landed + base merge');
    expect(r.product_patch_id).toBe(reviewed);
  }, 90_000);

  // Value: protects=a receipt written before product_patch_id still carries while the parent branch resolves, and refuses by
  // name once it is gone; fails_when=the fallback reads another ref or carries with no reviewed diff; seam=none; no_claim=-
  test('without a recorded product patch-id the child range comes from origin/<parent>, and a deleted parent branch refuses', () => {
    const repo = makeFixtureRepo(); repos.push(repo);
    const { parent, child, body } = stack(repo);
    landOnMain(repo, { 'lib/util.js': SUB });
    const { product_patch_id: _dropped, head_tree: _tree, ...legacy } = receiptIn(body);
    fs.writeFileSync(body, renderReceiptBlock(legacy as any));
    expect(receiptIn(body).product_patch_id).toBeUndefined();
    repo.git('push', '-q', 'origin', '--delete', 'parent');
    repo.git('fetch', '-q', '--prune', 'origin');
    const gone = carry(repo, body);
    expect(gone.status).toBe(EXIT.refused);
    expect(gone.out).toContain('CARRY: refused (RECEIPT_CARRY_REFUSED)');
    expect(gone.err).toContain('the receipt was reviewed against parent, not main, and its reviewed product diff is unavailable');
    expect(receiptIn(body).head).toBe(child);
    repo.git('push', '-q', 'origin', `${parent}:refs/heads/parent`);
    repo.git('fetch', '-q', 'origin');
    expect(carry(repo, body).status).toBe(EXIT.ok);
  }, 90_000);

  // Value: protects=fail closed: a child changed after the parent merged, or a parent that never reached main, takes a fresh
  // /ship; fails_when=the comparison ignores the child's remainder or the parent's absence; seam=none; no_claim=-
  test('a product edit on the child after the merge, or a parent that never landed, refuses with RECEIPT_CARRY_PRODUCT_CHANGED', () => {
    const repo = makeFixtureRepo(); repos.push(repo);
    const { child, body } = stack(repo);
    landOnMain(repo, { 'lib/util.js': SUB });
    commit(repo, { 'lib/retry.js': "exports.MAX_RETRIES = 5;\nexports.TIMEOUT_MS = 5000;\nexports.retry = (fn) => fn();\n" }, 'child: five');
    const edited = carry(repo, body);
    expect(edited.status).toBe(EXIT.refused);
    expect(edited.out).toContain('CARRY: refused (RECEIPT_CARRY_PRODUCT_CHANGED)');
    expect(receiptIn(body).head).toBe(child);

    const other = makeFixtureRepo(); repos.push(other);
    const s = stack(other);
    landOnMain(other, {});
    const abandoned = carry(other, s.body);
    expect(abandoned.status).toBe(EXIT.refused);
    expect(abandoned.out).toContain('CARRY: refused (RECEIPT_CARRY_PRODUCT_CHANGED)');
    expect(abandoned.err).toContain('is not the one reviewed against parent (the parent has not fully landed on main');
    expect(receiptIn(s.body).head).toBe(s.child);
  }, 120_000);
});
