/**
 * Markup reading for the design lint. A tag scanner over HTML (no DOM
 * dependency) that keeps source positions, so every finding has a file:line;
 * component files (.jsx .tsx .vue .svelte .astro) are first turned into
 * pseudo-HTML: JSX by a small scanner that keeps elements and class
 * attributes and blanks expressions, templates by masking frontmatter,
 * braces and attribute expressions. Class-name helper calls (cn, clsx, cva …)
 * are collected separately so Tailwind rules can read them.
 *
 * Ported from Nutlope/hallmark's sloplint.mjs (parseHtml, jsxPseudo,
 * templateMask, clsLits, classCalls; MIT, see NOTICE.md).
 */
import * as path from 'node:path';
import { lineIndex } from './css';

export type DocKind = 'html' | 'jsx' | 'vue' | 'svelte' | 'astro';

export interface Tag {
  close: boolean;
  name: string;
  attrs: string;
  pos: number;
  end: number;
  selfClosing: boolean;
  line: number;
}

export interface ComponentTag extends Tag {}

export interface StyleBlock { css: string; lineOffset: number }

export interface ClassCall { pos: number; name: string; toks: string[] }

export interface Doc {
  file: string;
  kind: DocKind;
  /** The text the tags were scanned from: the raw HTML, or the pseudo-HTML of a component. */
  src: string;
  /** The original file text. */
  raw: string;
  /** src with comments, scripts and styles blanked (positions preserved). */
  masked: string;
  styles: StyleBlock[];
  scripts: string;
  tags: Tag[];
  /** Non-HTML (component) tags in a component file. */
  comps: ComponentTag[];
  /** Visible text with entities decoded and whitespace folded. */
  text: string;
  lineOf: (pos: number) => number;
  /** JSX only: class tokens by element start position. */
  classAt: Map<number, string[]>;
  /** Class-name helper calls (cn, clsx, cva …) found in scripts. */
  virtuals: ClassCall[];
  /** Per-doc caches for the rules. */
  cache: Record<string, unknown>;
}

export const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
export const HTML_NAMES = new Set(('a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption cite code col colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li link main map mark menu meta meter nav noscript object ol optgroup option output p param picture pre progress q rp rt ruby s samp script search section select slot small source span strong style sub summary sup svg table tbody td template textarea tfoot th thead time title tr track u ul var video wbr').split(' '));

const pad = (t: string) => t.replace(/[^\n]/g, ' ');

export function parseHtml(file: string, src: string, kind: DocKind = 'html'): Doc {
  const lineOf = lineIndex(src);
  const styles: StyleBlock[] = [];
  const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let m: RegExpExecArray | null;
  while ((m = styleRe.exec(src))) styles.push({ css: m[1], lineOffset: lineOf(m.index) - 1 });
  let scripts = '';
  const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = scriptRe.exec(src))) scripts += m[1] + '\n';
  const masked = src
    .replace(/<!--[\s\S]*?-->/g, pad)
    .replace(/(<(script|style)\b[^>]*>)([\s\S]*?)(<\/\2\s*>)/gi, (_m0, open: string, _tag: string, body: string, close: string) => open + pad(body) + close);
  const tags: Tag[] = [];
  const comps: ComponentTag[] = [];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  while ((m = tagRe.exec(masked))) {
    const attrs = m[3] || '';
    if (kind !== 'html' && !HTML_NAMES.has(m[2])) {
      comps.push({ close: m[1] === '/', name: m[2], attrs, pos: m.index, end: m.index + m[0].length, selfClosing: /\/\s*$/.test(attrs), line: lineOf(m.index) });
      continue;
    }
    const name = m[2].toLowerCase();
    tags.push({ close: m[1] === '/', name, attrs, pos: m.index, end: m.index + m[0].length, selfClosing: /\/\s*$/.test(attrs) || VOID_TAGS.has(name), line: lineOf(m.index) });
  }
  const noScript = src.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const text = noScript.replace(/<[^>]*>/g, ' ')
    .replace(/&quot;|&#0?34;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&hellip;|&#8230;/g, '\u2026').replace(/&mdash;|&#8212;|&#x2014;/gi, '\u2014').replace(/&ndash;|&#8211;|&#x2013;/gi, '\u2013')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ');
  return { file, kind, src, raw: src, masked, styles, scripts, tags, comps, text, lineOf, classAt: new Map(), virtuals: [], cache: {} };
}

