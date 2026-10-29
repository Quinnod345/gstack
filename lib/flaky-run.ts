/**
 * gstack-flaky run (GSTA-158): run a test command, read its JUnit, rerun each
 * failed test once, and record flaky passes on a ledger. This is CREW rule 16
 * ("run the failed test again and note that it is flaky") for any runner that
 * writes JUnit, the per-test form of the free suite's GSTACK_FREE_RETRY_FLAKY.
 *
 * Rules (docs/flaky.md):
 * - A failed test gets one rerun when the runner made no retries of its own and
 *   at most maxReruns tests failed; more failures are a real red and nothing
 *   is rerun. A rerun that passes makes the test a flaky pass (green, ledgered).
 * - When the runner retried (Playwright `retries` with retry-aware JUnit), its
 *   attempts stand and nothing is rerun again.
 * - The test command is an argv run without a shell. A rerun appends the
 *   adapter's selection arguments, each one argv element, and only the
 *   targeted test is read back from the rerun's report, and a rerun counts as
 *   a pass only when its command also exited 0.
 * - The JUnit file is removed before every attempt; a report that attempt did
 *   not write is missing. Missing, unreadable or empty JUnit is never green, and
 *   a non-zero exit with no failed test is a crash, never green.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { finalAttempt, JunitError, readJunit, type JunitReport, type JunitRunner, type JunitTest } from './junit';
import { redactFindingSpans } from './redact-engine';
import { resolveStateRoot } from './state-root';

export type LedgerKind = 'flaky-pass' | 'rerun-fail';

export interface LedgerLine {
  ts: string;
  runner: 'junit';
  kind: LedgerKind;
  id: string;
  file: string;
  /** 'runner' when the runner's own retries decided, 'gstack-flaky' for our rerun. */
  rerun_by: 'runner' | 'gstack-flaky';
  attempts: string[];
  tree?: string;
  git_sha?: string;
  branch?: string;
  run_url?: string;
  excerpt: string[];
}

export interface RunOptions {
  command: string[];
  junit: string;
  runner?: JunitRunner;
  maxReruns: number;
  /** Generic adapter: argv templates appended on rerun, {file} {title} {pattern} substituted. */
  rerunArgs?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: (argv: string[], env: NodeJS.ProcessEnv, cwd: string) => number;
  now?: () => Date;
}

export interface TestOutcome {
  test: JunitTest;
  status: 'flaky-pass' | 'fail' | 'rerun-fail';
  attempts: string[];
  reason?: string;
}

export interface RunResult {
  exitCode: 0 | 1 | 3;
  code?: string;
  message?: string;
  tests: number;
  commandExit: number;
  outcomes: TestOutcome[];
  reruns: number;
  ledger: LedgerLine[];
}

export const DEFAULT_MAX_RERUNS = 3;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Selection arguments a rerun appends for one test, each one argv element. */
export function rerunSelection(runner: JunitRunner, t: JunitTest, generic: string[] = []): string[] {
  if (runner === 'playwright') {
    const args = [escapeRegex(t.file), '--grep', `(?:^|\\s)${escapeRegex(t.path.join(' '))}(?:\\s|$)`];
    return t.project ? [...args, '--project', t.project] : args;
  }
  if (runner === 'bun') return [t.file, '--test-name-pattern', `^${escapeRegex(t.path.join(' '))}$`];
  if (!generic.length) throw new JunitError('FLAKY_RERUN_UNSUPPORTED', 'a generic JUnit runner needs --rerun-arg templates to select one test');
  const title = t.path.join(' ');
  const pattern = `^${escapeRegex(title)}$`;
  return generic.map(a => a.replaceAll('{file}', t.file).replaceAll('{title}', title).replaceAll('{pattern}', pattern));
}

function defaultSpawn(argv: string[], env: NodeJS.ProcessEnv, cwd: string): number {
  const r = spawnSync(argv[0]!, argv.slice(1), { stdio: 'inherit', env, cwd });
  if (r.error) throw new JunitError('FLAKY_COMMAND_NOT_STARTED', `could not start ${argv[0]}: ${r.error.message}`);
  return r.status ?? (r.signal ? 128 : 1);
}

