import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BUZZWORDS, checkCraft, formatCraft, visibleText } from '../lib/design-craft';
import { catalogEntry } from '../lib/design-catalog';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-design-craft');

const DIRTY = `<!doctype html><html><head><style>.hero{height:100vh;transition: all .3s}</style></head><body>
<nav><a href="#">Docs</a><a href="/">Home</a><a href="/pricing">Pricing</a></nav>
<h1>Elevate your workflow seamlessly</h1><p>Trusted by Acme and John Doe. 99.99% uptime, 50% faster, 10,000+ happy users. [Needs proof: logo]</p>
<img src="a.png"><p>Oops! Something broke. Lorem ipsum.</p>
<script>window.addEventListener('scroll', () => {}); alert('hi'); showAlert(1);</script></body></html>`;

const CLEAN = `<!doctype html><html lang="en"><head><title>Ledgerline: close the books in 2 days</title>
<meta name="description" content="Close faster."><meta property="og:image" content="/og.png"><link rel="icon" href="/favicon.svg">
<style>.hero{min-height:100vh;min-height:100dvh;transition: transform .4s var(--ease-out)} .w{width:100%}</style></head>
<body><a href="#main">Skip to content</a><a href="#pricing">Pricing</a><nav><a href="/" aria-current="page">Home</a><a href="/pricing">Pricing</a></nav>
<main id="main"><h1>Close the books in 2 days, not 9</h1><p>Teams at Halvorsen Freight cut month-end by 47.2%. Save 20% yearly. 100% open source. 30-day refund.</p><img src="x.png" alt=""></main>
<script>const io = new IntersectionObserver(() => {}); window.showAlert = () => {};</script></body></html>`;

