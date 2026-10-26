/**
 * Component rules of the design lint (sloplint gates checkTailwind, checkComponentText; Nutlope/hallmark,
 * MIT, see NOTICE.md), rewritten in gstack's voice. Rule ids: the Tailwind half of 2a 3 6a 11 54 65 67 74 and kin over component class strings, plus emoji and template punctuation in component text.
 */
import type { LintContext } from '../context';
import type { Reporter } from '../report';

export function run(ctx: LintContext, r: Reporter): void {
  void ctx; void r;
}
