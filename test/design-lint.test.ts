/**
 * The design lint's core contract: parsers, the rule table, the output lines,
 * exit codes and waivers. Rule families have their own files
 * (test/design-lint-<family>.test.ts); the render tier is
 * test/design-lint-render.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildTokens, parseCss, pxOf, resolveVars } from '../lib/design-lint/css';
import { contrastRatio, parseColor, srgbToOklch } from '../lib/design-lint/color';
import { getAttr, parseDoc, plainText } from '../lib/design-lint/html';
import { lint, formatResult } from '../lib/design-lint/index';
import { Reporter, exitCodeOf, finalize, formatFinding, formatSummary, summarize } from '../lib/design-lint/report';
import { RULES, RULE_IDS } from '../lib/design-lint/rules/ids';
import { FAMILIES } from '../lib/design-lint/rules';
import { findWaivers, reasonIsBoilerplate, resolveWaivers, applyWaivers } from '../lib/design-lint/waivers';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-design-lint');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'design-lint');

function runBin(args: string[], cwd = ROOT) {
  const r = Bun.spawnSync([BIN, ...args], { cwd, stdout: 'pipe', stderr: 'pipe', timeout: 60_000 });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function tmpPage(html: string, name = 'index.html'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-lint-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, html);
  return file;
}

describe('design-lint: CSS reading', () => {
  test('nested rules, media blocks and keyframes flatten with line numbers; tokens resolve through var() with fallbacks', () => {
    const css = `:root { --color-ink: oklch(20% 0.02 250); --space-4: 1rem; }
.card {
  padding: var(--space-4);
  &:hover { color: var(--color-ink); }
  @media (min-width: 60em) { padding: 2rem; }
}
@keyframes rise { from { opacity: 0 } to { opacity: 1 } }`;
    const rules = parseCss(css, 'a.css');
    const sel = (s: string) => rules.filter((r) => r.selector === s);
    expect(sel('.card')[0].decls).toEqual([{ prop: 'padding', value: 'var(--space-4)', line: 3 }]);
    expect(sel('.card:hover')[0].decls[0]).toEqual({ prop: 'color', value: 'var(--color-ink)', line: 4 });
    expect(sel('.card').find((r) => r.media === '(min-width: 60em)')?.decls[0].value).toBe('2rem');
    expect(rules.filter((r) => r.keyframes === 'rise')).toHaveLength(2);
    const tokens = buildTokens(rules);
    expect(tokens['--space-4']).toBe('1rem');
    expect(resolveVars('var(--space-4) var(--missing, 8px)', tokens)).toBe('1rem 8px');
    expect(pxOf('1.5rem')).toBe(24);
    expect(pxOf('50%')).toBeNull();
  });
});

describe('design-lint: colour', () => {
  test('hex, rgb, hsl and oklch parse; contrast and OKLCH round-trip hold', () => {
    expect(parseColor('#fff')).toEqual({ r: 1, g: 1, b: 1, alpha: 1 });
    expect(parseColor('rgb(0 0 0 / 50%)')?.alpha).toBe(0.5);
    expect(parseColor('hsl(0 100% 50%)')?.r).toBeCloseTo(1, 5);
    const ok = parseColor('oklch(50% 0.1 250)')!;
    expect(ok.okl).toEqual({ L: 0.5, C: 0.1, H: 250 });
    const back = srgbToOklch(ok);
    expect(back.L).toBeCloseTo(0.5, 1);
    expect(back.H).toBeCloseTo(250, 0);
    expect(contrastRatio(parseColor('black')!, parseColor('white')!)).toBeCloseTo(21, 1);
    expect(parseColor('var(--x)')).toBeNull();
  });
});

describe('design-lint: markup reading', () => {
  test('tags keep positions and lines; styles and scripts are lifted; component files become pseudo-HTML with their class strings', () => {
    const doc = parseDoc('p.html', '<html><head><style>h1{color:red}</style></head>\n<body>\n<h1 class="t">Hi &amp; bye</h1><img src="a.png" alt="">\n<script>alert(1)</script></body></html>');
    expect(doc.tags.find((t) => t.name === 'h1')?.line).toBe(3);
    expect(doc.styles[0].css).toBe('h1{color:red}');
    expect(doc.scripts.trim()).toBe('alert(1)');
    expect(doc.text).toContain('Hi & bye');
    expect(getAttr(doc.tags.find((t) => t.name === 'img')!.attrs, 'alt')).toBe('');
    expect(plainText('<p>A &middot; B &rarr;</p>')).toBe('A · B →');
    const tsx = parseDoc('Hero.tsx', 'export const Hero = () => (<section className={cn("bg-indigo-500", open && "p-4")}><h1 className="text-4xl">Hi</h1></section>);');
    expect(tsx.kind).toBe('jsx');
    expect(tsx.tags.map((t) => t.name).filter((n) => n === 'section' || n === 'h1')).toEqual(['section', 'h1', 'h1', 'section']);
    expect(tsx.classAt.get(tsx.tags.find((t) => t.name === 'section')!.pos)).toEqual(['bg-indigo-500', 'p-4']);
  });
});

describe('design-lint: the rule table', () => {
  test('every id is kebab-case with a tier, a source gate, a title and a fix; docs/design-lint.md names each one', () => {
    const docs = fs.readFileSync(path.join(ROOT, 'docs', 'design-lint.md'), 'utf8');
    for (const [id, m] of Object.entries(RULES)) {
      expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(['blocks', 'ask', 'polish']).toContain(m.tier);
      expect(m.gate.length).toBeGreaterThan(0);
      expect(m.title.length).toBeGreaterThan(8);
      expect(m.fix.length).toBeGreaterThan(3);
      expect(docs).toContain('`' + id + '`');
    }
    expect(RULE_IDS.length).toBeGreaterThan(100);
    expect(FAMILIES.map((f) => f.name)).toEqual(['color', 'type', 'structure', 'chrome', 'motion', 'assets', 'finish', 'component', 'copy']);
  });

  test('the three house rules gstack keeps at ask stay at ask, and the Floor rules the plan names block', () => {
    expect(RULES['kicker-above-heading'].tier).toBe('ask');
    expect(RULES['screen-word-budget'].tier).toBe('ask');
    expect(RULES['em-dash-overuse'].tier).toBe('ask');
    expect(RULES['overflow-x-unclipped'].tier).toBe('ask');
    for (const id of ['purple-blue-gradient', 'nested-cards', 'wide-tracking', 'template-punctuation', 'missing-focus-visible', 'low-contrast', 'content-hidden-at-rest', 'hero-fold']) expect(RULES[id].tier).toBe('blocks');
  });
});

describe('design-lint: the output contract', () => {
  test('a finding prints as LINT: <grade> <rule> <file>:<line> <evidence> | fix: <fix>; a suspected blocking tell lands at ask; unknown ids throw', () => {
    const r = new Reporter('page', '/cwd');
    r.report('nested-cards', '/cwd/site/index.html', 12, 'div.card > div.card', {});
    r.report('invented-proof', '/cwd/site/index.html', 30, '"Trusted by 500+ teams"', { suspected: true });
    r.report('section-gap', '/cwd/site/index.html', 1, 'x');
    expect(formatFinding(r.findings[0])).toBe('LINT: blocks nested-cards site/index.html:12 div.card > div.card | fix: one containment layer');
    expect(r.findings[1].tier).toBe('ask');
    expect(() => r.report('no-such-rule', 'f', 1, 'x')).toThrow(/unknown rule id/);
    const component = new Reporter('component', '/cwd');
    component.report('section-gap', '/cwd/a.tsx', 1, 'page-only rule under component scope');
    expect(component.findings).toEqual([]);
  });

  test('blocks exit 2, an unanswered ask exits 1, polish alone exits 0; waived is counted apart from ask and never summed into blocks', () => {
    const base = { file: 'a.html', line: 1, evidence: 'e', fix: 'f', source: 'static' as const };
    const blocks = { rule: 'nested-cards', tier: 'blocks' as const, grade: 'blocks' as const, ...base };
    const ask = { rule: 'section-gap', tier: 'ask' as const, grade: 'ask' as const, ...base };
    const waived = { ...ask, grade: 'waived' as const, waiver: 'because the ledger separates rows with rules' };
    const polish = { rule: 'straight-quotes', tier: 'polish' as const, grade: 'polish' as const, ...base };
    expect(exitCodeOf(summarize([blocks, ask, polish], 'skipped: x'))).toBe(2);
    expect(exitCodeOf(summarize([ask, polish], 'ran'))).toBe(1);
    expect(exitCodeOf(summarize([polish, waived], 'ran'))).toBe(0);
    expect(formatSummary(summarize([blocks, waived, waived, polish], 'ran'))).toBe('LINT_SUMMARY: blocks=1 ask=0 waived=2 polish=1 render=ran');
    expect(finalize([polish, ask, blocks, blocks]).map((f) => f.grade)).toEqual(['blocks', 'ask', 'polish']);
    expect(formatFinding(waived)).toContain('| fix: waived (because the ledger');
  });

  test('the bin prints the contract and exits by it; --rules lists the table; a usage error exits 3', () => {
    const slopped = runBin(['test/fixtures/design-lint/slopped.html']);
    expect(slopped.code).toBe(2);
    const lines = slopped.out.trim().split('\n');
    for (const l of lines.slice(0, -1)) expect(l).toMatch(/^LINT: (blocks|ask|polish|waived) [a-z][a-z0-9-]* \S+:\d+ .+ \| fix: .+$/);
    expect(lines.at(-1)).toMatch(/^LINT_SUMMARY: blocks=\d+ ask=\d+ waived=\d+ polish=\d+ render=skipped: not requested$/);
    expect(runBin(['--rules']).out).toContain('nested-cards');
    expect(runBin([]).code).toBe(3);
    expect(runBin(['--scope', 'app', 'x.html']).code).toBe(3);
    const json = JSON.parse(runBin(['--json', 'test/fixtures/design-lint/slopped.html']).out);
    expect(json.summary.blocks).toBeGreaterThan(0);
    expect(Array.isArray(json.findings)).toBe(true);
  });

  test('a clean page passes: exit 0 and LINT_SUMMARY blocks=0 ask=0', async () => {
    const file = tmpPage(fs.readFileSync(path.join(FIXTURES, 'clean', 'index.html'), 'utf8'));
    const result = await lint([file], { cwd: path.dirname(file) });
    const unexpected = result.findings.filter((f) => f.grade === 'blocks' || f.grade === 'ask');
    expect(unexpected.map(formatFinding)).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(formatResult(result)).toContain('LINT_SUMMARY: blocks=0 ask=0');
  });
});

describe('design-lint: waivers', () => {
  const page = 'The manifesto sets long declarative lines on black paper for the ledger.';
  const claim = (rule: string, reason: string) => ({ rule, reason, file: 'a.html', line: 3, raw: '' });

  test('an ask or polish rule is waived with the rule id and a reason about the page; the Floor is refused', () => {
    const set = resolveWaivers([claim('line-length', 'the manifesto sets long declarative lines'), claim('nested-cards', 'the manifesto nests its ledger on purpose for the paper')], page);
    expect([...set.accepted.keys()]).toEqual(['line-length']);
    expect(set.refused.map((f) => f.evidence)).toEqual(['waiver on nested-cards refused: it blocks; the Floor is never waivable']);
    const findings = applyWaivers([
      { rule: 'line-length', tier: 'ask', grade: 'ask', file: 'a.html', line: 9, evidence: 'e', fix: 'f', source: 'static' },
      { rule: 'nested-cards', tier: 'blocks', grade: 'blocks', file: 'a.html', line: 9, evidence: 'e', fix: 'f', source: 'static' },
    ], set);
    expect(findings.map((f) => [f.rule, f.grade])).toEqual([['line-length', 'waived'], ['nested-cards', 'blocks'], ['waiver', 'ask']]);
  });

  test('short, boilerplate, reused, self-vouching and duplicate reasons are refused, each naming why', () => {
    const set = resolveWaivers([
      claim('line-length', 'looks better this way'),
      claim('section-gap', 'intentional design choice by design'),
      claim('template-nav', 'the manifesto sets long declarative lines'),
      claim('template-footer', 'the manifesto sets long declarative lines'),
      claim('overused-font', 'quartz pelican umbrella semaphore'),
      claim('gradient-text', 'the ledger separates its rows with rules'),
      claim('gradient-text', 'the ledger separates its rows with hairline rules'),
      claim('not-a-rule', 'the manifesto sets long declarative lines'),
    ], page);
    expect([...set.accepted.keys()]).toEqual(['gradient-text']);
    expect(set.refused.map((f) => f.evidence.replace(/^waiver on \S+ refused: /, ''))).toEqual([
      'reason under 24 characters', 'boilerplate reason', 'reason reused on another waiver', 'reason reused on another waiver',
      'reason shares no word with the page', 'one waiver per rule', 'no such rule',
    ]);
    expect(reasonIsBoilerplate('deliberately, it works')).toBe(true);
    expect(reasonIsBoilerplate('the ledger separates its rows with rules')).toBe(false);
  });

  test('both comment forms are read, including impeccable-disable, from HTML, CSS and component sources', () => {
    const claims = findWaivers('a.html', '<!-- gstack-lint-disable section-gap: the ledger separates its rows with rules -->\n<style>/* impeccable-disable line-length: the manifesto sets long lines */</style>\n// gstack-lint-disable template-nav: three links are the three modes');
    expect(claims.map((c) => [c.rule, c.line, c.reason])).toEqual([
      ['section-gap', 1, 'the ledger separates its rows with rules'],
      ['line-length', 2, 'the manifesto sets long lines'],
      ['template-nav', 3, 'three links are the three modes'],
    ]);
  });

  test('the waiver fixture: five honoured (a house-style polish note), two refused (Floor, short reason), nothing blocks', async () => {
    const result = await lint([path.join(FIXTURES, 'waiver')], { cwd: ROOT });
    expect(result.summary.blocks).toBe(0);
    const refused = result.findings.filter((f) => f.rule === 'waiver').map((f) => f.evidence);
    expect(refused).toEqual([
      'waiver on low-contrast refused: it blocks; the Floor is never waivable',
      'waiver on template-footer refused: reason under 24 characters',
    ]);
    expect(result.findings.filter((f) => f.rule === 'house-style')).toHaveLength(1);
    expect(result.findings.some((f) => f.rule === 'low-contrast' && f.grade === 'waived')).toBe(false);
  });
});
