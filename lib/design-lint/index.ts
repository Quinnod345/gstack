/**
 * gstack's free design lint: the deterministic gates behind /design-html and
 * /design-review. The static tier reads HTML, CSS and component files and runs
 * in well under a second; the render tier (--render) measures the page in
 * gstack's own browser. One contract for both:
 *
 *   LINT: <blocks|ask|polish|waived> <rule-id> <file>:<line> <evidence> | fix: <fix>
 *   LINT_SUMMARY: blocks=N ask=N waived=N polish=N render=<ran|skipped: reason>
 *
 * Exit 2 when anything blocks, 1 when an ask is unanswered, 0 otherwise.
 * docs/design-lint.md is the user-facing contract.
 */
import { docKindOf } from './html';
import { lintRender, type RenderOptions } from './render';
import { exitCodeOf, finalize, formatFinding, formatSummary, relPath, summarize, type Finding, type Summary } from './report';
import { lintStatic, type StaticOptions } from './static';
import { applyWaivers, FLOOR_REFUSAL, refusal, type WaiverSet } from './waivers';

export interface LintOptions extends StaticOptions {
  render?: boolean;
  urls?: string[];
  /** Replaces the render engine choice (tests inject one). */
  engine?: RenderOptions['engine'];
}

export interface LintResult {
  files: string[];
  findings: Finding[];
  summary: Summary;
  exitCode: 0 | 1 | 2;
}

export async function lint(paths: string[], opts: LintOptions = {}): Promise<LintResult> {
  const cwd = opts.cwd ?? process.cwd();
  const stat = lintStatic(paths, opts);
  let findings = stat.findings;
  let render = 'skipped: not requested';
  if (opts.render || opts.urls?.length) {
    const pages = stat.files.filter((f) => docKindOf(f) === 'html');
    const r = await lintRender([...pages, ...(opts.urls ?? [])], { cwd: opts.cwd, job: opts.job, scope: opts.scope, engine: opts.engine });
    findings = [...findings, ...waiveRender(r.findings, stat.contexts.map((c, i) => [c.docs.length === 1 && c.docs[0].kind === 'html' ? relPath(c.key, cwd) : null, stat.waivers[i]]), cwd)];
    render = r.status;
  }
  const final = finalize(findings);
  const summary = summarize(final, render);
  return { files: stat.files, findings: final, summary, exitCode: exitCodeOf(summary) };
}

export function formatResult(result: LintResult): string {
  return [...result.findings.map(formatFinding), formatSummary(result.summary)].join('\n');
}

/**
 * A page's waivers reach its render findings too. A waiver the static tier
 * accepted on a blocking rule it only suspected is refused here when the
 * render tier measures that rule for real; the measured finding stays blocks.
 */
function waiveRender(findings: Finding[], sets: Array<[string | null, WaiverSet]>, cwd: string): Finding[] {
  const byPage = new Map(sets.filter((s): s is [string, WaiverSet] => s[0] !== null));
  const out: Finding[] = [];
  for (const f of findings) {
    const set = byPage.get(f.file);
    if (!set) { out.push(f); continue; }
    const claim = f.tier === 'blocks' ? set.claims.get(f.rule) : undefined;
    if (claim) out.push(f, refusal(claim, FLOOR_REFUSAL, cwd));
    else out.push(...applyWaivers([f], { ...set, refused: [] }));
  }
  return out;
}

export { formatFinding, formatSummary, type Finding, type Summary } from './report';
