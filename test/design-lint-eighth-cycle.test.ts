/**
 * The eighth review cycle's regressions: the waiver branch keyed to the context's shape rather than the --scope flag
 * (a lone component beside an unlinked stylesheet answers for its own file; a page under --scope component still
 * answers for the sheet it links), the bare `<` tails (`<1`, `< `, an unclosed comment), the craft check's lazy
 * scans over repeated unclosed openers, component tags paired once per file, an arithmetic repeat() count, an
 * unclosed @starting-style block, the import scan over a gradient class line, the render tier's locator on a class
 * value holding a `>`, tickers answered from the tree, a tooltip duration that is not a delay, a class attribute of
 * many tokens, and one emoji-decoration per emoji icon in a component file.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseCss, resolveVars } from '../lib/design-lint/css';
import { parseDoc, parseHtml } from '../lib/design-lint/html';
import { lineOf } from '../lib/design-lint/render';
import { glAccent, glLayout } from '../lib/design-lint/render-probe';
import { Reporter, type Finding } from '../lib/design-lint/report';
import { run as runAssets } from '../lib/design-lint/rules/assets';
import { run as runCopy } from '../lib/design-lint/rules/copy';
import { lintStatic } from '../lib/design-lint/static';
import { compInner } from '../lib/design-lint/tailwind';

const tmpDirs: string[] = [];
afterAll(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

const TOKENS = ':root { --color-paper: oklch(97% 0.01 80); --color-ink: oklch(20% 0.02 250); --color-accent: oklch(50% 0.16 30); --color-accent-ink: oklch(98% 0.01 30); --color-muted: oklch(50% 0.02 250); --font-display: "Literata", serif; --font-body: "Public Sans", sans-serif; }';
const HEAD = '<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>Harbour office</title><meta name="description" content="A test page."><link rel="icon" href="data:,">\n';
const GREY = TOKENS + '\n:root { --color-gray: oklch(55% 0 0); }\n.row { border-color: var(--color-gray); }';
const DASHES = 'The ledger \u2014 the month \u2014 the close \u2014 the depot \u2014 the review \u2014 the rule \u2014 the row \u2014 the sum';
const CARD = 'export function Card() { return <p>' + DASHES + '</p>; }';

function tree(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-lint-cycle8-'));
  tmpDirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}
const quiet = { warn: () => {} };
const only = (f: Finding[], rule: string) => f.filter((x) => x.rule === rule);
const timed = (fn: () => void): number => { const t = performance.now(); fn(); return performance.now() - t; };
const lintDir = (files: Record<string, string>, scope?: 'page' | 'component'): { findings: Finding[]; warns: string[] } => {
  const dir = tree(files);
  const warns: string[] = [];
  return { findings: lintStatic([dir], { cwd: dir, warn: (l: string) => warns.push(l), ...(scope ? { scope } : {}) }).findings, warns };
};

describe('design-lint eighth cycle: the waiver branch follows the context, not the flag', () => {
  test('a lone component beside an unlinked stylesheet answers for its own file under either scope', () => {
    for (const scope of ['page', 'component'] as const) {
      const { findings } = lintDir({ 'Hero.tsx': '// gstack-lint-disable zero-chroma-neutrals: the ledger keeps its grey rows grey on the depot\nexport function Hero() { return <h1 className="row">The ledger keeps its grey rows grey on the depot</h1>; }', 'theme.css': GREY }, scope);
      expect(only(findings, 'zero-chroma-neutrals').map((x) => [x.file, x.grade]), scope).toEqual([['theme.css', 'ask']]);
    }
  });

  test('default scope, one component: a short claim is refused at its line and the finding stays ask', () => {
    const { findings } = lintDir({ 'Card.tsx': '// gstack-lint-disable em-dash-overuse: short\n' + CARD });
    expect(only(findings, 'em-dash-overuse').map((x) => [x.file, x.grade])).toEqual([['Card.tsx', 'ask']]);
    expect(only(findings, 'waiver').map((x) => [x.file, x.line, x.evidence])).toEqual([['Card.tsx', 1, 'waiver on em-dash-overuse refused: reason under 24 characters']]);
  });

  test('under --scope component a page claim still answers a finding in the stylesheet it links, and a short one is refused', () => {
    const page = (reason: string) => '<!-- gstack-lint-disable zero-chroma-neutrals: ' + reason + ' -->\n' + HEAD + '<link rel="stylesheet" href="theme.css"></head><body><main><h1>The ledger</h1><p>The ledger keeps its grey rows grey on the depot.</p></main></body></html>';
    const ok = lintDir({ 'index.html': page('the ledger keeps its grey rows grey on the depot'), 'theme.css': GREY }, 'component').findings;
    expect(only(ok, 'waiver')).toEqual([]);
    expect(only(ok, 'zero-chroma-neutrals').map((x) => [x.file, x.grade])).toEqual([['theme.css', 'waived']]);
    const bad = lintDir({ 'index.html': page('short'), 'theme.css': GREY }, 'component').findings;
    expect(only(bad, 'zero-chroma-neutrals').map((x) => [x.file, x.grade])).toEqual([['theme.css', 'ask']]);
    expect(only(bad, 'waiver').map((x) => [x.file, x.line, x.evidence])).toEqual([['index.html', 1, 'waiver on zero-chroma-neutrals refused: reason under 24 characters']]);
  });
});

describe('design-lint eighth cycle: a file costs its length', () => {
  test('a heading whose tail is thousands of bare < characters lints in linear time', () => {
    const dir = tree({ 'index.html': HEAD + '</head><body><h1>' + ' x <'.repeat(80_000) });
    expect(timed(() => lintStatic([dir], { cwd: dir, ...quiet }))).toBeLessThan(5000);
  });

  test('a page whose tail is a run of <1 or of unclosed comment starts costs its length, and a doctype survives', () => {
    const dir = tree({
      'a.html': HEAD + '</head><body><p>hi</p></body></html>' + '<1'.repeat(200_000),
      'b.html': HEAD + '</head><body>' + '<!-- x'.repeat(100_000) + '</body></html>',
    });
    expect(timed(() => lintStatic([dir], { cwd: dir, ...quiet }))).toBeLessThan(5000);
    const doc = parseHtml('x.html', '<!doctype html><p>a < b and 1<2</p><!-- gone');
    expect(doc.src.startsWith('<!doctype html>')).toBe(true);
    expect(doc.src.indexOf('<', '<!doctype html>'.length)).toBe(doc.src.indexOf('<p>'));
    expect(doc.src.includes('<!--')).toBe(false);
    expect(doc.tags.map((t) => t.name)).toEqual(['p', 'p']);
    expect(parseHtml('x.html', '<p>Fees are <1% of volume and <b>nothing</b> else</p>').text.replace(/\s+/g, ' ').trim()).toBe('Fees are 1% of volume and nothing else');
  });

  test('repeated unclosed <script>, <nav>, <style> and <template> openers cost the copy tier their length', () => {
    for (const tag of ['<script>', '<nav>', '<style>', '<template>']) {
      const doc = parseHtml('x.html', HEAD + '</head><body>' + tag.repeat(60_000) + '</body></html>');
      const reporter = new Reporter('page', '/');
      expect(timed(() => runCopy({ docs: [doc] } as never, reporter)), tag).toBeLessThan(3000);
    }
    const doc = parseHtml('x.html', HEAD + '</head><body><nav><a href="/a">A</a><a href="/b">B</a></nav><nav><main id="m"><h1>Hello there</h1></main></body></html>');
    const reporter = new Reporter('page', '/');
    runCopy({ docs: [doc] } as never, reporter);
    expect(reporter.findings.map((f) => f.rule)).toContain('missing-aria-current');
  });

  test('a template of thousands of unclosed component tags costs its length', () => {
    const dir = tree({ 'Card.vue': '<template>\n' + '<Foo class="p-4">x\n'.repeat(80_000) + '</template>' });
    expect(timed(() => lintStatic([dir], { cwd: dir, ...quiet }))).toBeLessThan(3000);
    const doc = parseDoc('/x/App.vue', '<template><Foo><Bar>in</Bar><Foo>deep</Foo>out</Foo><Baz /></template>');
    expect(doc.comps.filter((c) => !c.close && !c.selfClosing).map((_, i) => compInner(doc, doc.comps.indexOf(doc.comps.filter((c) => !c.close && !c.selfClosing)[i])))).toEqual(['<Bar>in</Bar><Foo>deep</Foo>out', 'in', 'deep']);
    expect(compInner(doc, doc.comps.length - 1)).toBe('');
  });

  test('a huge repeat() count in grid-template-columns neither throws nor allocates', () => {
    const { findings, warns } = lintDir({
      'index.html': HEAD + '<link rel="stylesheet" href="style.css"></head><body><section class="grid"><h1>Hi</h1><p>x</p></section></body></html>',
      'style.css': TOKENS + '\n.grid { grid-template-columns: 1fr 1fr; }\n@media (min-width: 1600px) { .grid { grid-template-columns: repeat(4294967296, 1fr); } }',
    });
    expect(warns.filter((w) => /internal error/.test(w))).toEqual([]);
    expect(only(findings, 'internal-error')).toEqual([]);
    expect(only(findings, 'wide-container').map((f) => f.evidence)).toEqual([expect.stringContaining('(2 to 4294967296)')]);
    const named = lintDir({
      'index.html': HEAD + '<link rel="stylesheet" href="style.css"></head><body><main><section class="grid"><h1>Hi</h1><p>x</p></section></main></body></html>',
      'style.css': TOKENS + '\n.grid { grid-template-columns: repeat(12, 1fr); }\n@media (min-width: 1600px) { .grid { grid-template-columns: repeat(12, [col-start] 1fr) [col-end]; } }',
    }).findings;
    expect(only(named, 'wide-container')).toEqual([]);
  });

  test('unclosed @starting-style blocks cost their length, not the sheet squared', () => {
    const dir = tree({ 'style.css': '.a { opacity: 0 }\n' + '@starting-style {\n'.repeat(8000) + '.b { color: red }\n'.repeat(8000) });
    const warns: string[] = [];
    expect(timed(() => lintStatic([dir], { cwd: dir, warn: (l: string) => warns.push(l) }))).toBeLessThan(2000);
    expect(warns.filter((w) => /internal error/.test(w))).toEqual([]);
  });

  test('ten thousand unclosed <em> under headings cost the assets rules their length', () => {
    const doc = parseDoc('x.html', HEAD + '</head><body>' + '<h2>a <em>x '.repeat(10000) + '</body></html>');
    const reporter = new Reporter('page', '/');
    expect(timed(() => runAssets({ docs: [doc], cssFiles: [], rules: [], tokens: {}, twTokens: null, allCss: '', cache: {} } as never, reporter))).toBeLessThan(600);
  });

  test('a deeply nested comma selector list costs its length, not parts^depth', () => {
    const css = 'a,b{'.repeat(40) + 'color:red' + '}'.repeat(40);
    let rules: ReturnType<typeof parseCss> = [];
    expect(timed(() => { rules = parseCss(css, 'x.css'); })).toBeLessThan(2000);
    expect(rules.reduce((n, x) => n + x.selector.length, 0)).toBeLessThan(1_000_000);
    expect(parseCss('.a, .b { .c, .d { color: red } }', 'x.css').map((x) => x.selector)).toEqual(['.a, .b', ':is(.a, .b) .c, :is(.a, .b) .d']);
  });

  test('a huge token value is not expanded into every reference', () => {
    const tokens = { '--a': 'x'.repeat(1_000_000), '--b': 'blue' };
    const value = 'var(--a) '.repeat(900).trim();
    let out = '';
    expect(timed(() => { out = resolveVars(value, tokens); })).toBeLessThan(200);
    expect(out).toBe(value);
    expect(resolveVars('1px solid var(--b)', tokens)).toBe('1px solid blue');
  });

  test('a stylesheet or <style> block the lint could not parse is an internal-error finding, not a silent pass', () => {
    const boom = 'a,b{'.repeat(30) + 'color:red' + '}'.repeat(30);
    const inline = lintDir({ 'index.html': HEAD + '<style>' + boom + ' * { transition: all .3s ease }</style></head><body><main><h1>Hi</h1></main></body></html>' }).findings;
    expect(only(inline, 'layout-transition').map((f) => f.grade)).toEqual(['blocks']);
    expect(only(inline, 'internal-error')).toEqual([]);
    const big = lintDir({ 'index.html': HEAD + '<link rel="stylesheet" href="big.css"></head><body><main><h1>Hi</h1></main></body></html>', 'big.css': '.a{color:red}\n'.repeat(160_000) }).findings;
    expect(only(big, 'internal-error').map((f) => [f.file, f.grade])).toEqual([['big.css', 'ask']]);
  });

  test('a long gradient className line costs the asset scan its length', () => {
    const dir = tree({ 'Hero.tsx': 'export default function Hero(){ return (<div className="' + 'bg-gradient-to-r from-indigo-500 to-violet-500 '.repeat(20_000) + '">x</div>); }' });
    expect(timed(() => lintStatic([dir], { cwd: dir, ...quiet }))).toBeLessThan(5000);
  });

  test('the render locator costs the page its length when a class value holds a >, and refuses a tag that is not one', () => {
    const src = parseHtml('x.html', '<html><body><div class="' + 'a '.repeat(150_000) + '>"><p>x</p></div></body></html>').src;
    expect(timed(() => lineOf(src, { tag: 'div', cls: 'a', text: 'zzz' }))).toBeLessThan(2000);
    const tail = parseHtml('x.html', '<p>hi</p>' + '<1'.repeat(160_000)).src;
    expect(timed(() => expect(lineOf(tail, { tag: '1', cls: '', text: 'zz' })).toBe(1))).toBeLessThan(500);
    expect(lineOf('<x>\n<p class="lede big">Hello</p>', { tag: 'p', cls: 'big', text: 'hello' })).toBe(2);
    expect(lineOf('<x>\n<p class="lede big">Hello</p>', { tag: 'p', cls: 'x'.repeat(401), text: 'hello' })).toBe(2);
  });

  test('thousands of ticker elements beside thousands of text elements cost their length', () => {
    const dir = tree({ 'index.html': HEAD + '</head><body>' + '<i class="ticker"></i><span>x</span>'.repeat(40_000) + '</body></html>' });
    expect(timed(() => lintStatic([dir], { cwd: dir, ...quiet }))).toBeLessThan(4000);
    const f = lintDir({ 'index.html': HEAD + '</head><body><div class="ticker"><p><span>One · two · three</span></p></div><p>Four · five · six</p></body></html>' }).findings;
    expect(only(f, 'template-punctuation').map((x) => x.evidence)).toEqual(['middle dots join a meta string: "Four · five · six"']);
  });

  test('a class attribute with 700k tokens does not overflow the stack', () => {
    const { warns } = lintDir({ 'index.html': HEAD + '</head><body><div class="' + 'a '.repeat(700_000) + '"><h1>Hi</h1></div></body></html>\n' });
    expect(warns.filter((w) => /Maximum call stack/.test(w))).toEqual([]);
  });
});

describe('design-lint eighth cycle: rule judgements', () => {
  test('tooltip-focus-delay reads a delay, not a 0.2s fade', () => {
    const tip = (t: string) => lintDir({ 'index.html': HEAD + '<style>' + TOKENS + ' .tooltip:hover .tip { transition: ' + t + '; opacity: 1 } .tooltip:focus-within .tip { transition: ' + t + '; opacity: 1 }</style></head><body><main><h1>Hello there</h1><span class="tooltip" tabindex="0">?<span class="tip">Help</span></span></main></body></html>' }).findings;
    expect(only(tip('opacity 0.2s'), 'tooltip-focus-delay')).toEqual([]);
    expect(only(tip('opacity .5s ease'), 'tooltip-focus-delay')).toEqual([]);
    expect(only(tip('opacity 0.2s 1s'), 'tooltip-focus-delay').map((f) => f.grade)).toEqual(['ask']);
    expect(only(tip('opacity 200ms 600ms'), 'tooltip-focus-delay').map((f) => f.grade)).toEqual(['ask']);
  });

  test('one emoji-decoration per emoji icon in a component file, however the parent wraps it', () => {
    const { findings } = lintDir({ 'Card.tsx': 'export function Card() { return <div>\n<div className="icon"><Icon>\u{1F680}</Icon></div>\n<div className="icon"><Icon>\u{1F680}</Icon></div>\n<div className="feature"><Icon>\u{1F680}</Icon><h3>Fast</h3></div>\n</div>; }' });
    expect(only(findings, 'emoji-decoration').map((f) => [f.line, f.evidence])).toEqual([[2, 'emoji icon "\u{1F680}" in <Icon>'], [3, 'emoji icon "\u{1F680}" in <Icon>'], [4, 'emoji icon "\u{1F680}" in <Icon>']]);
  });

  test('the 1280 probes read their viewport from the page, not a literal', () => {
    for (const fn of [glLayout, glAccent]) expect(fn.toString()).not.toMatch(/\b800\b|1280x800/);
  });

  test('the emoji classes spell their variation selector and joiner as escapes', () => {
    expect(fs.readFileSync(path.join(import.meta.dir, '../lib/design-lint/rules/assets.ts'), 'utf8')).not.toMatch(/[\uFE0F\u200D]/);
  });
});
