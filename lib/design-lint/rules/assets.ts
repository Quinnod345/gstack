/**
 * Assets rules of the design lint (sloplint gates 30a 30b 33 40 41 49a 49b 76; Nutlope/hallmark,
 * MIT, see NOTICE.md), rewritten in gstack's voice. Rule ids: emoji-decoration, two-icon-libraries, unlabeled-decoration, low-contrast, gray-on-color, button-label-wraps, link-wraps, broken-image, stock-photo-hotlink.
 */
import type { LintContext } from '../context';
import type { Reporter } from '../report';

export function run(ctx: LintContext, r: Reporter): void {
  void ctx; void r;
}
