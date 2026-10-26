/**
 * CSS reading for the design lint: a comment-stripping, nesting-aware rule
 * walker (no parser dependency), the token block (custom properties declared
 * on :root, html or a data-theme scope, or in tokens.css / @theme), var()
 * resolution with fallbacks, and the small unit helpers the rules share.
 *
 * Ported from Nutlope/hallmark's sloplint.mjs (parseCss, buildTokens,
 * resolveVars, styleIndex and kin; MIT, see NOTICE.md), rewritten in TypeScript.
 */
import * as path from 'node:path';

export interface CssDecl {
  prop: string;
  value: string;
  line: number;
}

export interface CssRule {
  selector: string;
  decls: CssDecl[];
  /** The @media query text this rule sits under, or null. */
  media: string | null;
  /** The @keyframes name this rule belongs to, or null for ordinary rules. */
  keyframes: string | null;
  file: string;
  line: number;
}

/** Blank out comments and keep string literals, preserving every newline so line numbers hold. */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    if (src[i] === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (src[i] === '"' || src[i] === "'") {
      const q = src[i];
      let j = i + 1;
      while (j < src.length && src[j] !== q) { if (src[j] === '\\') j++; j++; }
      out += src.slice(i, Math.min(j + 1, src.length));
      i = j + 1;
    } else { out += src[i]; i++; }
  }
  return out;
}

/** A binary search from newline offsets to a 1-based line number. */
export function lineIndex(src: string, lineOffset = 0): (pos: number) => number {
  const nl: number[] = [];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') nl.push(i);
  return (pos: number) => {
    let lo = 0, hi = nl.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (nl[mid] < pos) lo = mid + 1; else hi = mid; }
    return lo + 1 + lineOffset;
  };
}

/** Replace nested blocks inside [s, e) with spaces so the remaining text holds only this rule's own declarations. */
function flatBody(src: string, s: number, e: number): string {
  const out = src.slice(s, e).split('');
  let depth = 0, edge = -1;
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (c === '{') {
      if (depth === 0) for (let k = edge + 1; k < i; k++) if (out[k] !== '\n') out[k] = ' ';
      depth++; out[i] = ' ';
    } else if (c === '}') {
      depth = Math.max(0, depth - 1); out[i] = ' ';
      if (depth === 0) edge = i;
    } else if (depth > 0) { if (c !== '\n') out[i] = ' '; }
    else if (c === ';') edge = i;
  }
  return out.join('');
}

/** Expand a nested selector against its parent: `&` is replaced, a bare selector is descendant-joined. */
function nestSelector(sel: string, parent: string): string {
  const p = parent.includes(',') ? `:is(${parent})` : parent;
  return splitTop(sel).map((part) => part.includes('&') ? part.trim().replace(/&/g, p) : `${p} ${part.trim()}`).join(', ');
}

