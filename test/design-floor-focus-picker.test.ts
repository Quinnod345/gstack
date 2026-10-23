import { describe, expect, test } from 'bun:test';
import { pickDesignFocusAll } from './fixtures/design-floor-focus-picker';

describe('pickDesignFocusAll: the seed-declared all-seven answer for the pending 0D focus menu', () => {
  const captured = require('./fixtures/design-floor-focus-36597762183.json');
  const q = () => structuredClone(captured.question);
  test('census 36597762183 pending menu selects the all-seven option', () => {
    expect(pickDesignFocusAll(q())).toBe(1);
  });
  test.each([
    ['a different title', (x: any) => { x.question = x.question.replace('Review all 7 design dimensions, or focus?', 'Which fixes should I apply?'); }],
    ['a non-narrowing alternative', (x: any) => { x.options[1].label = 'Approve every fix now'; }],
    ['two all-seven options', (x: any) => { x.options[1].label = 'All seven dimensions'; }],
    ['a bundled product approval', (x: any) => { x.question = x.question.replace('Net:', 'Also approve the CTA redesign.\nNet:'); }],
    ['a foreign plan context', (x: any) => { x.question = x.question.replace('plan-design-review of PLAN.md', 'plan-design-review of OTHER.md'); }],
    ['multi select', (x: any) => { x.multiSelect = true; }],
  ])('%s is not answered', (_name, mutate) => {
    const x = q(); mutate(x); expect(pickDesignFocusAll(x)).toBeNull();
  });
});

describe('pickDesignFocusAll: Step 0D in the template\'s own words (GSTA-65 focused trial)', () => {
  const captured = require('./fixtures/design-floor-focus-template-0d.json');
  const q = () => structuredClone(captured.question);
  test('the pending template-worded menu selects the all-seven option', () => {
    expect(pickDesignFocusAll(q())).toBe(1);
  });
  test("a menu titled 'Review focus' with no question mark selects the all-seven option", () => {
    expect(pickDesignFocusAll(structuredClone(require('./fixtures/design-floor-focus-review-focus.json').question))).toBe(1);
  });
  test.each([
    ['a question not about focus', (x: any) => { x.question = x.question.replace('Want me to focus on specific areas instead?', 'Want me to apply every fix now?'); }],
    ['a foreign plan', (x: any) => { x.question = x.question.replace('Marketing landing page plan on main.', 'Pricing page plan on main.'); }],
    ['a quoted plan name', (x: any) => { x.question = x.question.replace('Marketing landing page plan on main.', 'OTHER.md, not "Marketing landing page".'); }],
    ['an alternative that does not narrow', (x: any) => { x.options[1].label = 'Layout/hierarchy first'; }],
    ['a second question', (x: any) => { x.question = x.question.replace('Net:', 'Ready?\nNet:'); }],
    ['no focus in the title or question', (x: any) => { x.question = x.question.replace('Want me to focus on specific areas instead?', 'Which areas should I cover?'); }],
  ])('%s is not answered', (_name, mutate) => {
    const x = q(); mutate(x); expect(pickDesignFocusAll(x)).toBeNull();
  });
});
