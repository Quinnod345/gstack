/**
 * Free craft check for a page (/design-html Step 4, /design-review craft
 * audit). Counts the tells that make a page read as generated or unfinished:
 * placeholder content, AI cliché copy, scroll listeners, 100vh, dead links,
 * and the missing ship-floor tags. Copy checks read the visible text only
 * (script, style and tags removed); code checks read the source. Head checks
 * run only on a full document. Adapted from Elaya's landing-page-design and
 * redesign-skill (MIT); see NOTICE.md. Every id it prints is a
 * lib/design-catalog.ts entry and the fix beside it is that entry's `fix`
 * (test-enforced): buzzwords report under `marketing-buzzword`, whose
 * heuristic words BUZZWORDS covers, and `transition: all` under
 * `layout-transition`.
 */

import { catalogEntries } from './design-catalog';

/** The catalog's marketing-buzzword words plus Elaya's AI cliché words. */
export const BUZZWORDS: readonly string[] = [
  'seamless', 'effortless', 'supercharge', 'streamline', 'revolutionize', 'unlock', 'empower', 'elevate',
  'unleash', 'next-gen', 'game-changer', 'delve', 'tapestry', 'in the world of',
];

function buzzwordPattern(): RegExp {
  const stem = (w: string) => w.replace(/-/g, '[- ]').replace(/e$/, '');
  return new RegExp(`\\b(?:${BUZZWORDS.map(stem).join('|')})(?:e|es|ed|ing|ly|er|ers|s|d|eration)?\\b`, 'gi');
}

export interface CraftFinding {
  id: string;
  count: number;
  fix: string;
}

interface CountRule {
  id: string;
  on: 'source' | 'text' | 'script';
  pattern: RegExp;
}

interface PresenceRule {
  id: string;
  pattern: RegExp;
}