/** Faces that read as monospace, whether they arrive as a token, a utility or a declaration; one list so every check classifies a face the same way. */
export const MONO_FACE = /(?:^|[\s"'-])mono(?:space)?\b|\bcode\b|courier|silkscreen|jetbrains|plex mono|geist mono|\bcommit\b|fira code|space mono|dm mono|roboto mono|source code|ibm plex mono|press start|vt323|share tech/i;

/** The tracked-caps label: tracking past this (em) on text at or under LABEL_PX reads as the reflex, in CSS and in Tailwind alike. */
export const TRACKED_EM = 0.03;
export const LABEL_PX = 15;

/** Real stylesheets nest a handful of levels; past this the rest reads as the parent's body instead of recursing. */
const MAX_NESTING = 64;

/**
 * Parse a stylesheet into flat rules. Nested rules, @media / @supports /
 * @layer / @container / @scope blocks, @keyframes, @font-face and Tailwind's
 * @theme are all walked; every other at-rule is skipped whole.
 */
export function parseCss(source: string, file: string, lineOffset = 0): CssRule[] {
  const src = stripComments(source);
  const lineOf = lineIndex(src, lineOffset);
  const rules: CssRule[] = [];
  const makeRule = (selector: string, s: number, e: number, media: string | null, keyframes: string | null): CssRule => {
    const body = flatBody(src, s, e);
    const decls: CssDecl[] = [];
    let off = 0;
    for (const part of body.split(';')) {
      const idx = part.indexOf(':');
      if (idx > 0) {
        const prop = part.slice(0, idx).trim().toLowerCase();
        const value = part.slice(idx + 1).trim().replace(/!important\s*$/i, '').trim();
        if (prop && value && /^-{0,2}[a-z]/.test(prop) && !/[{}]/.test(prop)) decls.push({ prop, value, line: lineOf(s + off + idx) });
      }
      off += part.length + 1;
    }
    return { selector, decls, media, keyframes, file, line: lineOf(s) };
  };
  const walk = (start: number, end: number, media: string | null, keyframes: string | null, parent: string | null = null, depthLeft = MAX_NESTING): void => {
    let i = start;
    while (i < end) {
      while (i < end && /[\s;]/.test(src[i])) i++;
      if (i >= end) break;
      let j = i;
      while (j < end && src[j] !== '{' && src[j] !== '}' && src[j] !== ';') j++;
      if (j >= end) break;
      if (src[j] === '}' || src[j] === ';') { i = j + 1; continue; }
      const selector = src.slice(i, j).trim().replace(/\s+/g, ' ');
      const blockStart = j + 1;
      let depth = 1, k = blockStart;
      while (k < end && depth > 0) {
        const ch = src[k];
        if (ch === '"' || ch === "'") { const q = src.indexOf(ch, k + 1); k = q < 0 || q >= end ? end : q + 1; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        k++;
      }
      const blockEnd = Math.max(blockStart, k - 1);
      if (selector.startsWith('@')) {
        if (/^@(media|supports|layer|container|scope)/i.test(selector)) {
          const q = /^@media/i.test(selector) ? selector.replace(/^@media/i, '').trim() : media;
          if (parent) rules.push(makeRule(parent, blockStart, blockEnd, q, keyframes));
          walk(blockStart, blockEnd, q, keyframes, parent, depthLeft - 1);
        } else if (/^@(-webkit-)?keyframes/i.test(selector)) {
          const name = selector.replace(/^@(-webkit-)?keyframes/i, '').trim();
          walk(blockStart, blockEnd, media, name || 'anon', null, depthLeft - 1);
        } else if (/^@font-face/i.test(selector)) {
          rules.push(makeRule('@font-face', blockStart, blockEnd, media, null));
        } else if (/^@theme\b/i.test(selector)) {
          rules.push(makeRule('@theme', blockStart, blockEnd, media, null));
          walk(blockStart, blockEnd, media, keyframes, null, depthLeft - 1);
        }
      } else {
        const sel = parent && !keyframes ? nestSelector(selector, parent) : selector;
        rules.push(makeRule(sel, blockStart, blockEnd, media, keyframes));
        if (!keyframes && depthLeft > 0 && src.slice(blockStart, blockEnd).includes('{')) walk(blockStart, blockEnd, media, keyframes, sel, depthLeft - 1);
      }
      i = k;
    }
  };
  walk(0, src.length, null, null);
  return rules;
}

export type Tokens = Record<string, string>;

const TOKEN_SEL = /^(?:html|:root)?(?:\[data-(?:theme|mode|scheme)[^\]]*\]|:root|:not\([^)]*\))*$/i;

/** Whether a rule belongs to the token block: :root / html / a data-theme scope, @font-face, @theme, or anything in tokens.css. */
export function isTokenRule(rule: Pick<CssRule, 'selector' | 'file'>): boolean {
  if (rule.selector === '@font-face' || rule.selector === '@theme' || path.basename(rule.file).toLowerCase() === 'tokens.css') return true;
  return rule.selector.split(',').every((p) => { const t = p.trim(); return t && TOKEN_SEL.test(t); });
}

/** Every custom property declared in the token block, last declaration winning. */
export function buildTokens(rules: CssRule[]): Tokens {
  const tokens: Tokens = {};
  for (const r of rules) {
    if (!isTokenRule(r)) continue;
    for (const d of r.decls) if (d.prop.startsWith('--')) tokens[d.prop] = d.value;
  }
  return tokens;
}

/** Substitute var() references from the tokens (a local scope first), honouring fallbacks, five levels deep. */
export function resolveVars(value: string, tokens: Tokens, local: Tokens | null = null, depth = 0): string {
  if (!value || depth > 5 || !value.includes('var(')) return value;
  const out = value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g, (m0, name: string, fb: string | undefined) => {
    const v = local && local[name] != null ? local[name] : tokens[name];
    if (v != null) return v;
    if (fb != null) return fb.trim();
    return m0;
  });
  if (out === value) return out;
  return resolveVars(out, tokens, local, depth + 1);
}

/** A family's identity ignores spaces, hyphens and underscores, so "GeistSans" and "Geist Sans" are one face. */
export const famKey = (f: string | null | undefined): string => String(f || '').replace(/[\s_-]+/g, '');

