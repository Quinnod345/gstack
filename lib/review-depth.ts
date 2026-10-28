/**
 * review-depth — the one policy owner for how much review a /ship run dispatches
 * (docs/review-policy.md#review-depth). A pure function from the changed paths,
 * gstack-diff-scope flags, the diff size, the gate scan and the pass history to a
 * diff class, the next step of the loop and the reviewers that step dispatches,
 * each with its reasoning-effort tier. bin/gstack-review-plan prints it; the
 * review-army resolver and the skills read the same definitions.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type DiffClass = 'docs' | 'tests' | 'code' | 'gate';
export type PathClass = 'docs' | 'tests' | 'code';
export type Effort = 'light' | 'full' | 'host';
export type Role = 'specialist' | 'red-team' | 'adversarial-native' | 'outside-voice' | 'fix-check';
export type Step = 'full' | 'fix-check' | 'done' | 'stop';

export const SPECIALISTS = ['testing', 'maintainability', 'security', 'performance', 'data-migration', 'api-contract', 'design', 'simplification', 'state-machines'] as const;
export type Specialist = (typeof SPECIALISTS)[number];
export const FULL_PASS_CAP = 2;
export const SMALL_DIFF_LINES = 50;
export const RED_TEAM_LINES = 200;
export const LARGE_DIFF_LINES = 100;
const CLASS_RANK: Record<DiffClass, number> = { docs: 0, tests: 1, code: 2, gate: 3 };

const AGENT_PROSE = [/(^|\/)SKILL\.md(\.tmpl)?$/, /(^|\/)sections\//, /^scripts\/resolvers\//, /^docs\/[^/]*-policy\.md$/, /^docs\/(captain|unattended|pregate)\.md$/, /(^|\/)DRIVER\.md(\.tmpl)?$/, /(^|\/)templates\//, /(^|\/)(AGENTS|CLAUDE|ETHOS)\.md$/, /(^|\/)specialists\//, /(^|\/)checklist\.md$/, /^\.gstack\//];
/** gstack-diff-scope's TEST_PATH_RE (the test-bootstrap rule), plus fixture directories. */
const TEST_PATH = [/(^|\/)(tests?|spec|__tests__)\/|(^|\/)tests?\.py$|(^|\/)test_[^/]+\.py$|_test\.(go|py|rb|ts|js|exs|dart)$|\.(test|spec)\.[jt]sx?$|_spec\.rb$|Test\.(java|kt)$/, /(^|\/)fixtures?\//];
const DOC_PATH = /\.(md|mdx|markdown|rst|txt|adoc)$/i;
/** Release metadata a version stamp writes: never a reason for review depth on its own. */
const RELEASE_METADATA = [/^CHANGELOG\.md$/, /^VERSION$/, /^agents-digest\//];
const GATE_PATH = [/(^|\/)\.github\/workflows\//, /(^|\/)(secrets?|credentials?|keychain|token[s]?)([._/-]|$)/i, /state-root/, /(^|\/)(pregate|gate|ship-receipt|ship-policy)[^/]*\.(ts|sh|json)$/, /(^|\/)bin\/gstack-(pregate|gate|ship-receipt|verify-gate|ci-gate)$/];

/** One changed path's class. Markdown an agent or a gate reads (skills, sections, resolvers, policy and rule docs, templates, any markdown in a skill directory under `root`) is code: it is gstack's product. */
export function classifyPath(p: string, root?: string): PathClass {
  if (RELEASE_METADATA.some(r => r.test(p))) return 'docs';
  if (AGENT_PROSE.some(r => r.test(p))) return 'code';
  if (TEST_PATH.some(r => r.test(p))) return 'tests';
  if (!DOC_PATH.test(p)) return 'code';
  const top = p.includes('/') ? p.split('/')[0]! : '';
  if (root && top && ['SKILL.md', 'SKILL.md.tmpl'].some(f => fs.existsSync(path.join(root, top, f)))) return 'code';
  return 'docs';
}

export interface ClassInput {
  paths: readonly string[];
  /** gstack-diff-scope output (SCOPE_* keys). */
  scope?: Record<string, string>;
  /** Gate hunks the gate scan tagged (an RH rule: a relaxed threshold, a skipped test, a loosened check); null when the scan did not run or failed. Plain test edits are listed, never tagged, and do not count. */
  gateTagged: number | null;
  /** Paths the diff deletes or renames away. */
  deleted?: readonly string[];
  /** Paths whose whole change is a version stamp (package.json's version key): classified as docs. */
  stampOnly?: readonly string[];
  /** The repository root: markdown inside a skill directory there is code. */
  root?: string;
}
export interface ClassResult { class: DiffClass; reasons: string[] }

/** The diff's class: the most restrictive of its paths, raised to gate by any gate signal; errors fail closed. */
export function classifyDiff(i: ClassInput): ClassResult {
  const reasons: string[] = [];
  let cls: DiffClass = 'docs';
  const raise = (c: DiffClass, why: string) => { if (CLASS_RANK[c] > CLASS_RANK[cls]) cls = c; reasons.push(why); };
  if (!i.paths.length) raise('docs', 'no changed paths');
  for (const p of i.paths) { const c = (i.stampOnly ?? []).includes(p) ? 'docs' : classifyPath(p, i.root); if (CLASS_RANK[c] > CLASS_RANK[cls]) raise(c, `${c}: ${p}`); }
  const s = i.scope ?? {};
  if (s.SCOPE_ERROR) raise('code', `scope error: ${s.SCOPE_ERROR}`);
  if (CLASS_RANK[cls] >= CLASS_RANK.tests) {
    if (i.gateTagged === null) raise('gate', 'gate scan unavailable');
    else if (i.gateTagged > 0) raise('gate', `gate scan tagged ${i.gateTagged} hunk(s)`);
    const deletedGuarded = (i.deleted ?? []).filter(p => classifyPath(p, i.root) !== 'docs');
    if (deletedGuarded.length) raise('gate', `deletes ${deletedGuarded.length} code or test path(s)`);
  }
  if (CLASS_RANK[cls] >= CLASS_RANK.code) {
    if (s.SCOPE_AUTH === 'true') raise('gate', 'auth paths');
    if (s.SCOPE_MIGRATIONS === 'true') raise('gate', 'migrations');
    for (const p of i.paths) if (GATE_PATH.some(r => r.test(p))) { raise('gate', `gate path: ${p}`); break; }
  }
  return { class: cls, reasons };
}

// ---------------------------------------------------------------------------
// numeric claims: the outside voice's trigger on docs and tests diffs
// ---------------------------------------------------------------------------
const CLAIM = new RegExp([
  String.raw`\d+(?:\.\d+)?\s?%`, String.raw`[$€£]\s?\d`, String.raw`\b\d+(?:\.\d+)?\s?x\b`,
  String.raw`\b\d+(?:\.\d+)?\s?(?:ms|s|seconds?|minutes?|hours?|tokens?|credits?|[kKmM]tok)\b`,
  String.raw`(?<![\d.])\d+\.\d+(?![\d.])`,
  String.raw`[=≈<>≤≥]\s*-?\d`, String.raw`\b\d+\s*/\s*\d+\b`, String.raw`\b\d+(?:\.\d+)?e-?\d+\b`,
  String.raw`\b(?:p|n|median|mean|average|rate|score|accuracy|recall|precision|speedup|faster|slower|cheaper|cost|hits?|misses)\b[^\n]{0,40}\d`,
].join('|'), 'i');
/** Not claims: dates, versions, issue numbers, step numbers. Stripped before the scan. */
const NOT_CLAIM = /\b\d{4}-\d{2}-\d{2}\b|\bv?\d+(?:\.\d+){2,}\b|#\d+\b|\b(?:step|phase|pass|rule|item|round)\s+\d+(?:\.\d+)?\b/gi;
export interface NumbersResult { publishes: boolean; claims: number; fingerprint: string }

/** Where a number is published: prose and data files. Code and test source are not publications. */
const PUBLISHED = /\.(md|mdx|markdown|rst|txt|adoc|json|csv|tsv)$/i;

/** Added lines (path → lines) → whether the diff publishes numeric claims in prose or data files, and a fingerprint of those claims and their files. */
export function scanNumbers(added: Record<string, readonly string[]>): NumbersResult {
  const hits: string[] = [];
  for (const p of Object.keys(added).filter(f => PUBLISHED.test(f)).sort()) for (const line of added[p] ?? []) if (CLAIM.test(line.replace(NOT_CLAIM, ' '))) hits.push(`${p}\t${line.trim()}`);
  const fingerprint = hits.length ? createHash('sha256').update(hits.join('\n')).digest('hex').slice(0, 16) : 'none';
  return { publishes: hits.length > 0, claims: hits.length, fingerprint };
}

// ---------------------------------------------------------------------------
// the loop: which step comes next
// ---------------------------------------------------------------------------
export interface History {
  /** Full review passes already run in this invocation (0 before pass 1). */
  fullPasses: number;
  /** The step that just finished; none before pass 1. */
  last: 'none' | 'full' | 'fix-check';
  /** The finished step fixed at least one blocking finding. */
  fixedBlocking?: boolean;
  /** The finished step fixed findings below the floor (pass 1 only fixes those). */
  fixedBelow?: boolean;
  /** A blocking finding is still open in fix scope (unfixed). */
  blockingOpen?: boolean;
  /** A fix in the finished step touched a gate-class path. */
  touchedGate?: boolean;
}
export interface NextStep { step: Step; reason: string }

/**
 * The transition table (docs/review-policy.md#transitions). Pass 1 is full. A fixed
 * blocking finding earns a second full pass on the range; any other fix earns one
 * fix-check; two full passes is the cap; a blocker still open after any step
 * stops for the owner.
 */
export function nextStep(h: History): NextStep {
  if (h.last === 'none') return { step: 'full', reason: 'pass 1 reviews the whole diff' };
  const fixed = !!(h.fixedBlocking || h.fixedBelow);
  if (h.last === 'fix-check') return h.blockingOpen || fixed ? { step: 'stop', reason: 'the fix-check found a blocking finding: name it for the owner, never a third full pass' } : { step: 'done', reason: 'the fix-check found nothing blocking' };
  if (h.blockingOpen && h.fullPasses >= FULL_PASS_CAP) return { step: 'stop', reason: `a blocking finding is open after ${FULL_PASS_CAP} full passes: name it for the owner` };
  if (h.blockingOpen) return { step: 'stop', reason: 'a blocking finding is still open in fix scope: name it for the owner' };
  if (!fixed) return { step: 'done', reason: 'the step applied no edits' };
  if ((h.fixedBlocking || h.touchedGate) && h.fullPasses < FULL_PASS_CAP) return { step: 'full', reason: h.fixedBlocking ? 'a blocking finding was fixed: full pass on the range' : 'a fix touched a gate-class path: full pass on the range' };
  return { step: 'fix-check', reason: h.fixedBlocking ? `full-pass cap ${FULL_PASS_CAP} reached: one fix-check reads the fix` : 'only below-floor fixes: one fix-check reads the touched hunks' };
}

// ---------------------------------------------------------------------------
// the dispatch plan of one step
// ---------------------------------------------------------------------------
export interface PlanInput extends ClassInput {
  diffLines: number;
  history: History;
  numbers: NumbersResult;
  /** Specialists force-included by prompt flags; 'all' for --all-specialists. */
  force?: readonly string[] | 'all';
  /** Specialists the hit-rate stats tag GATE_CANDIDATE. */
  gated?: readonly string[];
  /** A specialist produced a CRITICAL finding (Red Team activation on code class). */
  criticalFound?: boolean;
  /** Step 11's native adversarial pass already ran in this invocation. */
  adversarialRan?: boolean;
  /** The numeric-claim fingerprint the outside voice last reviewed; a change reruns it. */
  reviewedNumbers?: string;
}
export interface Dispatch { role: Role; name: string; effort: Effort }
export interface ReviewPlan { class: DiffClass; reasons: string[]; next: NextStep; numbers: NumbersResult; dispatches: Dispatch[]; skipped: string[] }

/** The specialists a full pass selects for a class: class sets the eligible set, hit-rate gating applies inside it, gate class ignores gating. */
export function specialistsFor(cls: DiffClass, i: PlanInput, skipped: string[] = []): Specialist[] {
  const s = i.scope ?? {};
  const forced = (n: string) => i.force === 'all' || (Array.isArray(i.force) && i.force.includes(n));
  if (cls === 'docs') { skipped.push('specialists (docs class)'); return SPECIALISTS.filter(forced); }
  if (cls === 'tests') { skipped.push('specialists except testing (tests class)'); return SPECIALISTS.filter(n => n === 'testing' || forced(n)); }
  const want = (n: Specialist): boolean => {
    if (forced(n)) return true;
    if (n === 'state-machines') return s.SCOPE_STATE_MACHINE === 'true' || s.SCOPE_STATE_MACHINE === 'unknown' || s.SCOPE_STATE_MACHINE === undefined;
    if (i.diffLines < SMALL_DIFF_LINES) return false;
    switch (n) {
      case 'testing': case 'maintainability': return true;
      case 'security': return s.SCOPE_AUTH === 'true' || (s.SCOPE_BACKEND === 'true' && i.diffLines > LARGE_DIFF_LINES);
      case 'performance': return s.SCOPE_BACKEND === 'true' || s.SCOPE_FRONTEND === 'true';
      case 'data-migration': return s.SCOPE_MIGRATIONS === 'true';
      case 'api-contract': return s.SCOPE_API === 'true';
      case 'design': return s.SCOPE_FRONTEND === 'true';
      case 'simplification': return i.diffLines > LARGE_DIFF_LINES;
    }
  };
  return SPECIALISTS.filter(n => {
    if (!want(n)) return false;
    if (cls !== 'gate' && !forced(n) && (i.gated ?? []).includes(n)) { skipped.push(`${n} (gated by hit rate)`); return false; }
    return true;
  });
}

/** The reviewers the next step dispatches, with each role's effort tier. */
export function planReview(i: PlanInput): ReviewPlan {
  const { class: cls, reasons } = classifyDiff(i);
  const next = nextStep(i.history);
  const skipped: string[] = [];
  const dispatches: Dispatch[] = [];
  const numbersChanged = i.numbers.publishes && i.reviewedNumbers !== undefined && i.reviewedNumbers !== i.numbers.fingerprint;
  if (next.step === 'full') {
    for (const n of specialistsFor(cls, i, skipped)) dispatches.push({ role: 'specialist', name: n, effort: 'full' });
    const redTeam = cls === 'gate' || (cls === 'code' && (i.diffLines > RED_TEAM_LINES || !!i.criticalFound));
    if (redTeam) dispatches.push({ role: 'red-team', name: 'red-team', effort: 'full' });
    else skipped.push(`red-team (${cls} class${cls === 'code' ? `, ${i.diffLines} lines, no critical` : ''})`);
    if (i.history.fullPasses === 0 || (!i.adversarialRan && (cls === 'code' || cls === 'gate'))) {
      if (cls === 'docs' || cls === 'tests') skipped.push(`adversarial-native (${cls} class)`);
      else dispatches.push({ role: 'adversarial-native', name: 'adversarial', effort: 'full' });
      if (cls === 'code' || cls === 'gate' || i.numbers.publishes) dispatches.push({ role: 'outside-voice', name: 'outside-voice', effort: 'host' });
      else skipped.push(`outside-voice (${cls} class, no numeric claims)`);
    } else {
      skipped.push('adversarial-native and outside-voice (run once per invocation)');
      if (numbersChanged) dispatches.push({ role: 'outside-voice', name: 'outside-voice (numbers changed)', effort: 'host' });
    }
  } else if (next.step === 'fix-check') {
    dispatches.push({ role: 'fix-check', name: 'fix-check', effort: 'full' });
    if (numbersChanged) dispatches.push({ role: 'outside-voice', name: 'outside-voice (numbers changed)', effort: 'host' });
  }
  return { class: cls, reasons, next, numbers: i.numbers, dispatches, skipped };
}

export function reviewPlanLine(p: ReviewPlan, pass: number): string {
  return `REVIEW_PLAN: class=${p.class} pass=${pass} next=${p.next.step} dispatches=${p.dispatches.length} numbers=${p.numbers.publishes ? `yes(${p.numbers.claims})` : 'no'} fingerprint=${p.numbers.fingerprint}`;
}
