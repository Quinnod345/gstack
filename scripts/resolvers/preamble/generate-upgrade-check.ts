import type { TemplateContext } from '../types';

/**
 * Steady-state STATUS-line rules only (token-reduction Phase 2). The upgrade
 * flow, feature discovery, and every one-time onboarding prompt moved into
 * bin/gstack-skill-start's instruction-emission layer — their text is emitted
 * at runtime only when the gate fires, wrapped in GSTACK_INSTRUCTION blocks
 * the fence prose scopes and the model follows.
 */
export function generateUpgradeCheck(ctx: TemplateContext): string {
  return `If \`PROACTIVE\` is \`false\` or \`off\`, suggest no skill, even by asking; if \`core\` (default), only /office-hours, /review, /qa and /ship; \`all\` or \`true\`: any.

If \`SKILL_PREFIX\` is \`true\`, suggest \`/gstack-*\` names; disk paths stay \`${ctx.paths.skillRoot}/[skill-name]/SKILL.md\`.`;
}