function run(file?: string) {
  const r = Bun.spawnSync([BIN, ...(file ? [file] : [])], { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe('design-craft check', () => {
  test('a page with every tell reports each one with its count', () => {
    const counts = Object.fromEntries(checkCraft(DIRTY).map(f => [f.id, f.count]));
    expect(counts).toEqual({
      'placeholder-name': 1, 'placeholder-brand': 1, lorem: 1, 'marketing-buzzword': 2, 'round-number': 3, 'needs-proof': 1, oops: 1,
      'scroll-listener': 1, 'transition-all': 1, 'dead-link': 1, alert: 1, 'img-no-alt': 1, 'vh-height': 1,
      'missing-title': 1, 'missing-meta-description': 1, 'missing-favicon': 1,
      'missing-skip-link': 1, 'missing-aria-current': 1,
    });
  });

  test('a finished page is clean: CSS 100%, a 100vh line with its 100dvh fallback, in-page anchors, a showAlert helper and inlined Pretext are not flagged', () => {
    expect(checkCraft(CLEAN)).toEqual([]);
    const pretext = fs.readFileSync(path.join(ROOT, 'design-html', 'vendor', 'pretext.js'), 'utf-8');
    expect(checkCraft(CLEAN.replace('</body>', `<script type="module">${pretext}</script></body>`))).toEqual([]);
    expect(formatCraft([])).toBe('CRAFT_RESULT: clean');
  });

  test('BUZZWORDS covers every word the catalog marketing-buzzword heuristic names', () => {
    const heuristic = catalogEntry('marketing-buzzword')?.heuristic ?? '';
    const words = heuristic.replace(/^.*?for /, '').replace(/\.$/, '').split(/,\s*/);
    expect(words.length).toBeGreaterThan(5);
    for (const word of words) expect(BUZZWORDS).toContain(word);
    expect(checkCraft('<p>Unlocking seamless, next gen workflows that elevate teams</p>').map(f => [f.id, f.count])).toEqual([['marketing-buzzword', 4]]);
    expect(checkCraft('<p>Take the elevator to the elevation map; streamers sold here</p>')).toEqual([]);
  });

  test('the skip link must reach an existing id, and aria-current is required only for route navigation', () => {
    const ids = (html: string) => checkCraft(html).map(f => f.id);
    expect(ids(CLEAN.replace('id="main"', 'id="content"'))).toEqual(['missing-skip-link']);
    const sectionNav = CLEAN.replace('<a href="/" aria-current="page">Home</a><a href="/pricing">Pricing</a>', '<a href="#features">Features</a><a href="#faq">FAQ</a>');
    expect(ids(sectionNav)).toEqual([]);
    expect(ids(CLEAN.replace(' aria-current="page"', ''))).toEqual(['missing-aria-current']);
  });

  test('attribute look-alikes, encoded markers and 100vh ordering are read correctly', () => {
    const ids = (html: string) => checkCraft(html).map(f => f.id);
    expect(ids('<img src="a.png" data-alt="x">')).toEqual(['img-no-alt']);
    expect(ids('<p>&#91;Needs proof: logo]</p>')).toEqual(['needs-proof']);
    expect(ids(CLEAN.replace('id="main"', 'data-id="main"'))).toEqual(['missing-skip-link']);
    expect(ids('<style>.a{min-height:100dvh;min-height:100vh}</style>')).toEqual(['vh-height']);
    expect(ids('<style>.a{min-height:100vh !important;min-height:100dvh}</style>')).toEqual(['vh-height']);
  });

  test('every word and name the craft section bans is one the checker flags', () => {
    const section = fs.readFileSync(path.join(ROOT, 'design-html', 'sections', 'craft.md.tmpl'), 'utf-8');
    const buzz = section.match(/No buzzwords: ([^\n]+)\.\n/)?.[1].replace(/"/g, '').split(/,\s*/) ?? [];
    expect(buzz.length).toBeGreaterThan(10);
    for (const word of buzz) expect(BUZZWORDS).toContain(word);
    const names = section.match(/No placeholder people or brands \(([^)]+)\)/)?.[1].split(/,\s*/) ?? [];
    expect(names.length).toBe(5);
    for (const name of names) expect(checkCraft(`<p>${name}</p>`).map(f => f.id)).toEqual([/Doe/.test(name) ? 'placeholder-name' : 'placeholder-brand']);
  });

  test('skip link is judged by position and target; alert() counts only in script; svg text is copy', () => {
    const ids = (html: string) => checkCraft(html).map(f => f.id);
    expect(ids(CLEAN.replace('>Skip to content<', '>Zum Inhalt springen<'))).toEqual([]);
    expect(ids(CLEAN.replace('<a href="#main">Skip to content</a>', ''))).toEqual(['missing-skip-link']);
    expect(ids('<p>Set a price alert (free)</p>')).toEqual([]);
    expect(ids('<button onclick="alert(1)">Go</button>')).toEqual(['alert']);
    expect(ids('<svg><text>Acme</text></svg>')).toEqual(['placeholder-brand']);
  });

  test('copy rules read visible text only; head rules skip a fragment', () => {
    expect(visibleText('<style>.a{content:"Acme"}</style><script>// John Doe</script><p>Halvorsen</p>')).toBe(' Halvorsen ');
    expect(checkCraft('<section><h2>Pricing</h2><a href="/buy">Start free trial</a></section>')).toEqual([]);
  });

  test('the CLI prints CRAFT_CHECK lines and exits 1 on tells, 0 when clean, 2 on usage', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-craft-'));
    try {
      fs.writeFileSync(path.join(dir, 'dirty.html'), DIRTY);
      fs.writeFileSync(path.join(dir, 'clean.html'), CLEAN);
      const dirty = run(path.join(dir, 'dirty.html'));
      expect(dirty.code).toBe(1);
      expect(dirty.out).toContain('CRAFT_CHECK: scroll-listener 1 ');
      expect(dirty.out.trim().split('\n').at(-1)).toBe('CRAFT_RESULT: 18 issue(s)');
      const clean = run(path.join(dir, 'clean.html'));
      expect(clean).toMatchObject({ code: 0, out: 'CRAFT_RESULT: clean\n' });
      expect(run().code).toBe(2);
      expect(run(path.join(dir, 'missing.html')).code).toBe(2);
      fs.writeFileSync(path.join(dir, 'empty.html'), '  \n');
      expect(run(path.join(dir, 'empty.html')).code).toBe(2);
      fs.writeFileSync(path.join(dir, 'page.tsx'), 'export const P = () => <p>Acme</p>;');
      expect(run(path.join(dir, 'page.tsx'))).toMatchObject({ code: 2, out: '' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