export function firstFamily(value: string): string {
  return value.split(',')[0].trim().replace(/^['"]|['"]$/g, '').toLowerCase();
}

/** px, rem or em lengths to px at a 16px root; anything else is null. */
export function pxOf(value: string): number | null {
  const m = /^(-?\d+(?:\.\d+)?)(px|rem|em)$/.exec(value.trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  return m[2] === 'px' ? n : n * 16;
}

export const GENERIC_FAMILIES = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-monospace', 'ui-serif', 'ui-sans-serif', 'ui-rounded', 'math', 'emoji', 'fangsong', 'inherit', 'initial', 'unset']);

export const HEADING_SEL = /(^|[\s,>+~(])h[1-6]\b|__title|__display|__headline|hero__(title|display|headline|h\d)|wordmark|masthead|display/i;

export function selectorIsInteractive(sel: string): boolean {
  return /(^|[\s,>+~(])(a|button|input|select|textarea|summary)\b|\.(btn|button|cta|link|tab|chip|control)/i.test(sel);
}

/** Split a value at top-level commas (gradient stops, font lists), leaving parentheses intact. */
export function splitTop(v: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = '';
  for (const c of v) {
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export interface MergedRule { selector: string; media: string | null; decls: CssDecl[]; file: string; line: number }

/** Rules folded by selector and media query, keyframes and @font-face excluded. */
export function mergeBySelector(rules: CssRule[]): MergedRule[] {
  const map = new Map<string, MergedRule>();
  for (const r of rules) {
    if (r.keyframes || r.selector === '@font-face') continue;
    const key = r.selector + '@@' + (r.media || '');
    if (!map.has(key)) map.set(key, { selector: r.selector, media: r.media, decls: [], file: r.file, line: r.line });
    map.get(key)!.decls.push(...r.decls);
  }
  return [...map.values()];
}

export interface StyleEntry { classes: string[]; tag: string | null; decls: CssDecl[]; state: boolean; seq: number }

/** Entries in source order, plus the same entries keyed by their first class or, for class-less compounds, by tag, so a lookup reads only the entries that can match. */
export type StyleIndex = StyleEntry[] & { byClass?: Map<string, StyleEntry[]>; byTag?: Map<string, StyleEntry[]> };

/** The last compound of every selector, indexed by class and tag, so an element's resting styles can be looked up. */
export function buildStyleIndex(rules: CssRule[]): StyleIndex {
  const entries: StyleIndex = [];
  const byClass = new Map<string, StyleEntry[]>();
  const byTag = new Map<string, StyleEntry[]>();
  for (const r of rules) {
    if (r.keyframes || r.selector === '@font-face') continue;
    if (r.media && /max-width/i.test(r.media)) continue;
    for (const part of r.selector.split(',')) {
      const compound = part.trim().split(/[\s>+~]+/).filter(Boolean).pop();
      if (!compound) continue;
      const cleaned = compound.replace(/::?[a-z-]+(\([^)]*\))?/gi, '').replace(/\[[^\]]*\]/g, '');
      const classes = (cleaned.match(/\.[a-zA-Z_][\w-]*/g) || []).map((c) => c.slice(1));
      const tagM = /^([a-zA-Z][\w-]*)/.exec(cleaned);
      const tag = tagM ? tagM[1].toLowerCase() : null;
      if (!classes.length && !tag) continue;
      const entry: StyleEntry = { classes, tag, decls: r.decls, state: /:(hover|active|focus|focus-visible|focus-within|disabled|checked|visited|target)\b|::?(before|after|marker|placeholder|selection|backdrop)\b/i.test(compound), seq: entries.length };
      entries.push(entry);
      const bucket = classes.length ? byClass : byTag;
      const key = classes.length ? classes[0] : tag!;
      if (!bucket.has(key)) bucket.set(key, []);
      bucket.get(key)!.push(entry);
    }
  }
  entries.byClass = byClass;
  entries.byTag = byTag;
  return entries;
}

/** The declarations that apply to an element with this class attribute and tag, in source order; restingOnly drops state and pseudo-element rules. */
export function stylesFor(index: StyleIndex, classAttr: string | null | undefined, tagName: string, restingOnly = false): CssDecl[] {
  const have = new Set(String(classAttr || '').split(/\s+/).filter(Boolean));
  const candidates: StyleEntry[] = index.byClass
    ? [...(index.byTag?.get(tagName) ?? []), ...[...have].flatMap((c) => index.byClass!.get(c) ?? [])].sort((a, b) => a.seq - b.seq)
    : index;
  const decls: CssDecl[] = [];
  for (const e of candidates) {
    if (restingOnly && e.state) continue;
    if (e.tag && e.tag !== tagName) continue;
    if (!e.classes.every((c) => have.has(c))) continue;
    for (const d of e.decls) decls.push(d);
  }
  return decls;
}

/** The last value of a property in a declaration list, with tokens resolved. */
export function declValue(decls: CssDecl[], prop: string, tokens: Tokens): string | null {
  let v: string | null = null;
  for (const d of decls) if (d.prop === prop) v = d.value;
  return v == null ? null : resolveVars(v, tokens);
}

export function fontPxOf(decls: CssDecl[], tokens: Tokens): number | null {
  const v = declValue(decls, 'font-size', tokens);
  if (!v) return null;
  const clamped = /clamp\(\s*([^,]+),/.exec(v);
  return pxOf(clamped ? clamped[1].trim() : v);
}

export function trackingEmOf(decls: CssDecl[], tokens: Tokens, fontPx: number | null): number | null {
  const v = declValue(decls, 'letter-spacing', tokens);
  if (!v) return null;
  const m = /^(-?\d*\.?\d+)em$/.exec(v.trim());
  if (m) return parseFloat(m[1]);
  const px = pxOf(v);
  if (px == null || !fontPx) return null;
  return px / fontPx;
}
