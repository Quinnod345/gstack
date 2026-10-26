/**
 * The static tier: collect files, group them into contexts (a page with the
 * stylesheets it links, or a directory of components), build the token table,
 * run every rule family, then apply the page's waivers.
 *
 * Ported from Nutlope/hallmark's sloplint.mjs (collectFiles, buildContext,
 * shareProjects; MIT, see NOTICE.md).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LintContext, SharedStyles, CssFile } from './context';
import { buildTokens, isTokenRule, parseCss, stripComments, type CssRule, type Tokens } from './css';
import { docKindOf, getAttr, parseDoc, type Doc } from './html';
import { Reporter, type Finding } from './report';
import { FAMILIES } from './rules';
import { twVariants } from './tailwind';
import { applyWaivers, findWaivers, resolveWaivers } from './waivers';

export interface StaticOptions {
  scope?: 'page' | 'component';
  job?: string | null;
  cwd?: string;
  /** Receives a line for every file skipped or rule that threw; defaults to stderr. */
  warn?: (line: string) => void;
}

export interface StaticResult {
  files: string[];
  contexts: LintContext[];
  findings: Finding[];
}

const BUILD_DIRS = new Set(['dist', 'build', 'coverage']);

/** Every .css page and component file under the paths; node_modules, dot folders and (below the top) build output are skipped. */
export function collectFiles(paths: string[], warn: (l: string) => void = () => {}): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  const visit = (p: string, top: boolean) => {
    const abs = path.resolve(p);
    if (seen.has(abs)) return;
    let st: fs.Stats;
    try { st = fs.statSync(abs); } catch { warn(`design-lint: cannot read ${p}`); return; }
    if (st.isDirectory()) {
      const base = path.basename(abs);
      if (base === 'node_modules' || base.startsWith('.') || (!top && BUILD_DIRS.has(base))) return;
      for (const e of fs.readdirSync(abs).sort()) visit(path.join(abs, e), false);
      return;
    }
    if (path.extname(abs).toLowerCase() === '.css' || docKindOf(abs)) { seen.add(abs); files.push(abs); }
  };
  for (const p of paths) visit(p, true);
  return files;
}

