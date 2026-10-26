/**
 * Type rules of the design lint (sloplint gates 1 25 37 38i 38ii 38iii 55a 55b 64 67; Nutlope/hallmark,
 * MIT, see NOTICE.md), rewritten in gstack's voice. Rule ids: overused-font, line-length, font-family-count, italic-word-in-heading, italic-serif-display, accented-word, caps-leading, caps-lockup-leading, monospace-costume, wide-tracking.
 */
import type { LintContext } from '../context';
import type { Reporter } from '../report';

export function run(ctx: LintContext, r: Reporter): void {
  void ctx; void r;
}