function git(args: string[], cwd: string): string | undefined {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', timeout: 10_000 });
  return r.status === 0 ? r.stdout.trim() || undefined : undefined;
}

export function provenance(cwd: string, env: NodeJS.ProcessEnv): Pick<LedgerLine, 'tree' | 'git_sha' | 'branch' | 'run_url'> {
  const runUrl = env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
    ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}${env.GITHUB_RUN_ATTEMPT ? `/attempts/${env.GITHUB_RUN_ATTEMPT}` : ''}`
    : undefined;
  return {
    tree: git(['rev-parse', 'HEAD^{tree}'], cwd),
    git_sha: git(['rev-parse', 'HEAD'], cwd),
    branch: env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    run_url: runUrl,
  };
}

/** Failure text leaves this process only through the redaction engine; when it cannot scan, nothing leaves. */
export function safeExcerpt(lines: string[]): string[] {
  if (!lines.length) return [];
  const redacted = redactFindingSpans(lines.join('\n'));
  return redacted === null ? ['[excerpt withheld: the redaction scan could not run]'] : redacted.split('\n');
}

/** One attempt: remove the report, run, and read a report this attempt wrote. */
function attempt(opts: RunOptions, argv: string[], cwd: string, env: NodeJS.ProcessEnv): { exit: number; report?: JunitReport; error?: JunitError } {
  const junit = path.resolve(cwd, opts.junit);
  fs.rmSync(junit, { force: true });
  const exit = (opts.spawn ?? defaultSpawn)(argv, env, cwd);
  if (!fs.existsSync(junit)) return { exit, error: new JunitError('FLAKY_NO_RESULTS', `the command wrote no JUnit report at ${opts.junit} (exit ${exit})`) };
  try { return { exit, report: readJunit(junit, opts.runner) }; } catch (e) {
    if (e instanceof JunitError) return { exit, error: e };
    throw e;
  }
}

export function runFlaky(opts: RunOptions): RunResult {
  const cwd = opts.cwd ?? process.cwd();
  const env = { ...(opts.env ?? process.env), PLAYWRIGHT_JUNIT_INCLUDE_RETRIES: '1' };
  const now = opts.now ?? (() => new Date());
  const empty = { tests: 0, outcomes: [], reruns: 0, ledger: [] };
  const first = attempt(opts, opts.command, cwd, env);
  if (!first.report) return { exitCode: 3, code: first.error!.code, message: first.error!.message, commandExit: first.exit, ...empty };
  const report = first.report;
  if (report.retriesHidden) {
    return { exitCode: 3, code: 'FLAKY_RETRIES_HIDDEN', commandExit: first.exit, ...empty, tests: report.tests.length,
      message: 'Playwright retried but its JUnit omits the retries; set PLAYWRIGHT_JUNIT_INCLUDE_RETRIES=1 (gstack-flaky run sets it for the command it starts)' };
  }
  const failed = report.tests.filter(t => finalAttempt(t) === 'fail');
  const runnerFlaky = report.tests.filter(t => finalAttempt(t) === 'pass' && t.attempts.includes('fail'));
  if (first.exit !== 0 && failed.length === 0) {
    return { exitCode: 3, code: 'FLAKY_COMMAND_FAILED', commandExit: first.exit, ...empty, tests: report.tests.length,
      message: `the command exited ${first.exit} but its JUnit reports no failed test; a crash or a non-test step failed` };
  }
  const prov = provenance(cwd, env);
  const line = (t: JunitTest, kind: LedgerKind, by: LedgerLine['rerun_by'], attempts: string[]): LedgerLine =>
    ({ ts: now().toISOString(), runner: 'junit', kind, id: t.id, file: t.file, rerun_by: by, attempts, ...prov, excerpt: safeExcerpt(t.excerpt) });
  const ledger: LedgerLine[] = runnerFlaky.map(t => line(t, 'flaky-pass', 'runner', t.attempts));
  const outcomes: TestOutcome[] = runnerFlaky.map(t => ({ test: t, status: 'flaky-pass' as const, attempts: t.attempts }));
  let reruns = 0;
  const rerunnable = failed.length <= opts.maxReruns;
  for (const t of failed) {
    if (t.executions > 1) { outcomes.push({ test: t, status: 'fail', attempts: t.attempts, reason: `it ran ${t.executions} times in this report and one failed; not rerun` }); continue; }
    if (t.attempts.length > 1) { outcomes.push({ test: t, status: 'fail', attempts: t.attempts, reason: `the runner already retried (${t.attempts.length} attempts)` }); continue; }
    if (!rerunnable) { outcomes.push({ test: t, status: 'fail', attempts: t.attempts, reason: `${failed.length} tests failed, more than --max-reruns ${opts.maxReruns}; not rerun` }); continue; }
    const argv = [...opts.command, ...rerunSelection(report.runner, t, opts.rerunArgs)];
    reruns++;
    const again = attempt(opts, argv, cwd, env);
    const match = again.report?.tests.find(x => x.id === t.id);
    if (!match) {
      outcomes.push({ test: t, status: 'rerun-fail', attempts: [...t.attempts, 'fail'], reason: again.error ? `rerun: ${again.error.message}` : 'rerun: the report does not contain this test' });
      ledger.push(line(t, 'rerun-fail', 'gstack-flaky', [...t.attempts, 'fail']));
      continue;
    }
    const attempts = [...t.attempts, ...match.attempts];
    if (again.exit !== 0) {
      outcomes.push({ test: t, status: 'rerun-fail', attempts, reason: `rerun: the command exited ${again.exit}` });
      ledger.push(line(t, 'rerun-fail', 'gstack-flaky', attempts));
    } else if (finalAttempt(match) === 'pass') {
      outcomes.push({ test: t, status: 'flaky-pass', attempts });
      ledger.push(line(t, 'flaky-pass', 'gstack-flaky', attempts));
    } else {
      outcomes.push({ test: t, status: 'rerun-fail', attempts });
      ledger.push(line(t, 'rerun-fail', 'gstack-flaky', attempts));
    }
  }
  const red = outcomes.some(o => o.status !== 'flaky-pass');
  return { exitCode: red ? 1 : 0, tests: report.tests.length, commandExit: first.exit, outcomes, reruns, ledger };
}

export function ledgerPath(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (flag) return flag;
  if (env.GSTACK_FLAKE_LEDGER) return env.GSTACK_FLAKE_LEDGER;
  return path.join(resolveStateRoot(env), 'flake-ledger-junit.jsonl');
}

/** Append ledger lines; an I/O error is a warning and never changes the verdict. */
export function appendLedger(lines: LedgerLine[], file: string, warn: (s: string) => void): boolean {
  if (!lines.length) return true;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    return true;
  } catch (e) {
    warn(`FLAKY_LEDGER_WRITE_FAILED: could not append ${file} (${(e as Error).message}); the verdict is unaffected`);
    return false;
  }
}

/** Lines the bin prints: one per non-passing test, then the result line. */
export function renderResult(r: RunResult, ledger: string): string[] {
  const out: string[] = [];
  for (const o of r.outcomes) out.push(`FLAKY: ${o.status} ${o.test.id} attempts=${o.attempts.join(',')}${o.reason ? ` (${o.reason})` : ''}`);
  const flaky = r.outcomes.filter(o => o.status === 'flaky-pass').length;
  const failed = r.outcomes.length - flaky;
  out.push(`FLAKY_RESULT: tests=${r.tests} failed=${failed} flaky=${flaky} reruns=${r.reruns} command_exit=${r.commandExit} verdict=${r.exitCode === 0 ? 'pass' : 'fail'} ledger=${r.ledger.length ? ledger : 'none'}`);
  return out;
}

/** A GitHub step summary for the flaky passes, so they are seen before any report reads the ledger. */
export function stepSummary(r: RunResult): string {
  const rows = r.outcomes.filter(o => o.status === 'flaky-pass');
  if (!rows.length) return '';
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return ['### Flaky passes (gstack-flaky)', '', '| Test | Attempts | First error |', '|---|---|---|',
    ...rows.map(o => `| \`${cell(o.test.id)}\` | ${o.attempts.join(', ')} | ${cell(safeExcerpt(o.test.excerpt)[0] ?? '')} |`), ''].join('\n');
}