const localRef = (href: string | null): string | null => (href && !/^(?:[a-z]+:|\/\/)/i.test(href) ? href.split(/[?#]/)[0] : null);

export function importsOf(css: string, from: string): string[] {
  const out: string[] = [];
  for (const m of stripComments(css).matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?/gi)) {
    const ref = localRef(m[1]);
    if (ref) out.push(path.resolve(from, ref));
  }
  return out;
}

export function linksOf(doc: Doc, from: string): string[] {
  const out: string[] = [];
  for (const t of doc.tags) {
    if (t.close || t.name !== 'link' || !/stylesheet/i.test(getAttr(t.attrs, 'rel') || '')) continue;
    const ref = localRef(getAttr(t.attrs, 'href'));
    if (ref) out.push(path.resolve(from, ref));
  }
  return out;
}

const readCss = (f: string): string | null => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

/** Follow @import and <link rel=stylesheet> from the group's files to every local .css they reach. */
function attachStylesheets(cssFiles: CssFile[], rules: CssRule[], pending: string[], inGroup: Set<string>): void {
  while (pending.length) {
    const p = pending.shift()!;
    if (inGroup.has(p) || path.extname(p).toLowerCase() !== '.css' || !fs.existsSync(p)) continue;
    inGroup.add(p);
    const raw = readCss(p);
    if (raw == null) continue;
    cssFiles.push({ file: p, raw, attached: true });
    rules.push(...parseCss(raw, p));
    pending.push(...importsOf(raw, path.dirname(p)));
  }
}

export function buildContext(key: string, cssList: string[], docList: Doc[], opts: StaticOptions): LintContext {
  const cssFiles: CssFile[] = [];
  const rules: CssRule[] = [];
  const inGroup = new Set<string>([...cssList, ...docList.map((d) => d.file)]);
  const pending: string[] = [];
  for (const f of cssList) {
    const raw = readCss(f) ?? '';
    cssFiles.push({ file: f, raw });
    rules.push(...parseCss(raw, f));
    pending.push(...importsOf(raw, path.dirname(f)));
  }
  for (const doc of docList) {
    for (const st of doc.styles) {
      rules.push(...parseCss(st.css, doc.file, st.lineOffset));
      pending.push(...importsOf(st.css, path.dirname(doc.file)));
    }
    pending.push(...linksOf(doc, path.dirname(doc.file)));
  }
  attachStylesheets(cssFiles, rules, pending, inGroup);
  const allCss = cssFiles.map((c) => c.raw).join('\n') + '\n' + docList.map((d) => d.styles.map((st) => st.css).join('\n')).join('\n');
  return {
    key, rules, tokens: buildTokens(rules), docs: docList, cssFiles, allCss,
    scope: opts.scope ?? 'page', job: opts.job ?? null,
    tokensOnly: !docList.length && rules.length > 0 && rules.every(isTokenRule),
    shared: null, twTokens: null, cache: {},
  };
}

/** The .css files a page reaches through <link> and @import, transitively. */
function linkedCss(page: Doc): Set<string> {
  const linked = new Set<string>();
  const queue = [...linksOf(page, path.dirname(page.file)), ...page.styles.flatMap((st) => importsOf(st.css, path.dirname(page.file)))];
  while (queue.length) {
    const q = queue.shift()!;
    if (linked.has(q) || !fs.existsSync(q) || path.extname(q).toLowerCase() !== '.css') continue;
    linked.add(q);
    const raw = readCss(q);
    if (raw != null) queue.push(...importsOf(raw, path.dirname(q)));
  }
  return linked;
}

/** One context per page (with its own stylesheets), plus one per directory for components and unlinked CSS. */
export function groupContexts(files: string[], opts: StaticOptions, warn: (l: string) => void): LintContext[] {
  const groups = new Map<string, { css: string[]; docs: string[] }>();
  for (const f of files) {
    const dir = path.dirname(f);
    if (!groups.has(dir)) groups.set(dir, { css: [], docs: [] });
    const g = groups.get(dir)!;
    if (path.extname(f).toLowerCase() === '.css') g.css.push(f); else g.docs.push(f);
  }
  const contexts: LintContext[] = [];
  for (const [dir, g] of groups) {
    const docs: Doc[] = [];
    for (const f of g.docs) {
      try { docs.push(parseDoc(f, fs.readFileSync(f, 'utf8'))); } catch (e) { warn(`design-lint: skipped ${f}, it could not be parsed (${(e as Error).message})`); }
    }
    const pages = docs.filter((d) => d.kind === 'html');
    const parts = docs.filter((d) => d.kind !== 'html');
    if (!pages.length) { contexts.push(buildContext(dir, g.css, parts, opts)); continue; }
    const used = new Set<string>();
    for (const page of pages) {
      const linked = linkedCss(page);
      const own = pages.length === 1 ? g.css : g.css.filter((c) => linked.has(c));
      own.forEach((c) => used.add(c));
      for (const c of linked) used.add(c);
      contexts.push(buildContext(page.file, own, [page], opts));
    }
    const rest = g.css.filter((c) => !used.has(c));
    if (rest.length || parts.length) contexts.push(buildContext(dir, rest, parts, opts));
  }
  return contexts;
}

const projectRoots = new Map<string, string | null>();
function projectRoot(dir: string): string | null {
  if (projectRoots.has(dir)) return projectRoots.get(dir)!;
  const up = path.dirname(dir);
  const root = fs.existsSync(path.join(dir, 'package.json')) ? dir : up === dir ? null : projectRoot(up);
  projectRoots.set(dir, root);
  return root;
}

/**
 * Within one package, a directory of components without its own stylesheet
 * borrows the project's tokens and its global state styles, so a focus ring
 * declared once in globals.css is not reported missing on every component.
 */
export function shareProjects(contexts: LintContext[]): void {
  const byRoot = new Map<string, LintContext[]>();
  for (const ctx of contexts) {
    const root = projectRoot(fs.existsSync(ctx.key) && fs.statSync(ctx.key).isDirectory() ? ctx.key : path.dirname(ctx.key));
    if (!root) continue;
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root)!.push(ctx);
  }
  for (const list of byRoot.values()) {
    const parts = list.filter((c) => !c.cssFiles.length && c.docs.length && c.docs.every((d) => d.kind !== 'html'));
    if (!parts.length || parts.length === list.length) continue;
    const tokens: Tokens = {};
    const shared: SharedStyles = { focus: false, active: false, disabled: false, reducedMotion: false };
    for (const c of list) {
      Object.assign(tokens, c.tokens);
      const tv = twVariants(c);
      const sel = (re: RegExp) => c.rules.some((r) => re.test(r.selector));
      shared.focus = shared.focus || sel(/:focus/) || [...tv].some((v) => /^focus/.test(v));
      shared.active = shared.active || sel(/:active/) || tv.has('active');
      shared.disabled = shared.disabled || sel(/:disabled|\[disabled\]|aria-disabled/) || tv.has('disabled') || tv.has('aria-disabled');
      shared.reducedMotion = shared.reducedMotion || /prefers-reduced-motion/i.test(stripComments(c.allCss)) || tv.has('motion-reduce') || tv.has('motion-safe');
    }
    for (const c of list) c.shared = shared;
    for (const c of parts) { c.twTokens = { ...tokens, ...c.tokens }; delete c.cache.tw; }
  }
}

/** The waiver comments of a context: in its documents and its own stylesheets. */
export function contextWaivers(ctx: LintContext, cwd: string) {
  const claims = [
    ...ctx.docs.flatMap((d) => findWaivers(d.file, d.raw)),
    ...ctx.cssFiles.filter((c) => !c.attached).flatMap((c) => findWaivers(c.file, c.raw)),
  ];
  return resolveWaivers(claims, ctx.docs.map((d) => d.text).join(' '), cwd);
}

export function lintStatic(paths: string[], opts: StaticOptions = {}): StaticResult {
  const warn = opts.warn ?? ((l: string) => console.error(l));
  const cwd = opts.cwd ?? process.cwd();
  const files = collectFiles(paths, warn);
  const contexts = groupContexts(files, opts, warn);
  shareProjects(contexts);
  const findings: Finding[] = [];
  for (const ctx of contexts) {
    const reporter = new Reporter(ctx.scope, cwd);
    for (const family of FAMILIES) {
      try { family.run(ctx, reporter); } catch (e) {
        warn(`design-lint: internal error in ${family.name} rules for ${ctx.key}: ${(e as Error).message}`);
      }
    }
    findings.push(...applyWaivers(reporter.findings, contextWaivers(ctx, cwd)));
  }
  return { files, contexts, findings };
}
