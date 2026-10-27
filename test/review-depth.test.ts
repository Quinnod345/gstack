import { describe, test, expect } from 'bun:test';
import { classifyDiff, classifyPath, nextStep, planReview, scanNumbers, FULL_PASS_CAP, type PlanInput } from '../lib/review-depth';

const none = scanNumbers({});
const base = (o: Partial<PlanInput>): PlanInput => ({ paths: ['src/app.ts'], scope: { SCOPE_BACKEND: 'true', SCOPE_STATE_MACHINE: 'false' }, gateTagged: 0, diffLines: 120, history: { fullPasses: 0, last: 'none' }, numbers: none, ...o });
const roles = (p: ReturnType<typeof planReview>) => p.dispatches.map(d => `${d.role}:${d.name}:${d.effort}`);

describe('classifyPath: agent-read markdown is code', () => {
  test.each([
    ['README.md', 'docs'], ['CHANGELOG.md', 'docs'], ['docs/howto-x.md', 'docs'], ['TODOS.md', 'docs'],
    ['ship/SKILL.md.tmpl', 'code'], ['review/SKILL.md', 'code'], ['ship/sections/review-army.md', 'code'], ['scripts/resolvers/review-army.ts', 'code'],
    ['docs/review-policy.md', 'code'], ['autoplan/DRIVER.md.tmpl', 'code'], ['captain/templates/brief.md', 'code'], ['AGENTS.md', 'code'], ['review/specialists/security.md', 'code'],
    ['test/review-depth.test.ts', 'tests'], ['src/a.test.ts', 'tests'], ['pkg/x_test.go', 'tests'], ['test/fixtures/a.json', 'tests'],
    ['lib/review-depth.ts', 'code'], ['package.json', 'code'],
  ])('%s -> %s', (p, c) => expect(classifyPath(p)).toBe(c as any));
});

describe('classifyDiff', () => {
  test('docs only stays docs', () => expect(classifyDiff({ paths: ['README.md', 'docs/a.md'], gateTagged: null }).class).toBe('docs'));
  test('a skill-template-only diff is code, not docs', () => expect(classifyDiff({ paths: ['ship/SKILL.md.tmpl'], gateTagged: 0 }).class).toBe('code'));
  test('mixed diff takes the most restrictive class', () => {
    expect(classifyDiff({ paths: ['README.md', 'test/a.test.ts'], gateTagged: 0 }).class).toBe('tests');
    expect(classifyDiff({ paths: ['README.md', 'lib/a.ts'], gateTagged: 0 }).class).toBe('code');
  });
  test('a scope error fails closed to code', () => expect(classifyDiff({ paths: ['README.md'], scope: { SCOPE_ERROR: 'unmatched' }, gateTagged: 0 }).class).toBe('code'));
  test('code with the gate scan unavailable fails closed to gate', () => expect(classifyDiff({ paths: ['lib/a.ts'], gateTagged: null }).class).toBe('gate'));
  test.each([
    [{ scope: { SCOPE_AUTH: 'true' } }], [{ scope: { SCOPE_MIGRATIONS: 'true' } }], [{ gateTagged: 2 }],
    [{ paths: ['lib/a.ts', '.github/workflows/ci.yml'] }], [{ paths: ['lib/a.ts', 'lib/credentials.ts'] }], [{ deleted: ['lib/old.ts'] }],
  ])('gate signal %j raises code to gate', (o: any) => expect(classifyDiff({ paths: ['lib/a.ts'], gateTagged: 0, ...o }).class).toBe('gate'));
  test('docs never become gate from code-only signals', () => expect(classifyDiff({ paths: ['README.md'], gateTagged: null, deleted: ['docs/old.md'] }).class).toBe('docs'));
});

describe('nextStep: the transition table', () => {
  test('pass 1 is full', () => expect(nextStep({ fullPasses: 0, last: 'none' }).step).toBe('full'));
  test('no edits is done', () => expect(nextStep({ fullPasses: 1, last: 'full' }).step).toBe('done'));
  test('a fixed blocker earns full pass 2', () => expect(nextStep({ fullPasses: 1, last: 'full', fixedBlocking: true }).step).toBe('full'));
  test('below-floor fixes earn one light fix-check', () => expect(nextStep({ fullPasses: 1, last: 'full', fixedBelow: true })).toMatchObject({ step: 'fix-check', effort: 'light' }));
  test('a fix touching gate code earns a full pass instead of a fix-check', () => expect(nextStep({ fullPasses: 1, last: 'full', fixedBelow: true, touchedGate: true }).step).toBe('full'));
  test('at the full-pass cap a fixed blocker gets a fix-check', () => expect(nextStep({ fullPasses: FULL_PASS_CAP, last: 'full', fixedBlocking: true }).step).toBe('fix-check'));
  test('at the cap a gate-touching fix gets a full-effort fix-check', () => expect(nextStep({ fullPasses: FULL_PASS_CAP, last: 'full', fixedBlocking: true, touchedGate: true })).toMatchObject({ step: 'fix-check', effort: 'full' }));
  test('a blocker open at the cap stops', () => expect(nextStep({ fullPasses: FULL_PASS_CAP, last: 'full', blockingOpen: true }).step).toBe('stop'));
  test('a blocker open with no fix stops', () => expect(nextStep({ fullPasses: 1, last: 'full', blockingOpen: true }).step).toBe('stop'));
  test('a fix-check that finds a blocker stops, never a third full pass', () => {
    expect(nextStep({ fullPasses: 1, last: 'fix-check', blockingOpen: true }).step).toBe('stop');
    expect(nextStep({ fullPasses: 2, last: 'fix-check', fixedBlocking: true }).step).toBe('stop');
  });
  test('a clean fix-check is done', () => expect(nextStep({ fullPasses: 1, last: 'fix-check' }).step).toBe('done'));
});

