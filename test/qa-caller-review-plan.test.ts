/**
 * #3527 put Step 9's review plan into ship/sections/review-army.md as prose, so the qa-callers transport
 * neither admitted the helper nor said where the plan's Step 11 voices run.
 * - Paid screen 40707142223 (ship-exploratory-plan-checks, slice 10 and its rerun): the only refused call in
 *   both trials was `<runtime>/bin/gstack-review-plan --base main`.
 * - Train 35 rebuild gate 40664336141 (ship-exploratory-late-input, slice 9): the actor never ran the plan,
 *   read Step 11's native adversarial pass as owed by this Steps 8-9 excerpt, and reported pass with it remaining.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { bunIsolationArgs } from '../lib/bun-isolation';
import {
  createQaCallerFixture, qaCallerCommandAllowed, qaCallerSessionOptions, validateCallerEvidence,
  type QaCallerCase, type QaCallerFixture,
} from './helpers/qa-callers-fixture';

const captured = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/qa-caller-review-plan-40707142223.json'), 'utf8'));
const SHIP_CASES: QaCallerCase[] = ['ship-exploratory-small-cli', 'ship-exploratory-unavailable', 'ship-exploratory-plan-checks', 'ship-exploratory-late-input'];
const fixtures: QaCallerFixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) { await fixture.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); }
});
const fixtureFor = (caseId: QaCallerCase, installRuntime = false) => {
  const fixture = createQaCallerFixture(caseId, { installRuntime });
  fixtures.push(fixture);
  return fixture;
};
const context = (fixture: QaCallerFixture) => ({ runtime: fixture.runtime, fixtureRoot: fixture.cwd });

describe('ship Step 9 review plan through the qa-callers transport', () => {
  for (const [run, trial] of Object.entries(captured.runs) as [string, { root: string; commands: { command: string }[] }][]) {
    test(`captured ${run}: every Bash call the actor made is inside the declared interface`, () => {
      const fixture = fixtureFor('ship-exploratory-plan-checks', true);
      const commands = trial.commands.map(({ command }) => command.replaceAll(trial.root, fixture.root));
      expect(commands.filter(command => command.includes('/bin/gstack-review-plan '))).toEqual([`${fixture.runtime}/bin/gstack-review-plan --base main`]);
      expect(commands.filter(command => !qaCallerCommandAllowed(command, fixture.workflowCommands, context(fixture)))).toEqual([]);
    });
  }

  test('the helper forms Step 9 names are admitted at the exact installed path, and nothing else is', () => {
    const fixture = fixtureFor('ship-exploratory-late-input');
    const helper = `${fixture.runtime}/bin/gstack-review-plan`;
    const allowed = (command: string) => qaCallerCommandAllowed(command, fixture.workflowCommands, context(fixture));
    for (const args of ['--base main', '--base main --pass 1 --last full', '--base main --pass 2 --last fix-check --fixed-below --adversarial-ran',
      '--base main --pass 1 --last full --blocking-open --touched-gate --critical-found --reviewed-numbers fp:0a1b',
      '--fix-check-prompt --fix-list reports/fix-list.md --hunks reports/hunks.diff --tests reports/tests.txt',
      "--fix-check-prompt --fix-list 'reports/fix list.md' --hunks reports/h.diff --tests reports/t.txt --callers reports/c.txt"]) {
      expect(allowed(`${helper} ${args}`), args).toBe(true);
    }
    for (const command of [`${helper} --base origin/main`, `${helper} --base main --json`, `${helper} --base main --force all`,
      `${helper} --base main --last full --pass 1`, helper, `${helper} --base main | tee reports/plan.txt`, `${helper} --base main; rm -rf reports`,
      `${helper} --base main && git reset --hard`, `${helper} --base "$(git rev-parse HEAD)"`, `${helper} --fix-check-prompt --fix-list $HOME/x --hunks a --tests b`,
      `bun ${helper} --base main`, `${helper}x --base main`, `${fixture.runtime}/bin/gstack-review-planner --base main`,
      '/tmp/elsewhere/bin/gstack-review-plan --base main', '~/.claude/skills/gstack/bin/gstack-review-plan --base main']) {
      expect(allowed(command), command).toBe(false);
    }
    expect(qaCallerCommandAllowed(`${helper} --base main`, fixture.workflowCommands)).toBe(false);
  });

  test.each(SHIP_CASES)('%s: every reviewer the real plan dispatches has a declared route in the transport', caseId => {
    const fixture = fixtureFor(caseId, true);
    const options = qaCallerSessionOptions(fixture, 'free-review-plan');
    expect(qaCallerCommandAllowed(`${fixture.runtime}/bin/gstack-review-plan --base main`, fixture.workflowCommands, context(fixture))).toBe(true);
    const plan = spawnSync(process.execPath, [...bunIsolationArgs(), path.join(fixture.runtime, 'bin/gstack-review-plan'), '--base', 'main'],
      { cwd: fixture.cwd, env: { ...process.env, ...options.env }, encoding: 'utf8', timeout: 60_000 });
    expect(plan.status, plan.stderr).toBe(0);
    const roles = [...plan.stdout.matchAll(/^DISPATCH: (\S+)/gm)].map(match => match[1]);
    expect(roles).toContain('adversarial-native');
    const prompt = options.prompt.toLowerCase();
    for (const role of roles) expect(prompt.includes(role) || prompt.includes(role.replace('-', ' ')), role).toBe(true);
    expect(options.prompt).toContain("The plan's adversarial-native and outside-voice lines are Step 11's voices, which Step 11 runs in a later stage outside this excerpt; they are not remaining work of this phase.");
  });

  test('review keeps its own Step 4.8 transport and is not told about ship Step 11', () => {
    const prompt = qaCallerSessionOptions(fixtureFor('review-exploratory-small-cli'), 'free-review-plan').prompt;
    expect(prompt).toContain('the native adversarial reviewer (Step 4.8)');
    expect(prompt).not.toContain('gstack-review-plan');
    expect(prompt).not.toContain("Step 11's voices");
  });

  test('captured 40664336141 late-input receipt: pass with remaining work is still a false green', () => {
    const receipt = captured.lateInputReceipt;
    expect(receipt.remaining).toContain('Step 11 native adversarial review (not dispatched)');
    const reportRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qc-late-'));
    const validate = (remaining: string[]) => validateCallerEvidence({ caller: 'ship', result: { exitReason: 'success', transcript: [] }, probes: [],
      receipt: { status: receipt.status, probes: [], remaining }, currentSnapshot: 'none', requiredCharters: [], mutations: [], observerComplete: true,
      reportRoot, checkpointFiles: {}, reportMarkdown: '' });
    try {
      expect(validate(receipt.remaining)).toContain('blocked, failing or incomplete coverage reported green');
      expect(validate([])).not.toContain('blocked, failing or incomplete coverage reported green');
    } finally { fs.rmSync(reportRoot, { recursive: true, force: true }); }
  });
});
