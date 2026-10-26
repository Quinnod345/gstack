/**
 * Result codes for gstack-pr-wait (lib/pr-wait.ts). Kept beside
 * lib/result-codes.ts, which spreads this table into RESULT_CODES, so the owner
 * module stays within the module-size ratchet; the same rules apply: one stable
 * docs/troubleshooting.md anchor, a summary and a fix clause each.
 */
import type { ResultCode } from './result-codes';

export const PR_WAIT_RESULT_CODES = {
  PR_WAIT_BLOCKED: {
    anchor: 'pr-wait-blocked',
    summary: 'the --until condition cannot be met without action: a required check failed, the branch conflicts with its base, the PR closed, ready is blocked by unresolved threads or a BEHIND branch, or GitHub stayed unreachable',
    fix: 'act on the event lines above it (fix the check, update or rebase the branch, resolve the threads), push, and start gstack-pr-wait again',
  },
  PR_WAIT_REFUSED: {
    anchor: 'pr-wait-refused',
    summary: 'the watcher did not start',
    fix: 'pass a PR number or URL the current gh login can read (--repo owner/name when the checkout is not that repository), or stop the watcher the line names before starting another for the same PR',
  },
} as const satisfies Record<string, ResultCode>;