describe('scanNumbers', () => {
  test('finds claims and fingerprints them', () => {
    const a = scanNumbers({ 'docs/bench.md': ['Median dropped 48% to 1.2s', 'no numbers here'] });
    expect(a).toMatchObject({ publishes: true, claims: 1 });
    expect(scanNumbers({ 'docs/bench.md': ['Median dropped 47% to 1.2s'] }).fingerprint).not.toBe(a.fingerprint);
  });
  test('versions, dates, issue and step numbers and plain prose are not claims', () => expect(scanNumbers({ 'CHANGELOG.md': ['## [1.91.283.0] - 2026-10-27', 'Fixes the ship loop (#3516), see Step 9.4 and rule 23.'] }).publishes).toBe(false));
  test.each([
    ['the smallest two-sided p with 16 clusters is 2 x 0.5^6 = 0.031'],
    ['the miss split is 10/52'], ['p falls to 3.05e-5'], ['median 1.4 passes per PR'], ['Hot-memory hits: 10 of 62'],
  ])('a bare numeric claim counts: %s', line => expect(scanNumbers({ 'docs/comparing-runs.md': [line] }).publishes).toBe(true));
});

describe('planReview', () => {
  test('docs class: core only, no outside voice', () => {
    const p = planReview(base({ paths: ['README.md'], scope: {}, gateTagged: null, diffLines: 300 }));
    expect(p.class).toBe('docs');
    expect(p.dispatches).toEqual([]);
  });
  test('docs class with numeric claims keeps the outside voice', () => {
    const p = planReview(base({ paths: ['docs/bench.md'], scope: {}, numbers: scanNumbers({ 'docs/bench.md': ['3x faster'] }) }));
    expect(roles(p)).toEqual(['outside-voice:outside-voice:host']);
  });
  test('tests class: testing specialist only', () => {
    const p = planReview(base({ paths: ['test/a.test.ts'], scope: { SCOPE_TESTS: 'true' } }));
    expect(roles(p)).toEqual(['specialist:testing:light']);
  });
  test('code class pass 1: specialists light, adversarial full, outside voice', () => {
    const p = planReview(base({}));
    expect(roles(p)).toEqual(['specialist:testing:light', 'specialist:maintainability:light', 'specialist:security:light', 'specialist:performance:light', 'specialist:simplification:light', 'adversarial-native:adversarial:full', 'outside-voice:outside-voice:host']);
  });
  test('gate class forces red team and ignores hit-rate gating', () => {
    const p = planReview(base({ gateTagged: 1, gated: ['security'] }));
    expect(roles(p)).toContain('red-team:red-team:full');
    expect(roles(p)).toContain('specialist:security:light');
  });
  test('code class honours hit-rate gating and small-diff skip', () => {
    expect(roles(planReview(base({ gated: ['simplification'] })))).not.toContain('specialist:simplification:light');
    expect(planReview(base({ diffLines: 20 })).dispatches.filter(d => d.role === 'specialist')).toEqual([]);
  });
  test('pass 2 reruns the army on the range but not the adversarial or outside voice', () => {
    const p = planReview(base({ history: { fullPasses: 1, last: 'full', fixedBlocking: true } }));
    expect(p.next.step).toBe('full');
    expect(roles(p).some(r => r.startsWith('outside-voice') || r.startsWith('adversarial'))).toBe(false);
  });
  test('a fix-check is one light dispatch', () => {
    expect(roles(planReview(base({ history: { fullPasses: 1, last: 'full', fixedBelow: true } })))).toEqual(['fix-check:fix-check:light']);
  });
  test('changed numeric claims rerun only the outside voice', () => {
    const numbers = scanNumbers({ 'docs/bench.md': ['3x faster'] });
    const p = planReview(base({ numbers, reviewedNumbers: 'old', history: { fullPasses: 1, last: 'full', fixedBelow: true } }));
    expect(roles(p)).toEqual(['fix-check:fix-check:light', 'outside-voice:outside-voice (numbers changed):host']);
  });
  test('tiers off renders every role at the host default', () => {
    expect(planReview(base({ tiers: false })).dispatches.every(d => d.effort === 'host')).toBe(true);
  });
  test('done dispatches nothing', () => expect(planReview(base({ history: { fullPasses: 1, last: 'full' } })).dispatches).toEqual([]));
});