/** The index of the brace that closes the one at j (strings skipped), or the string's length. */
export function braceEnd(s: string, j: number): number {
  let depth = 0;
  for (let i = j; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') {
      i++;
      while (i < s.length && s[i] !== c) { if (s[i] === '\\') i++; i++; }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return s.length;
}

export const FRONTMATTER = /^\s*---[^\n]*\n[\s\S]*?\n---/;

/** Blank Astro frontmatter, brace expressions in attributes (Svelte, Astro) and angle brackets inside attribute strings, keeping positions. */
export function templateMask(src: string, kind: DocKind): string {
  const n = src.length;
  let out: string[] | null = null;
  const put = (k: number, ch: string) => { if (!out) out = src.split(''); out[k] = ch; };
  const blank = (a: number, b: number) => { for (let k = a; k < b; k++) if (src[k] !== '\n' && src[k] !== ' ') put(k, ' '); };
  const lower = src.toLowerCase();
  const braces = kind === 'svelte' || kind === 'astro';
  let i = 0;
  if (kind === 'astro') {
    const fm = FRONTMATTER.exec(src);
    if (fm) { blank(0, fm[0].length); i = fm[0].length; }
  }
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
    if (!/[A-Za-z]/.test(src[lt + 1] || '')) { i = lt + 1; continue; }
    let j = lt + 1;
    while (j < n && /[\w:.-]/.test(src[j])) j++;
    const name = lower.slice(lt + 1, j);
    while (j < n && src[j] !== '>') {
      const c = src[j];
      if (c === '"' || c === "'") {
        let e = src.indexOf(c, j + 1);
        if (e < 0) e = n;
        for (let k = j + 1; k < e; k++) if (src[k] === '<' || src[k] === '>') put(k, ' ');
        j = e + 1;
        continue;
      }
      if (c === '{' && braces) { const e = braceEnd(src, j); blank(j + 1, e); j = e + 1; continue; }
      j++;
    }
    i = j + 1;
    if (name === 'script' || name === 'style' || name === 'textarea') {
      const e = lower.indexOf('</' + name, i);
      i = e < 0 ? n : e;
    }
  }
  return out ? (out as string[]).join('') : src;
}

const cutGlued = (seg: string, after: boolean, before: boolean): string => {
  let s = seg;
  if (after) s = s.replace(/^\S+/, '');
  if (before) s = s.replace(/\S+$/, '');
  return s;
};

/** Every string literal's class tokens inside a JS expression, template literals included (${} parts recursed, glued halves dropped). */
export function clsLits(s: string, level = 0): string[] {
  if (level > 20) return [];
  const parts: string[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '/' && s[i + 1] === '/') { const e = s.indexOf('\n', i); i = e < 0 ? s.length : e; continue; }
    if (c === '/' && s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? s.length : e + 2; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < s.length && s[j] !== c && s[j] !== '\n') { if (s[j] === '\\') j++; j++; }
      parts.push(s.slice(i + 1, j));
      i = j + 1;
      continue;
    }
    if (c === '`') {
      let j = i + 1, seg = '', after = false;
      while (j < s.length && s[j] !== '`') {
        if (s[j] === '\\') { seg += s[j + 1] || ''; j += 2; continue; }
        if (s[j] === '$' && s[j + 1] === '{') {
          parts.push(cutGlued(seg, after, true));
          const e = braceEnd(s, j + 1);
          parts.push(clsLits(s.slice(j + 2, e), level + 1).join(' '));
          j = e + 1; seg = ''; after = true;
          continue;
        }
        seg += s[j]; j++;
      }
      parts.push(cutGlued(seg, after, false));
      i = j + 1;
      continue;
    }
    i++;
  }
  return parts.join(' ').split(/\s+/).filter(Boolean);
}

const JS_EXPR_KW = new Set(['return', 'yield', 'await', 'case', 'default', 'else', 'do', 'throw', 'typeof', 'void', 'delete', 'in', 'of', 'new', 'instanceof']);
export const CLASS_FNS = new Set(['cn', 'clsx', 'classNames', 'classnames', 'twMerge', 'twJoin', 'cva', 'cx', 'tv']);

