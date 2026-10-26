/**
 * Free craft check for a generated page (design-html Step 4). Counts the tells
 * that make a page read as generated or unfinished: placeholder content, AI
 * cliché copy, scroll listeners, 100vh, dead links, and the missing ship-floor
 * tags. Copy checks read the visible text only (script, style and tags
 * removed); code checks read the source. Head checks run only on a full
 * document. Adapted from Elaya's landing-page-design and redesign-skill
 * (MIT); see NOTICE.md. Buzzwords report under the catalog's
 * `marketing-buzzword` id, and BUZZWORDS covers every word its heuristic
 * names (test-enforced), so the two lists cannot drift.
 */

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
  fix: string;
}

interface PresenceRule {
  id: string;
  pattern: RegExp;
  fix: string;
}

const COUNT_RULES: CountRule[] = [
  { id: 'placeholder-name', on: 'text', pattern: /\b(?:John|Jane) Doe\b/gi, fix: 'use a supplied name, or one that fits the product in sample data' },
  { id: 'placeholder-brand', on: 'text', pattern: /\b(?:Acme|Nexus|SmartFlow)\b/g, fix: 'use a supplied customer, or a fitting name in sample data' },
  { id: 'lorem', on: 'text', pattern: /\blorem ipsum\b/gi, fix: 'write real copy' },
  { id: 'marketing-buzzword', on: 'text', pattern: buzzwordPattern(), fix: 'say the specific thing' },
  { id: 'round-number', on: 'text', pattern: /(?<![\d.])(?:99\.9+|[1-9]0|100)%\s+(?:uptime|faster|more|less|fewer|better|growth|increase|reduction|of (?:teams|users|customers|companies))\b|\b(?:\d+0|\d+(?:,\d{3})+)\+?\s+(?:happy |active )?(?:users|customers|teams|companies)\b|(?<![\d.])10x\s+(?:faster|more|better)\b/gi, fix: 'use the supplied figure, or drop the claim' },
  { id: 'needs-proof', on: 'text', pattern: /\[Needs proof:/g, fix: 'supply the proof or remove the claim before publishing' },
  { id: 'oops', on: 'text', pattern: /\boops\b/gi, fix: 'say what happened and what to do' },
  { id: 'scroll-listener', on: 'source', pattern: /addEventListener\(\s*['"`]scroll['"`]/g, fix: 'use IntersectionObserver; read scroll inside requestAnimationFrame for a scroll-linked effect' },
  { id: 'transition-all', on: 'source', pattern: /\btransition\s*:\s*all\b|\btransition-all\b/g, fix: 'list the transitioned properties' },
  { id: 'dead-link', on: 'source', pattern: /\bhref\s*=\s*["']#["']/g, fix: 'link it, or render the control disabled' },
  { id: 'alert', on: 'script', pattern: /(?<![\w.$])(?:window\.)?alert\s*\(/g, fix: 'show the message inline' },
  { id: 'img-no-alt', on: 'source', pattern: /<img\b(?![^>]*(?<![\w-])alt\s*=)[^>]*>/gi, fix: 'add alt text (alt="" when decorative)' },
];

const HEAD_RULES: PresenceRule[] = [
  { id: 'missing-title', pattern: /<title>\s*[^<\s][^<]*<\/title>/i, fix: 'add a <title>' },
  { id: 'missing-meta-description', pattern: /<meta\b[^>]*\bname\s*=\s*["']description["']/i, fix: 'add <meta name="description">' },
  { id: 'missing-favicon', pattern: /<link\b[^>]*\brel\s*=\s*["'][^"']*\bicon\b/i, fix: 'add a favicon <link rel="icon">' },
];

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
    if (count > 0) findings.push({ id: rule.id, count, fix: rule.fix });
  }
  const vh = [...html.matchAll(/\b((?:min-|max-)?height)\s*:\s*100vh\b(\s*!important)?([^}]*)/g)]
    .filter(m => m[2] || !new RegExp(`(?<![\\w-])${m[1]}\\s*:\\s*100[dsl]vh\\b`).test(m[3])).length
    + (html.match(/\b(?:min-)?h-screen\b/g)?.length ?? 0);
  if (vh > 0) findings.push({ id: 'vh-height', count: vh, fix: 'use min-height: 100dvh (a 100vh line followed by a 100dvh fallback is fine)' });
  if (!/<head\b/i.test(html)) return findings;
  for (const rule of HEAD_RULES) {
    if (!rule.pattern.test(html)) findings.push({ id: rule.id, count: 1, fix: rule.fix });
  }
  const body = html.slice(html.search(/<body\b/i) + 1);
  const firstFocusable = body.match(/<(?:a\b[^>]*\bhref|button|input|select|textarea)\b[^>]*>/i)?.[0] ?? '';
  const skipTarget = firstFocusable.match(/^<a\b[^>]*\bhref\s*=\s*["']#([^"']+)["']/i)?.[1];
  const main = html.match(/<main\b[^>]*(?<![\w-])id\s*=\s*["']([^"']+)["']/i)?.[1]
    ?? html.match(/<[a-z]+\b[^>]*\brole\s*=\s*["']main["'][^>]*(?<![\w-])id\s*=\s*["']([^"']+)["']/i)?.[1];
  if (!skipTarget || skipTarget !== main) {
    findings.push({ id: 'missing-skip-link', count: 1, fix: 'add a "Skip to content" link first in <body> whose #id exists on <main>' });
  }
  const routeLinks = html.match(/<nav\b[\s\S]*?<\/nav>/gi)?.join('').match(/<a\b[^>]*\bhref\s*=\s*["'](?!#)[^"']+["']/gi)?.length ?? 0;
  if (routeLinks >= 2 && !/\baria-current\s*=\s*["']page["']/i.test(html)) {
    findings.push({ id: 'missing-aria-current', count: 1, fix: 'mark the current nav link aria-current="page"' });
  }
  return findings;
}

export function formatCraft(findings: CraftFinding[]): string {
  const lines = findings.map(f => `CRAFT_CHECK: ${f.id} ${f.count} ${f.fix}`);
  lines.push(findings.length === 0 ? 'CRAFT_RESULT: clean' : `CRAFT_RESULT: ${findings.length} issue(s)`);
  return lines.join('\n');
}
