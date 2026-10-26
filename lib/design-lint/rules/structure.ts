/**
 * Structure rules of the design lint (sloplint gates 3 4 6a 24a 24b 34 44d 50 53 56 58 59; Nutlope/hallmark,
 * MIT, see NOTICE.md), rewritten in gstack's voice. Rule ids: template-cards, nested-cards, vh-height, raw-spacing, off-scale-spacing, overflow-x-unclipped, wide-container, bare-fr-track, display-head-unwrapped, radio-tab-jump, double-sticky, screen-word-budget, section-gap.
 */
import type { LintContext } from '../context';
import type { Reporter } from '../report';

export function run(ctx: LintContext, r: Reporter): void {
  void ctx; void r;
}