/**
 * Turn a JSX/TSX module into pseudo-HTML of the same length: elements and
 * their class attributes survive (an expression-valued className becomes the
 * literals it holds), everything else becomes spaces. Also records where
 * class-helper calls start.
 */
class JsxScanner {
  private readonly n: number;
  private readonly out: string[];
  readonly classes: Array<[number, string[]]> = [];
  readonly calls: number[] = [];
  private hi = 0;
  private fails = 0;
  private inClass = 0;
  private depth = 0;

  constructor(private readonly src: string) {
    this.n = src.length;
    this.out = new Array(this.n);
    for (let k = 0; k < this.n; k++) this.out[k] = src[k] === '\n' ? '\n' : ' ';
  }

  pseudo(): string { this.js(0, false); return this.out.join(''); }

  private blank(a: number, b: number): void { for (let k = a; k < b && k < this.n; k++) this.out[k] = this.src[k] === '\n' ? '\n' : ' '; }
  private paint(a: number, b: number): void { for (let k = a; k < b && k < this.n; k++) this.out[k] = this.src[k]; if (b > this.hi) this.hi = b; }
  private write(a: number, b: number, text: string): void {
    this.blank(a, b);
    let k = a;
    for (const ch of text) { while (k < b && this.src[k] === '\n') k++; if (k >= b) break; this.out[k++] = ch; }
    if (b > this.hi) this.hi = b;
  }
  private ws(i: number): number { while (i < this.n && /\s/.test(this.src[i])) i++; return i; }
  private gap(i: number): number {
    const { src, n } = this;
    for (;;) {
      i = this.ws(i);
      if (src[i] === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); if (e < 0) return n; i = e + 2; continue; }
      if (src[i] === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); if (e < 0) return n; i = e; continue; }
      return i;
    }
  }
  private strEnd(i: number): number {
    const { src, n } = this;
    const q = src[i];
    let j = i + 1;
    while (j < n && src[j] !== q && src[j] !== '\n') { if (src[j] === '\\') j++; j++; }
    return Math.min(j + 1, n);
  }
  private tplEnd(i: number): number {
    const { src, n } = this;
    let j = i + 1;
    while (j < n && src[j] !== '`') {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === '$' && src[j + 1] === '{') { j = this.js(j + 2, true) + 1; continue; }
      j++;
    }
    return Math.min(j + 1, n);
  }
  private reEnd(i: number): number {
    const { src, n } = this;
    let j = i + 1, set = false;
    while (j < n && src[j] !== '\n') {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '[') set = true;
      else if (c === ']') set = false;
      else if (c === '/' && !set) { j++; while (j < n && /[a-z]/i.test(src[j])) j++; return j; }
      j++;
    }
    return -1;
  }
  private js(i: number, stop: boolean): number {
    if (this.depth > 200) return stop ? Math.min(braceEnd(this.src, i - 1), this.n) : this.n;
    this.depth++;
    const r = this.jsScan(i, stop);
    this.depth--;
    return r;
  }
  private jsScan(i: number, stop: boolean): number {
    const { src, n } = this;
    let level = 0, val = false;
    while (i < n) {
      const c = src[i];
      if (c === ' ' || c === '\n' || c === '\t' || c === '\r') { i++; continue; }
      if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); i = e < 0 ? n : e; continue; }
      if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
      if (c === '"' || c === "'") { i = this.strEnd(i); val = true; continue; }
      if (c === '`') { i = this.tplEnd(i); val = true; continue; }
      if (c === '{') { level++; i++; val = false; continue; }
      if (c === '}') { if (stop && level === 0) return i; level--; i++; val = true; continue; }
      if (c === ')' || c === ']') { i++; val = true; continue; }
      if (c === '<' && !val && this.fails < 500 && /[A-Za-z_$>]/.test(src[i + 1] || '')) {
        const e = this.el(i);
        if (e > 0) { i = e; val = true; continue; }
        this.fails++;
      }
      if (c === '/' && !val) { const e = this.reEnd(i); if (e > 0) { i = e; val = true; continue; } }
      if (/[A-Za-z_$]/.test(c)) {
        let j = i + 1;
        while (j < n && /[\w$]/.test(src[j])) j++;
        const w = src.slice(i, j);
        val = !JS_EXPR_KW.has(w);
        if (!this.inClass && CLASS_FNS.has(w) && src[i - 1] !== '.' && src[this.ws(j)] === '(') this.calls.push(i);
        i = j;
        continue;
      }
      if (c >= '0' && c <= '9') { let j = i + 1; while (j < n && /[\w.]/.test(src[j])) j++; i = j; val = true; continue; }
      i++;
      val = false;
    }
    return n;
  }
  private el(start: number): number {
    if (this.depth > 200) return -1;
    const mc = this.classes.length, mk = this.calls.length;
    this.depth++;
    const e = this.tag(start);
    this.depth--;
    if (e < 0) { this.blank(start, Math.max(this.hi, start + 1)); this.hi = start; this.classes.length = mc; this.calls.length = mk; }
    return e;
  }
  /** One attribute from i; returns the index after it, or -1 when the tag is not JSX after all. */
  private attr(i: number, start: number, cls: { v: string[] | null }): number {
    const { src, n } = this;
    let k = i + 1;
    while (k < n && /[\w$:.-]/.test(src[k])) k++;
    const attr = src.slice(i, k);
    let v = this.ws(k);
    if (src[v] !== '=') { this.paint(i, k); return k; }
    v = this.ws(v + 1);
    const q = src[v];
    const isCls = attr === 'className' || attr === 'class';
    let e: number;
    if (q === '"' || q === "'") {
      e = src.indexOf(q, v + 1);
      if (e < 0) return -1;
      if (isCls) cls.v = (cls.v || []).concat(src.slice(v + 1, e).split(/\s+/).filter(Boolean));
      else this.paint(i, e + 1);
    } else if (q === '{') {
      if (isCls) this.inClass++;
      e = this.js(v + 1, true);
      if (isCls) this.inClass--;
      if (e >= n) return -1;
      if (isCls) cls.v = (cls.v || []).concat(clsLits(src.slice(v + 1, e)));
      else { this.paint(i, v); this.write(v, e + 1, '"' + src.slice(v + 1, e).replace(/[^\w$.\-/:#@]+/g, ' ') + '"'); }
    } else if (q === '<') {
      e = this.el(v) - 1;
      if (e < 0) return -1;
      this.blank(i, e + 1);
    } else return -1;
    if (isCls && cls.v) this.write(i, e + 1, 'class="' + cls.v.join(' ').replace(/"/g, "'").replace(/[<>]/g, ' ') + '"');
    void start;
    return e + 1;
  }
  private tag(start: number): number {
    const { src, n } = this;
    let i = start + 1;
    if (src[i] === '>') return this.kids(i + 1, '');
    let j = i;
    while (j < n && /[\w$.:-]/.test(src[j])) j++;
    const name = src.slice(i, j);
    this.paint(start, j);
    i = j;
    const cls: { v: string[] | null } = { v: null };
    for (;;) {
      i = this.gap(i);
      if (i >= n) return -1;
      const c = src[i];
      if (c === '/' && src[i + 1] === '>') { this.paint(i, i + 2); if (cls.v) this.classes.push([start, cls.v]); return i + 2; }
      if (c === '>') { this.paint(i, i + 1); i++; break; }
      if (c === '{') { const e = this.js(i + 1, true); if (e >= n) return -1; this.blank(i, e + 1); i = e + 1; continue; }
      if (!/[A-Za-z_$]/.test(c)) return -1;
      i = this.attr(i, start, cls);
      if (i < 0) return -1;
    }
    if (cls.v) this.classes.push([start, cls.v]);
    return this.kids(i, name);
  }
  private kids(i: number, name: string): number {
    const { src, n } = this;
    while (i < n) {
      const c = src[i];
      if (c === '{') { const e = this.js(i + 1, true); if (e >= n) return -1; i = e + 1; continue; }
      if (c === '<') {
        if (src[i + 1] === '/') {
          const k = this.ws(i + 2);
          let j = k;
          while (j < n && /[\w$.:-]/.test(src[j])) j++;
          const e = this.ws(j);
          if (src[e] !== '>' || src.slice(k, j) !== name) return -1;
          if (name) this.paint(i, e + 1);
          return e + 1;
        }
        if (/[A-Za-z_$>]/.test(src[i + 1] || '')) { const e = this.el(i); if (e > 0) { i = e; continue; } }
        i++;
        continue;
      }
      this.out[i] = c;
      if (i >= this.hi) this.hi = i + 1;
      i++;
    }
    return -1;
  }
}

export function jsxPseudo(src: string): { pseudo: string; classAt: Map<number, string[]>; calls: number[] } {
  const scanner = new JsxScanner(src);
  const pseudo = scanner.pseudo();
  return { pseudo, classAt: new Map(scanner.classes), calls: scanner.calls };
}

/** The class tokens inside each helper call (cn(...), clsx(...)) that starts at one of the sites. */
export function classCalls(src: string, sites: number[]): ClassCall[] {
  const out: ClassCall[] = [];
  let last = -1;
  for (const pos of [...sites].sort((a, b) => a - b)) {
    if (pos < last) continue;
    const open = src.indexOf('(', pos);
    if (open < 0) continue;
    let depth = 0, i = open;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; continue; }
      if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 1; continue; }
      if (c === '"' || c === "'" || c === '`') { i++; while (i < src.length && src[i] !== c) { if (src[i] === '\\') i++; i++; } continue; }
      if (c === '(') depth++;
      else if (c === ')' && --depth === 0) break;
    }
    last = i;
    const toks = clsLits(src.slice(open + 1, i));
    if (toks.length) out.push({ pos, name: /^[\w$]+/.exec(src.slice(pos))![0], toks });
  }
  return out;
}

/** Positions of class-helper calls inside <script> blocks (and Astro frontmatter). */
export function scriptSites(src: string, kind: DocKind): number[] {
  const ranges: Array<[number, number]> = [];
  for (const m of src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) ranges.push([m.index! + m[0].length - m[1].length - 9, m.index! + m[0].length - 9]);
  const fm = kind === 'astro' ? FRONTMATTER.exec(src) : null;
  if (fm) ranges.push([0, fm[0].length]);
  const sites: number[] = [];
  for (const [a, b] of ranges) {
    for (const m of src.slice(a, b).matchAll(/(?<![\w$.])(?:cn|clsx|classNames|classnames|twMerge|twJoin|cva|cx|tv)\s*\(/g)) sites.push(a + m.index!);
  }
  return sites;
}

export function docKindOf(file: string): DocKind | null {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.jsx' || ext === '.tsx') return 'jsx';
  if (ext === '.vue' || ext === '.svelte' || ext === '.astro') return ext.slice(1) as DocKind;
  return null;
}

/** Parse a page or component file into a Doc; kind comes from the extension. */
export function parseDoc(file: string, raw: string): Doc {
  const kind = docKindOf(file) ?? 'html';
  if (kind === 'jsx') {
    const j = jsxPseudo(raw);
    const doc = parseHtml(file, j.pseudo, 'jsx');
    doc.styles = [];
    doc.scripts = raw;
    doc.classAt = j.classAt;
    doc.virtuals = classCalls(raw, j.calls);
    doc.raw = raw;
    return doc;
  }
  const doc = parseHtml(file, kind === 'html' ? raw : templateMask(raw, kind), kind);
  doc.raw = raw;
  doc.virtuals = kind === 'html' ? [] : classCalls(raw, scriptSites(raw, kind));
  return doc;
}

export function getAttr(attrStr: string, name: string): string | null {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>/]+))`, 'i');
  const m = re.exec(attrStr);
  if (!m) return null;
  return m[2] ?? m[3] ?? m[4] ?? '';
}

export function hasAttr(attrStr: string, name: string): boolean {
  return new RegExp(`(?:^|\\s)${name}(?=[\\s=/]|$)`, 'i').test(attrStr);
}

export interface Child { name: string; open: string; html: string; idx: number }

/** The direct element children of the tag at idx, each with its open tag, outer HTML and tag index. */
export function directChildren(doc: Doc, idx: number): Child[] {
  const open = doc.tags[idx];
  if (open.close || open.selfClosing) return [];
  const children: Child[] = [];
  let depth = 1;
  let childStart = -1, childOpen: Tag | null = null, childIdx = -1;
  for (let i = idx + 1; i < doc.tags.length; i++) {
    const t = doc.tags[i];
    if (t.close) {
      depth--;
      if (depth === 0) break;
      if (depth === 1 && childOpen) {
        children.push({ name: childOpen.name, open: doc.src.slice(childOpen.pos, childOpen.end), html: doc.src.slice(childStart, t.end), idx: childIdx });
        childOpen = null;
      }
      continue;
    }
    if (depth === 1) {
      if (t.selfClosing) children.push({ name: t.name, open: doc.src.slice(t.pos, t.end), html: doc.src.slice(t.pos, t.end), idx: i });
      else { childStart = t.pos; childOpen = t; childIdx = i; }
    }
    if (!t.selfClosing) depth++;
  }
  return children;
}

/** For every open tag index, the names of its open ancestors, outermost first. */
export function ancestorMap(doc: Doc): Map<number, string[]> {
  const cached = doc.cache.ancestors as Map<number, string[]> | undefined;
  if (cached) return cached;
  const map = new Map<number, string[]>();
  const stack: string[] = [];
  for (let i = 0; i < doc.tags.length; i++) {
    const t = doc.tags[i];
    if (t.close) { stack.pop(); continue; }
    map.set(i, stack.slice());
    if (!t.selfClosing) stack.push(t.name);
  }
  doc.cache.ancestors = map;
  return map;
}

/** Visible text of an HTML fragment with the common entities decoded and whitespace folded. */
export function plainText(html: string): string {
  return html.replace(/<[^>]*>/g, ' ')
    .replace(/&middot;|&#0?183;|&#x0?b7;/gi, '·').replace(/&bull;|&#8226;|&#x2022;/gi, '•').replace(/&mdash;|&#8212;|&#x2014;/gi, '\u2014').replace(/&ndash;|&#8211;|&#x2013;/gi, '\u2013')
    .replace(/&rarr;|&#8594;|&#x2192;|&xrarr;|&#10230;/gi, '\u2192').replace(/&raquo;|&#187;|&#xbb;/gi, '\u00bb').replace(/&rsaquo;|&#8250;|&#x203a;/gi, '\u203a')
    .replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&rsquo;|&lsquo;|&#8217;|&#8216;|&#x2019;|&#x2018;/gi, '\u2019').replace(/&rdquo;|&ldquo;|&#8220;|&#8221;/gi, '"')
    .replace(/&#\d+;|&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ').trim();
}

/** The inner HTML of the element opened at idx and the position its close tag starts. */
export function innerOf(doc: Doc, idx: number): { inner: string; endPos: number } | null {
  const open = doc.tags[idx];
  if (open.close || open.selfClosing) return null;
  let depth = 1;
  for (let i = idx + 1; i < doc.tags.length; i++) {
    const t = doc.tags[i];
    if (t.selfClosing) continue;
    if (t.close) { depth--; if (depth === 0) return { inner: doc.src.slice(open.end, t.pos), endPos: t.pos }; }
    else depth++;
  }
  return { inner: doc.src.slice(open.end), endPos: doc.src.length };
}

/** The index of the tag that closes the element opened at idx (or the last tag). */
export function closeIndex(doc: Doc, idx: number): number {
  let depth = 1;
  for (let i = idx + 1; i < doc.tags.length; i++) {
    const t = doc.tags[i];
    if (t.selfClosing) continue;
    if (t.close) { depth--; if (depth === 0) return i; } else depth++;
  }
  return doc.tags.length - 1;
}

// sloplint proseRun
const proseRun = (run: string): string => {
  let r = run;
  for (let k = 0; k < 3 && /\{[^{}]*\}/.test(r); k++) r = r.replace(/\{[^{}]*\}/g, pad);
  return /[;=(){}]|\breturn\b/.test(r) ? pad(r) : r;
};

/** The document's prose: tags, comments, scripts, styles and code blanked with positions preserved; component text runs that read as code are blanked too. */
// sloplint maskedProse
export function maskedProse(doc: Doc): string {
  const cached = doc.cache.prose as string | undefined;
  if (cached != null) return cached;
  const src = doc.kind !== 'html' ? doc.src.replace(/(^|>)([^<>]*)(?=<|$)/g, (_m0, a: string, run: string) => a + proseRun(run)) : doc.src;
  const prose = src
    .replace(/<(script|style|pre|code|kbd|samp|textarea)\b[^>]*>[\s\S]*?<\/\1>/gi, pad)
    .replace(/<!--[\s\S]*?-->/g, pad)
    .replace(/<[^>]*>/g, pad);
  doc.cache.prose = prose;
  return prose;
}

export const wordsOf = (t: string): string[] => plainText(t).split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w));