const COUNT_RULES: CountRule[] = [
  { id: 'placeholder-name', on: 'text', pattern: /\b(?:John|Jane) Doe\b/gi },
  { id: 'placeholder-brand', on: 'text', pattern: /\b(?:Acme|Nexus|SmartFlow)\b/g },
  { id: 'lorem', on: 'text', pattern: /\blorem ipsum\b/gi },
  { id: 'marketing-buzzword', on: 'text', pattern: buzzwordPattern() },
  { id: 'round-number', on: 'text', pattern: /(?<![\d.])(?:99\.9+|[1-9]0|100)%\s+(?:uptime|faster|more|less|fewer|better|growth|increase|reduction|of (?:teams|users|customers|companies))\b|\b(?:\d+0|\d+(?:,\d{3})+)\+?\s+(?:happy |active )?(?:users|customers|teams|companies)\b|(?<![\d.])10x\s+(?:faster|more|better)\b/gi },
  { id: 'needs-proof', on: 'text', pattern: /\[Needs proof:/g },
  { id: 'oops', on: 'text', pattern: /\boops\b/gi },
  { id: 'scroll-listener', on: 'source', pattern: /addEventListener\(\s*['"`]scroll['"`]/g },
  { id: 'layout-transition', on: 'source', pattern: /\btransition\s*:\s*all\b|\btransition-all\b/g },
  { id: 'dead-link', on: 'source', pattern: /\bhref\s*=\s*["']#["']/g },
  { id: 'alert', on: 'script', pattern: /(?<![\w.$])(?:window\.)?alert\s*\(/g },
  { id: 'img-no-alt', on: 'source', pattern: /<img\b(?![^>]*(?<![\w-])alt\s*=)[^>]*>/gi },
];

const HEAD_RULES: PresenceRule[] = [
  { id: 'missing-title', pattern: /<title>\s*[^<\s][^<]*<\/title>/i },
  { id: 'missing-meta-description', pattern: /<meta\b[^>]*\bname\s*=\s*["']description["']/i },
  { id: 'missing-favicon', pattern: /<link\b[^>]*\brel\s*=\s*["'][^"']*\bicon\b/i },
];

/** Every id the check can print, in print order; each is a catalog entry with a fix (test-enforced). */
export const CRAFT_IDS: readonly string[] = [
  ...COUNT_RULES.map(r => r.id), 'vh-height', ...HEAD_RULES.map(r => r.id), 'missing-skip-link', 'missing-aria-current',
];

function finding(id: string, count: number): CraftFinding {
  const fix = catalogEntries([id])[0].fix;
  if (!fix) throw new Error(`lib/design-catalog.ts: entry "${id}" has no craft-check fix`);
  return { id, count, fix };
}

export function visibleText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&(nbsp|lt|gt|quot|apos|amp);/g, (_, e) => ({ nbsp: ' ', lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[e as string] as string)
    .replace(/\s+/g, ' ');
}

export function checkCraft(html: string): CraftFinding[] {
  const text = visibleText(html);
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi), ...html.matchAll(/\bon[a-z]+\s*=\s*"([^"]*)"/gi)].map(m => m[1]).join('\n');
  const findings: CraftFinding[] = [];
  for (const rule of COUNT_RULES) {
    const count = (rule.on === 'text' ? text : rule.on === 'script' ? scripts : html).match(rule.pattern)?.length ?? 0;
    if (count > 0) findings.push(finding(rule.id, count));
  }
  const vh = [...html.matchAll(/\b((?:min-|max-)?height)\s*:\s*100vh\b(\s*!important)?([^}]*)/g)]
    .filter(m => m[2] || !new RegExp(`(?<![\\w-])${m[1]}\\s*:\\s*100[dsl]vh\\b`).test(m[3])).length
    + (html.match(/\b(?:min-)?h-screen\b/g)?.length ?? 0);
  if (vh > 0) findings.push(finding('vh-height', vh));
  if (!/<head\b/i.test(html)) return findings;
  for (const rule of HEAD_RULES) {
    if (!rule.pattern.test(html)) findings.push(finding(rule.id, 1));
  }
  const body = html.slice(html.search(/<body\b/i) + 1);
  const firstFocusable = body.match(/<(?:a\b[^>]*\bhref|button|input|select|textarea)\b[^>]*>/i)?.[0] ?? '';
  const skipTarget = firstFocusable.match(/^<a\b[^>]*\bhref\s*=\s*["']#([^"']+)["']/i)?.[1];
  const main = html.match(/<main\b[^>]*(?<![\w-])id\s*=\s*["']([^"']+)["']/i)?.[1]
    ?? html.match(/<[a-z]+\b[^>]*\brole\s*=\s*["']main["'][^>]*(?<![\w-])id\s*=\s*["']([^"']+)["']/i)?.[1];
  if (!skipTarget || skipTarget !== main) {
    findings.push(finding('missing-skip-link', 1));
  }
  const routeLinks = html.match(/<nav\b[\s\S]*?<\/nav>/gi)?.join('').match(/<a\b[^>]*\bhref\s*=\s*["'](?!#)[^"']+["']/gi)?.length ?? 0;
  if (routeLinks >= 2 && !/\baria-current\s*=\s*["']page["']/i.test(html)) {
    findings.push(finding('missing-aria-current', 1));
  }
  return findings;
}

/** An accepted finding recorded in finalized.json's `craft_exceptions`. */
export interface CraftException {
  id: string;
  count: number;
  reason: string;
}

/** Reads `craft_exceptions` from a finalized.json; a record without one has none. Throws on a malformed record. */
export function parseCraftExceptions(json: string): CraftException[] {
  const record = JSON.parse(json);
  if (typeof record !== 'object' || record === null || Array.isArray(record)) throw new Error('not a finalized.json object');
  const list = record.craft_exceptions ?? [];
  const valid = (e: any) => typeof e?.id === 'string' && Number.isInteger(e.count) && e.count > 0 && typeof e.reason === 'string' && e.reason.trim() !== '';
  if (!Array.isArray(list) || !list.every(valid)) throw new Error('craft_exceptions must be a list of { id, count, reason } with a positive count and a reason');
  return list.map(({ id, count, reason }) => ({ id: id === 'transition-all' ? 'layout-transition' : id, count, reason: reason.replace(/\s+/g, ' ').trim() }));
}

/** A finding is accepted when an exception names its id with at least its count; a higher count stays an issue and says how many were accepted. */
export function acceptFindings(findings: CraftFinding[], exceptions: CraftException[]): { issues: CraftFinding[]; accepted: CraftException[] } {
  const issues: CraftFinding[] = [];
  const accepted: CraftException[] = [];
  for (const finding of findings) {
    const exception = exceptions.filter(e => e.id === finding.id).sort((a, b) => b.count - a.count)[0];
    if (!exception) issues.push(finding);
    else if (finding.count <= exception.count) accepted.push({ id: finding.id, count: finding.count, reason: exception.reason });
    else issues.push({ ...finding, fix: `${finding.fix} (${exception.count} accepted earlier: ${exception.reason})` });
  }
  return { issues, accepted };
}

export function formatCraft(findings: CraftFinding[], accepted: CraftException[] = []): string {
  const lines = [
    ...findings.map(f => `CRAFT_CHECK: ${f.id} ${f.count} ${f.fix}`),
    ...accepted.map(a => `CRAFT_ACCEPTED: ${a.id} ${a.count} ${a.reason}`),
  ];
  const note = accepted.length === 0 ? '' : findings.length === 0 ? ` (${accepted.length} accepted)` : `, ${accepted.length} accepted`;
  lines.push(`${findings.length === 0 ? 'CRAFT_RESULT: clean' : `CRAFT_RESULT: ${findings.length} issue(s)`}${note}`);
  return lines.join('\n');
}
