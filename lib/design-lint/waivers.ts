/**
 * Waivers on the record. A page answers a finding with a comment that names
 * the rule and gives a reason about this page:
 *
 *   <!-- gstack-lint-disable kicker-above-heading: the chapter number is the reader's bookmark through a 40-page spec -->
 *   /* gstack-lint-disable section-gap: the ledger separates its rows with rules, not air *\/
 *   // gstack-lint-disable template-nav: the three links are the product's three modes
 *
 * `impeccable-disable <rule>: <reason>` is accepted as an alias, so a comment
 * that already silences the impeccable engine silences the same tell here.
 *
 * What the lint refuses, each as its own `waiver` finding: an unknown rule; a
 * blocking rule (the Floor is never waivable); a reason under 24 characters,
 * boilerplate ("by design", "intentional"), reused word for word on another
 * waiver, or sharing no word of four letters or more with the page's own
 * text; a second waiver of one rule. More than three waivers on one page is a
 * house style and belongs in DESIGN.md: reported at polish.
 *
 * Adapted from Nutlope/hallmark's sloplint.mjs applyWaivers (MIT, see
 * NOTICE.md); the guard evidence field is dropped because gstack has no theme
 * stamp to re-derive it from.
 */
import type { Finding } from './report';
import { relPath, trunc } from './report';
import { ruleMeta } from './rules/ids';

export interface WaiverClaim {
  rule: string;
  reason: string;
  file: string;
  line: number;
  raw: string;
}

export interface WaiverSet {
  /** Rule ids the page waived, each with its recorded reason. */
  accepted: Map<string, string>;
  /** Refused waivers, already shaped as findings. */
  refused: Finding[];
}

export const WAIVER_MIN_REASON = 24;
export const WAIVER_MAX = 3;

const WAIVER_RE = /(?:gstack-lint-disable|impeccable-disable)\s+([a-z][a-z0-9-]*)\s*:\s*([^\n]*?)\s*(?=-->|\*\/|\n|$)/g;

const WAIVER_FILLER = /\b(a|an|the|is|it|this|that|was|are|and|but|so|very|just|really|here|quite|more|most)\b/gi;
const WAIVER_BOILERPLATE_PHRASES = [
  'design choice', 'design decision', 'intentionally', 'intentional', 'by design',
  'looks better', 'for the aesthetic', 'aesthetic', 'necessary here', 'necessary',
  'the prompt requires it', 'prompt requires', 'the brief requires it', 'brief requires', 'on purpose', 'deliberate', 'deliberately',
  'it works', 'works better', 'needed', 'required', 'fine', 'ok', 'okay', 'user agreed', 'agreed',
];

export function reasonIsBoilerplate(reason: string): boolean {
  let r = reason.toLowerCase();
  for (const p of WAIVER_BOILERPLATE_PHRASES) r = r.split(p).join(' ');
  r = r.replace(WAIVER_FILLER, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  return r.length < 12;
}

/** Every waiver comment in one source file, with its line. */
export function findWaivers(file: string, source: string): WaiverClaim[] {
  const out: WaiverClaim[] = [];
  const lineOf = (pos: number) => source.slice(0, pos).split('\n').length;
  for (const m of source.matchAll(WAIVER_RE)) {
    out.push({ rule: m[1], reason: m[2].trim(), file, line: lineOf(m.index!), raw: m[0] });
  }
  return out;
}

const pageWordsOf = (text: string): Set<string> =>
  new Set((text.toLowerCase().replace(WAIVER_RE, ' ').match(/[a-z]{4,}/g) || []));

/**
 * Validate the claims of one context against its visible text. The text the
 * reason must share a word with is the page's own prose, waiver comments
 * removed, so a reason cannot vouch for itself.
 */
export function resolveWaivers(claims: WaiverClaim[], pageText: string, cwd = process.cwd()): WaiverSet {
  const accepted = new Map<string, string>();
  const refused: Finding[] = [];
  const pageWords = pageWordsOf(pageText);
  const reasons = new Map<string, number>();
  for (const c of claims) reasons.set(c.reason.toLowerCase(), (reasons.get(c.reason.toLowerCase()) || 0) + 1);
  const refuse = (c: WaiverClaim, why: string) => refused.push({
    rule: 'waiver', tier: 'ask', grade: 'ask', source: 'static',
    file: relPath(c.file, cwd), line: c.line,
    evidence: trunc(`waiver on ${c.rule} refused: ${why}`),
    fix: 'fix the finding, or waive it with the rule id and a reason about this page (24 characters or more, not boilerplate)',
  });
  for (const c of claims) {
    const meta = ruleMeta(c.rule);
    if (!meta || c.rule === 'waiver' || c.rule === 'house-style' || c.rule === 'render') { refuse(c, 'no such rule'); continue; }
    if (meta.tier === 'blocks') { refuse(c, 'it blocks; the Floor is never waivable'); continue; }
    if (accepted.has(c.rule)) { refuse(c, 'one waiver per rule'); continue; }
    if (c.reason.length < WAIVER_MIN_REASON) { refuse(c, `reason under ${WAIVER_MIN_REASON} characters`); continue; }
    if (reasonIsBoilerplate(c.reason)) { refuse(c, 'boilerplate reason'); continue; }
    if ((reasons.get(c.reason.toLowerCase()) || 0) > 1) { refuse(c, 'reason reused on another waiver'); continue; }
    const words = c.reason.toLowerCase().match(/[a-z]{4,}/g) || [];
    if (!words.some((w) => pageWords.has(w))) { refuse(c, 'reason shares no word with the page'); continue; }
    accepted.set(c.rule, c.reason);
  }
  if (accepted.size > WAIVER_MAX) {
    const first = claims[0];
    refused.push({
      rule: 'house-style', tier: 'polish', grade: 'polish', source: 'static',
      file: relPath(first.file, cwd), line: first.line,
      evidence: trunc(`${accepted.size} rules waived on one page (${[...accepted.keys()].join(', ')}): that is a house style, not a set of exceptions`),
      fix: 'lock the choices into DESIGN.md so later pages inherit them instead of re-arguing them',
    });
  }
  return { accepted, refused };
}

/** Mark waived ask and polish findings; blocking findings never change. Returns the findings plus the refusals. */
export function applyWaivers(findings: Finding[], set: WaiverSet): Finding[] {
  const out = findings.map((f) => {
    if (f.tier === 'blocks' || !set.accepted.has(f.rule)) return f;
    return { ...f, grade: 'waived' as const, waiver: set.accepted.get(f.rule) };
  });
  return [...out, ...set.refused];
}
