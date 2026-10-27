/**
 * Craft resolvers (scripts/resolvers/design-craft.ts) shared by /design-review's
 * craft audit and /plan-design-review.
 *
 * Value: protects=DESIGN_CRAFT_RULE returns a craft paragraph with its bullets and fails generation on a missing or renamed lead; fails_when=the lookup returns '' or the first paragraph instead of throwing, or drops bullets; why_new=only the freshness golden exercises the resolver, and no test reaches its throw paths; seam=none; no_claim=agent use of the rendered rules (behavioral, no paid case)
 * Value: protects=design-review and plan-design-review render the same five Persuade checks; fails_when=either surface drops or hand-forks the {{DESIGN_PERSUADE_CHECKS}} block; why_new=carve-guards checks one phrase in design-review only, nothing checks plan-design-review; seam=none; no_claim=that an agent applies the checks (eval)
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { DESIGN_CRAFT_RULE, DESIGN_PERSUADE_CHECKS } from '../scripts/resolvers/design-craft';
import type { TemplateContext } from '../scripts/resolvers/types';

const ROOT = path.resolve(import.meta.dir, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), 'utf-8');
const ctx = { skillName: 'design-review', tmplPath: 'design-review/sections/craft-audit.md.tmpl' } as TemplateContext;

describe('craft resolvers', () => {
  test('DESIGN_CRAFT_RULE renders the craft paragraph with its bullets; a missing or unknown lead fails generation', () => {
    const motion = DESIGN_CRAFT_RULE(ctx, ['Motion']);
    expect(motion).toStartWith('**Motion.**');
    expect(motion).toContain("Never an unthrottled `window.addEventListener('scroll')`");
    expect(motion).toContain('`min-height: 100dvh`, not `100vh`.');
    expect(motion).not.toContain('\n\n');
    expect(DESIGN_CRAFT_RULE(ctx, ['Claims come from the user'])).toStartWith('**Claims come from the user, never from you.**');
    expect(read('design-html', 'sections', 'craft.md')).toContain(motion);
    expect(() => DESIGN_CRAFT_RULE(ctx, ['No such lead'])).toThrow('No such lead');
    expect(() => DESIGN_CRAFT_RULE(ctx, ['Claims'])).toThrow('0 paragraphs');
    expect(() => DESIGN_CRAFT_RULE(ctx, ['Mot'])).toThrow('need exactly one');
    expect(() => DESIGN_CRAFT_RULE(ctx, [])).toThrow('requires the bold lead');
    expect(() => DESIGN_CRAFT_RULE(ctx)).toThrow('requires the bold lead');
  });

  test('design-review and plan-design-review carry the same five Persuade checks', () => {
    const checks = DESIGN_PERSUADE_CHECKS(ctx);
    expect(checks.split('\n').map(l => l.slice(0, 3))).toEqual(['1. ', '2. ', '3. ', '4. ', '5. ']);
    expect(read('design-review', 'sections', 'craft-audit.md')).toContain(checks);
    expect(read('plan-design-review', 'sections', 'review-sections.md')).toContain(checks);
  });

  test('the design-review craft audit settles each check outcome and exception kind, and keeps the saved page private', () => {
    const audit = read('design-review', 'sections', 'craft-audit.md');
    expect(audit).toContain('line is one category 9 finding under that id');
    expect(audit).toContain('no `CRAFT_RESULT` line (framework source');
    expect(audit).toContain('or a mount-node shell: say the check was unavailable for that page and judge the tells below by eye');
    expect(audit).toContain('add `--accepted` with that screen\'s finalized.json');
    expect(audit).toContain('a `CRAFT_ACCEPTED` line is a finding the user accepted, listed with its reason, not filed again, except `needs-proof` and `lorem`');
    expect(audit).toContain('After a `cannot use exceptions` warning, file every line.');
    expect(audit).toContain('Never mark or cut a claim as a rule or fix says: defer it and ask for the proof.');
    expect(audit).toContain('never copy it to the report directory');
  });
});
