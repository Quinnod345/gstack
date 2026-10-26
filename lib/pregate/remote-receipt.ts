/**
 * pregate remote receipt — a remote_gate receipt from a predecessor tree.
 *
 * The `pregate.json/remote_gate` obligation clears on the gate's own
 * `PREGATE_REMOTE: tree=… tests=… failed=…` line, and that tree had to be the
 * tree pregate.json recorded. A repo whose full gate ran ahead of the ship
 * ("gate ahead of your turn": the gate tested commit G, then /ship's restamp
 * moved the version files) could never clear the obligation with that run:
 * the stamp changed the tree, so every PR paid a second full gate on the
 * stamped head (gbrain #7621, #7674, #7681: 17–37 minutes, 64–128 vCPU each).
 *
 * `substituteStampOnlyTree` is the one accepted substitution. The gated tree
 * and the head tree are diffed path by path, and every differing file is
 * classified by the tree receipt's own rule (lib/tree-receipt.ts
 * `classifyFile`: the repo's `stamp_files` allowlist and `stamp_patterns`
 * templates from `.gstack/ship-policy.json` on the base branch, beside the
 * built-in version-file, manifest-version, lockfile-root-version and
 * changelog-heading forms). The receipt is accepted for the head only when
 * every differing file is a stamp; a path outside the rule, or a stamp path
 * whose hunk is not the exact old → new rewrite, refuses it with the path
 * named. There is no second stamp list here: a verdict this module reaches is
 * the verdict `gstack-tree-receipt` reaches on the same pair.
 *
 * Both trees must be objects in this repository (the gated tree is the
 * gated commit's tree once that commit is fetched; the head tree is the
 * working-tree fingerprint `bin/gstack-wtree` wrote). A tree that is not
 * here cannot be diffed and is refused, never trusted.
 */
import { spawnSync } from 'node:child_process';
import { parseUnifiedDiff, versionAtRef } from '../restamp';
import { isUnavailable, loadPolicyFromBase, SHIP_POLICY_PATH } from '../ship-policy';
import { classifyFile } from '../tree-receipt';

/** What `clear` records when a remote_gate receipt from a stamp-only predecessor tree is accepted for the head. */
export interface StampOnlySubstitution {
  /** The tree the remote gate tested (its PREGATE_REMOTE line). */
  gated_tree: string;
  /** The tree pregate.json recorded, which the receipt is accepted for. */
  accepted_for: string;
  /** The policy that classed the differing files: `origin/<base>@<sha>:.gstack/ship-policy.json`, or the defaults when the base has none. */
  policy: string;
  /** Every path that differs between the two trees, with the tree receipt rule that classed it as a stamp. */
  files: Array<{ path: string; rule: string }>;
}

export type SubstitutionResult = { substitution: StampOnlySubstitution } | { problem: string; fix: string };

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? (r.stdout ?? '').replace(/\n$/, '') : null;
}

/** The branch a pregate.json `base` field (`origin/<branch>@<sha>`) names; null when the field is absent or unreadable. */
export function baseBranchOf(base: string | undefined): string | null {
  const m = /^(?:origin\/)?(.+?)@[0-9a-f]+$/.exec(base ?? '');
  return m ? m[1]! : null;
}

/**
 * Whether `gatedTree` differs from `headTree` only as a stamp does, under the
 * base branch's ship policy. Returns the substitution to record, or the
 * problem (the first clause is the plain tree mismatch, so a caller's message
 * reads the same as before) with the fix.
 */
export function substituteStampOnlyTree(repoRoot: string, base: string, gatedTree: string, headTree: string): SubstitutionResult {
  const short = (t: string) => t.slice(0, 12);
  const mismatch = `the remote gate tested tree ${short(gatedTree)}, not ${short(headTree)}`;
  const rerun = `rerun the remote gate on tree ${short(headTree)} and pass its output with --receipt, or run gstack-pregate --stage tests --remote --spend-cap <usd> --allow-repo-commands`;
  for (const [label, tree] of [['gated', gatedTree], ['head', headTree]] as const) {
    if (git(repoRoot, ['cat-file', '-t', tree]) !== 'tree') {
      return { problem: `${mismatch}; the ${label} tree ${short(tree)} is not an object in this repository, so the two trees cannot be compared`, fix: label === 'gated' ? `fetch the commit the remote gate tested (git fetch origin <its sha>) so its tree is here, then clear again; or ${rerun}` : rerun };
    }
  }
  const loaded = loadPolicyFromBase(repoRoot, base);
  if (isUnavailable(loaded)) return { problem: `${mismatch}; the ship policy on origin/${loaded.base} could not be read (${loaded.detail}), so the stamp rule is unknown`, fix: `git fetch origin ${loaded.base}, then clear again; or ${rerun}` };
  if (loaded.errors.length) return { problem: `${mismatch}; ${SHIP_POLICY_PATH} on ${loaded.source.label} is invalid (${loaded.errors.map(e => `${e.path}: ${e.message}`).join('; ')}), so the stamp rule is unknown`, fix: `fix the policy on the base branch (gstack-ship-policy validate), then clear again; or ${rerun}` };
  const gv = versionAtRef(repoRoot, gatedTree);
  const cv = versionAtRef(repoRoot, headTree);
  const versionRel = 'rel' in cv ? cv.rel : 'rel' in gv ? gv.rel : 'VERSION';
  const oldV = 'version' in gv ? gv.version : null;
  const newV = 'version' in cv ? cv.version : null;
  const diff = git(repoRoot, ['diff', '--unified=0', '--no-color', '--no-ext-diff', gatedTree, headTree]);
  if (diff === null) return { problem: `${mismatch}; git diff ${short(gatedTree)} ${short(headTree)} failed`, fix: rerun };
  const files = parseUnifiedDiff(diff).map(f => classifyFile(repoRoot, f, gatedTree, headTree, loaded.policy, versionRel, oldV, newV));
  if (!files.length) return { problem: `${mismatch}; the trees differ but git diff lists no file (a mode-only or submodule change)`, fix: rerun };
  const changed = files.filter(f => f.verdict === 'changed');
  if (changed.length) {
    const named = changed.map(c => `${c.path} (${c.rule}${c.residual ? `: ${c.residual}` : ''}${c.line ? `, line ${c.line}` : ''})`).join('; ');
    return { problem: `${mismatch}, and the trees differ beyond the stamp rule of ${loaded.source.label}: ${named}`, fix: `${rerun}; a receipt from a predecessor tree is accepted only when every differing path is a stamp (stamp_files, stamp_patterns and the built-in version, manifest, lockfile and changelog forms; see docs/pregate.md#remote-gate-stamp-only)` };
  }
  return { substitution: { gated_tree: gatedTree, accepted_for: headTree, policy: loaded.source.label, files: files.map(f => ({ path: f.path, rule: f.rule })) } };
}

/** One line naming the substitution, for `clear`'s output and `verify`'s ok line. */
export function describeSubstitution(s: StampOnlySubstitution): string {
  return `gated tree ${s.gated_tree.slice(0, 12)} accepted for tree ${s.accepted_for.slice(0, 12)} under ${s.policy}; stamp-only: ${s.files.map(f => `${f.path} (${f.rule})`).join(', ')}`;
}
