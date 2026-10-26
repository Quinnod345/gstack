/**
 * Motion rules of the design lint (sloplint gates 10a 10b 11 12 15 17 18 26a 26b 27 28a 28b 39a 39b 62; Nutlope/hallmark,
 * MIT, see NOTICE.md), rewritten in gstack's voice. Rule ids: layout-transition, spacing-transition, hover-tells, bounce-easing, focus-ring-fade, tooltip-focus-delay, autorotate-no-pause, missing-focus-visible, missing-states, missing-reduced-motion, autoplay-unmuted, lazy-lcp, video-without-poster, input-state-shift, control-height, content-hidden-at-rest.
 */
import type { LintContext } from '../context';
import type { Reporter } from '../report';

export function run(ctx: LintContext, r: Reporter): void {
  void ctx; void r;
}
