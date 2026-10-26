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
import * as path from 'node:path';
import { docKindOf } from './html';
import { lintRender } from './render';
import { exitCodeOf, finalize, formatFinding, formatSummary, summarize, type Finding, type Summary } from './report';
import { lintStatic, type StaticOptions } from './static';

export interface LintOptions extends StaticOptions {
  render?: boolean;
  urls?: string[];
}

export interface LintResult {
  files: string[];
  findings: Finding[];
  summary: Summary;
  exitCode: 0 | 1 | 2;
}

export async function lint(paths: string[], opts: LintOptions = {}): Promise<LintResult> {
  const stat = lintStatic(paths, opts);
  let findings = stat.findings;
  let render = 'skipped: not requested';
  if (opts.render || opts.urls?.length) {
    const pages = stat.files.filter((f) => docKindOf(f) === 'html');
    const r = await lintRender([...pages, ...(opts.urls ?? [])], { cwd: opts.cwd, job: opts.job, scope: opts.scope });
    findings = [...findings, ...r.findings];
    render = r.status;
  }
  const final = finalize(findings);
  const summary = summarize(final, render);
  return { files: stat.files, findings: final, summary, exitCode: exitCodeOf(summary) };
}

export function formatResult(result: LintResult): string {
  return [...result.findings.map(formatFinding), formatSummary(result.summary)].join('\n');
}

export const isPage = (f: string): boolean => docKindOf(f) === 'html' && path.extname(f) !== '';

export { RULES, RULE_IDS, ruleMeta } from './rules/ids';
export { formatFinding, formatSummary, type Finding, type Summary } from './report';
