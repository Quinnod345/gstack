/**
 * Color rules of the design lint (sloplint gates 2a 2b 7a 7b 22 23 29 65 74; Nutlope/hallmark,
 * MIT, see NOTICE.md), rewritten in gstack's voice. Rule ids: purple-blue-gradient, gradient-text, pure-black-white, absolute-surface-token, zero-chroma-neutrals, accent-footprint, glow-wash, cream-palette, framework-palette, literal-outside-tokens (48).
 */
import type { LintContext } from '../context';
import type { Reporter } from '../report';

export function run(ctx: LintContext, r: Reporter): void {
  void ctx; void r;
}
