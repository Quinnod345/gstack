/**
 * Chrome rules, the copy half (sloplint gate 19, the hero half of gate 42 and
 * the two-filled-buttons half of F4; Nutlope/hallmark, MIT, see NOTICE.md),
 * rewritten in gstack's voice. Rule ids: aphoristic-cadence,
 * generic-hero-copy, generic-cta-copy, em-dash-overuse, template-footer-line,
 * two-primary-buttons. Also holds the prose mask the chrome and finish
 * families share. Placeholder names, brands, lorem and buzzwords are the copy
 * tier's (rules/copy.ts) and are not reported here.
 */
import { styleFor, type LintContext } from '../context';
import { resolveVars } from '../css';
import { ancestorMap, getAttr, innerOf, plainText, type Doc, type Tag } from '../html';
import { trunc, type Reporter } from '../report';

const pad = (m: string): string => m.replace(/[^\n]/g, ' ');

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

// sloplint TELLS19 (gate 19), less the lines the copy tier owns
const HERO_TELLS: Array<[RegExp, string]> = [
  [/\bwhether you['’]?re\b/i, 'a filler opener'],
  [/\bbuilt for the modern\b/i, 'a filler opener'],
  [/\bin today['’]s\b/i, 'a filler opener'],
  [/\bquietly (?:trusted|in use)\b/i, 'the quiet-proof line'],
  [/\bwe['’]?ve got you covered\b/i, 'a stock line'],
  [/\bsay goodbye to\b/i, 'a stock line'],
  [/\bno credit card required\b/i, 'a template line'],
  [/\beverything you need to\b/i, 'a stock line'],
  [/\ball in one place\b/i, 'a stock line'],
  [/\bmade with\s*(?:♥|❤|\u{1f9e1}|\u{1f49b}|\u{1f49a}|\u{1f499}|\u{1f49c}|\u{1f5a4}|\u{1f90d}|&hearts;|&#9829;|&#10084;|<3)/iu, 'the made-with-a-heart line'],
];
const FOOTER_LINE = /\ball rights reserved\b/i;
const STOCK_LINK = /^(learn more|read more|find out more|click here|more info|see more)$/i;

// sloplint check19Tells (gate 19)
function checkHeroCopy(ctx: LintContext, r: Reporter): void {
  for (const doc of ctx.docs) {
    const prose = maskedProse(doc);
    const lines = new Set<number>();
    const tell = (rule: string, idx: number, what: string, text: string): void => {
      const line = doc.lineOf(idx);
      if (lines.has(line)) return;
      lines.add(line);
      r.report(rule, doc.file, line, `${what}: "${trunc(text, 40)}"`);
    };
    for (const [re, what] of HERO_TELLS) {
      const m = re.exec(prose);
      if (m) tell('generic-hero-copy', m.index, what, m[0]);
    }
    const footer = FOOTER_LINE.exec(prose);
    if (footer) tell('template-footer-line', footer.index, 'a stock footer line', footer[0]);
    const stock: Array<{ t: Tag; label: string }> = [];
    for (let i = 0; i < doc.tags.length; i++) {
      const t = doc.tags[i];
      if (t.close) continue;
      if (t.name === 'a') {
        const label = plainText(innerOf(doc, i)?.inner || '').replace(/[\u2192\u203a\u00bb]|->/g, '').trim();
        if (STOCK_LINK.test(label)) stock.push({ t, label });
        continue;
      }
      if (!/^h[1-6]$/.test(t.name)) continue;
      const text = plainText(innerOf(doc, i)?.inner || '');
      if (/^Meet\s+[A-Z][\w-]*[.!]?$/.test(text)) tell('generic-hero-copy', t.pos, 'the "Meet <Name>" heading', text);
      else if (/^[A-Z][a-z]+\.\s+[A-Z][a-z]+\.\s+[A-Z][a-z]+\.$/.test(text)) tell('generic-hero-copy', t.pos, 'the three-word triad heading', text);
    }
    if (stock.length >= 2) {
      r.report('generic-cta-copy', doc.file, stock[0].t.line, `the stock link label "${stock[0].label}" on ${stock.length} links`, { fix: 'say where each link goes: the thing it opens, in its own noun' });
    }
  }
}

const DASH = /\w\s--\s\w|[\u2014\u2013]|&mdash;|&ndash;|&#8212;|&#8211;/g;
const CADENCE = /(^|[.!?]\s+)(not|no)\s+[a-z][^.!?\n]{0,40}[.]\s+(just|only|a|an)?\s*[a-z][^.!?\n]{0,40}[.]/gi;

// sloplint checkCopyTell (gate 19): the cadence and the dashes; the buzzwords are the copy tier's
function checkCadenceAndDashes(ctx: LintContext, r: Reporter): void {
  for (const doc of ctx.docs) {
    const prose = maskedProse(doc);
    const dashes = [...prose.matchAll(DASH)];
    if (dashes.length >= 3) {
      const at = dashes[0].index ?? 0;
      const around = prose.slice(Math.max(0, at - 16), at + 16).replace(/\s+/g, ' ').trim();
      r.report('em-dash-overuse', doc.file, doc.lineOf(at), `${dashes.length} dashes carry the prose (first: "${trunc(around, 40)}")`);
    }
    const cadence = prose.match(CADENCE);
    if (cadence && cadence.length >= 3) {
      const first = cadence[0].trim();
      r.report('aphoristic-cadence', doc.file, doc.lineOf(Math.max(0, prose.indexOf(first))), `the rebuttal cadence ${cadence.length} times ("${trunc(first, 40)}")`, { fix: 'once is voice, three times is a tic: say what the product does, in its own nouns' });
    }
  }
}

const SECOND_CTA = /^(learn more|see how it works|watch (the )?demo|get started|book a demo)$/i;

/** The <section> or <header> that holds the h1, by tag index; -1 when none does. */
// sloplint heroIndexOf
export function heroIndexOf(doc: Doc, h1Idx: number): number {
  for (let i = h1Idx - 1; i >= 0; i--) {
    const t = doc.tags[i];
    if (t.close || !/^(section|header)$/.test(t.name)) continue;
    const inner = innerOf(doc, i);
    if (inner && inner.endPos > doc.tags[h1Idx].pos) return i;
  }
  return -1;
}

interface HeroControl { t: Tag; cls: string; label: string }

/** Whether a control's resting background is a fill (not none, transparent or the paper). */
function isFilled(ctx: LintContext, c: HeroControl): boolean {
  let raw: string | null = null;
  for (const d of styleFor(ctx, c.cls, c.t.name, true)) if (d.prop === 'background-color' || d.prop === 'background') raw = d.value;
  if (!raw || /--color-paper\b/.test(raw)) return false;
  const bg = resolveVars(raw, ctx.tokens);
  return !/^(none|transparent|inherit|initial|unset)$/i.test(bg.trim()) && !/transparent/i.test(bg);
}

// sloplint check42TwoButton (gate 19 and F4)
function checkHeroActions(ctx: LintContext, r: Reporter): void {
  for (const doc of ctx.docs) {
    const h1 = doc.tags.findIndex((t) => !t.close && t.name === 'h1');
    if (h1 < 0) continue;
    const heroIdx = heroIndexOf(doc, h1);
    const hero = heroIdx >= 0 ? innerOf(doc, heroIdx) : null;
    if (!hero) continue;
    const anc = ancestorMap(doc);
    const controls: HeroControl[] = [];
    for (let i = heroIdx + 1; i < doc.tags.length && doc.tags[i].pos < hero.endPos; i++) {
      const t = doc.tags[i];
      if (t.close || t.selfClosing || !(t.name === 'button' || t.name === 'a')) continue;
      const cls = getAttr(t.attrs, 'class') || '';
      if (t.name === 'a' && !/btn|cta|button/i.test(cls)) continue;
      if ((anc.get(i) || []).includes('nav')) continue;
      controls.push({ t, cls, label: plainText(innerOf(doc, i)?.inner || '').trim() });
    }
    if (controls.length < 2) continue;
    const firstFilled = isFilled(ctx, controls[0]);
    if (firstFilled && isFilled(ctx, controls[1])) {
      r.report('two-primary-buttons', doc.file, controls[1].t.line, `two filled buttons side by side in the hero: "${trunc(controls[0].label, 20)}" and "${trunc(controls[1].label, 20)}"`);
      continue;
    }
    if (!firstFilled || !SECOND_CTA.test(controls[1].label)) continue;
    r.report('generic-cta-copy', doc.file, controls[1].t.line, `the stock second action in the hero: "${trunc(controls[0].label, 20)}" then "${controls[1].label}"`, { fix: 'one action in the hero, or a second that names where it goes' });
  }
}

export function runChromeCopy(ctx: LintContext, r: Reporter): void {
  checkHeroCopy(ctx, r);
  checkCadenceAndDashes(ctx, r);
  checkHeroActions(ctx, r);
}
