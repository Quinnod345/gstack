/**
 * Plan E16/E21/E22 (lane F, autoplan gates):
 *  E16 every gate prints its cost: `GATE_SPEND:` from the run's ledger and
 *      `GATE_REC_COST:` for the phases a `rec` reopens; the owner brief carries
 *      the same sentence. Host-subagent attempts are priced unknown, never zero.
 *  E21 `answer --owner-standing rec --by agent:<id>` answers `rec` by citing
 *      the newest standing approval covering autoplan recommendations (any
 *      branch's record of the project), lands its id on every decision row and
 *      in the import's source; it refuses with STANDING_APPROVAL_ABSENT when no
 *      row covers it and STANDING_APPROVAL_INAPPLICABLE when the gate carries an
 *      urgent finding.
 *  E22 the approvals mirror honours the directory a Captain named by creating
 *      `approvals/` in its drive, between GSTACK_APPROVALS_DIR and the private
 *      project-user folder; `gstack-approvals path` names the rule.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildRow, captainApprovalsDir, coversAutoplanRec, locate, standingRecApproval, type ApprovalRow } from '../lib/approval-record';
import { gateCost, recReopens, renderGateCost, gateCostSentence } from '../lib/autoplan-gate-cost';
import type { GateList } from '../lib/gate-list';
import { attemptsOf, autoplan, env, readRun, resultOf, review, ROOT, startSmallRun } from './helpers/autoplan-run-fixture';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-standing-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const keep = { key: 'a', text: 'keep your direction', changes_plan: false };
const change = { key: 'b', text: 'accept the change', changes_plan: true };
const list = (recommended: 'a' | 'b'): GateList => ({
  schema_version: 1, run: 'r', gate_rev: 1, items: [
    { id: 'uc1', title: 'challenge', options: [keep, change], recommended, kind: 'approval', phase: 'ceo' },
    { id: 'd1', title: 'auto', options: [keep, change], recommended: 'a', kind: 'auto', phase: 'design' },
    { id: 'p1', title: 'Plan approval', options: [{ key: 'a', text: 'approve as-is' }], recommended: 'a', kind: 'approval' },
  ],
});
const row = (over: Partial<Parameters<typeof buildRow>[0]> = {}, branch = 'main'): ApprovalRow => {
  const r = buildRow({ ask: 'autoplan gates', words: 'assume Garry will take the recommendations', by: 'Garry (user-scope AGENTS.md)', scope: 'autoplan gates: take the recommendations', outcome: 'standing', date: '2026-10-20', source: 'AGENTS.md', ...over }, branch);
  if ('code' in r) throw new Error(r.message);
  return r;
};
const decisions = (out: string) => fs.readFileSync(path.join(out, 'decisions.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));

describe('E16: the gate prints what it cost and what rec adds', () => {
  test('recReopens names each plan-changing recommendation\'s phase plus Eng last, and nothing when no recommendation changes the plan', () => {
    expect(recReopens(list('b'), ['ceo', 'design', 'eng'])).toEqual(['ceo', 'eng']);
    expect(recReopens(list('a'), ['ceo', 'design', 'eng'])).toEqual([]);
    expect(recReopens(list('b'), ['ceo', 'design'])).toEqual(['ceo']);
    const carried = list('b'); carried.items[0]!.carried = { from: 'x', chosen: 'b', gate_rev: 1 };
    expect(recReopens(carried, ['ceo', 'eng'])).toEqual([]);
  });

  test('the lines price the reopen at the per-voice reservation, two voices each with the outside voice on, and name unknown host attempts', () => {
    const out = path.join(TMP, 'cost'); fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'spend.json'), JSON.stringify({ schema_version: 1, cap_usd: 40, spent_usd: 1.5, reserved: [], released: [],
      settled: [{ attempt: 'a1', usd: 1.5, reserved_usd: 5, at: 't' }, { attempt: 'a2', usd: 'unknown', reserved_usd: 5, at: 't' }] }));
    const c = gateCost(out, list('b'), { phase_order: ['ceo', 'design', 'eng'], outside_enabled: true, spend_cap_usd: 40 });
    expect(c).toMatchObject({ attempts: 2, reopens: ['ceo', 'eng'], voices: 4, per_voice_usd: 5, rec_more_usd: 20 });
    const lines = renderGateCost(c);
    expect(lines[0]).toBe('GATE_SPEND: spent=1.50 worst_case=6.50 cap=40.00 headroom=33.50 attempts=2; 1 host-subagent attempt(s) priced unknown, counted at their reservation (read the actual figure in the host\'s cost view)');
    expect(lines[1]).toBe('GATE_REC_COST: rec reopens ceo,eng ≈ 4 voice(s) × 5.00 = +20.00 (estimate at the run\'s per-voice reservation) → headroom 13.50');
    expect(gateCostSentence(c)).toContain('Taking every recommendation reopens ceo, eng: about +20.00 more.');
    const tight = path.join(out, 'tight.json');
    fs.writeFileSync(tight, fs.readFileSync(path.join(out, 'spend.json'), 'utf8').replace('"cap_usd":40', '"cap_usd":10'));
    const over = renderGateCost(gateCost(out, list('b'), { phase_order: ['ceo', 'design', 'eng'], outside_enabled: true, spend_cap_usd: 10 }, { spendFile: tight }));
    expect(over[1]).toContain('(over the cap: raise it with gstack-autoplan budget before answering rec)');
    const uncapped = path.join(out, 'uncapped.json');
    fs.writeFileSync(uncapped, fs.readFileSync(path.join(out, 'spend.json'), 'utf8').replace('"cap_usd":40', '"cap_usd":null'));
    const none = renderGateCost(gateCost(out, list('a'), { phase_order: ['ceo', 'eng'], outside_enabled: false, spend_cap_usd: null }, { spendFile: uncapped }));
    expect(none[0]).toContain('cap=none headroom=none');
    expect(none[1]).toBe('GATE_REC_COST: rec reopens nothing (no recommended option changes the plan): +0.00');
    const empty = gateCost(path.join(TMP, 'no-ledger'), list('b'), { phase_order: ['ceo', 'eng'], outside_enabled: true, spend_cap_usd: null }, { defaultPerVoiceUsd: 5 });
    expect(empty).toMatchObject({ attempts: 0, per_voice_usd: 5, rec_more_usd: 20 });
  });
});

describe('E22: the mirror honours the Captain-named approvals directory', () => {
  const home = path.join(TMP, 'home');
  const drive = path.join(home, '.capy', 'drive');
  fs.mkdirSync(path.join(drive, 'project-user-gstack-garry', 'autoplan-checkpoints'), { recursive: true });
  const base = { GSTACK_CAPY: '1', HOME: home, GSTACK_STATE_ROOT: path.join(TMP, 'state') } as NodeJS.ProcessEnv;
  const at = (e: NodeJS.ProcessEnv) => { const l = locate({ cwd: ROOT, env: e, branch: 'lane-x' }); if ('code' in l) throw new Error(l.message); return l; };

  test('no Captain drive: the private project-user folder; one Captain drive with approvals/: that directory; two: back to project-user; GSTACK_APPROVALS_DIR wins over both', () => {
    expect(captainApprovalsDir(base)).toBeUndefined();
    expect(at(base)).toMatchObject({ mirror_source: 'project-user drive' });
    expect(at(base).mirror).toBe(path.join(drive, 'project-user-gstack-garry', 'approvals', at(base).slug, path.basename(at(base).file)));
    fs.mkdirSync(path.join(drive, 'captain-minder'), { recursive: true });
    expect(captainApprovalsDir(base)).toBeUndefined();
    fs.mkdirSync(path.join(drive, 'captain-minder', 'approvals'));
    expect(captainApprovalsDir(base)).toBe(path.join(drive, 'captain-minder', 'approvals'));
    expect(at(base)).toMatchObject({ mirror_source: 'captain drive', mirror: path.join(drive, 'captain-minder', 'approvals', at(base).slug, path.basename(at(base).file)) });
    fs.mkdirSync(path.join(drive, 'captain-other', 'approvals'), { recursive: true });
    expect(captainApprovalsDir(base)).toBeUndefined();
    expect(at(base)).toMatchObject({ mirror_source: 'project-user drive' });
    fs.rmSync(path.join(drive, 'captain-other'), { recursive: true });
    const explicit = path.join(TMP, 'explicit');
    expect(at({ ...base, GSTACK_APPROVALS_DIR: explicit })).toMatchObject({ mirror_source: 'GSTACK_APPROVALS_DIR', mirror: path.join(explicit, at(base).slug, path.basename(at(base).file)) });
    expect(at({ ...base, GSTACK_APPROVALS_MIRROR: '0' }).mirror).toBeUndefined();
    expect(captainApprovalsDir({ ...base, GSTACK_CAPY: undefined })).toBeUndefined();
  });

  test('gstack-approvals path names the rule that chose the mirror', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'gstack-approvals'), 'path', '--branch', 'lane-x'], { cwd: ROOT, env: { ...process.env, ...base } as Record<string, string>, encoding: 'utf8', timeout: 30_000 });
    expect(r.stdout).toContain('(captain drive)');
  });
});

describe('E21: a standing approval answers rec without a round trip', () => {
  test('coversAutoplanRec needs outcome standing, autoplan in the ask or scope, and the recommendations in the words or scope', () => {
    expect(coversAutoplanRec(row())).toBe(true);
    expect(coversAutoplanRec(row({ outcome: 'approved' }))).toBe(false);
    expect(coversAutoplanRec(row({ ask: 'merges', scope: 'merge when green' }))).toBe(false);
    expect(coversAutoplanRec(row({ words: 'do it', scope: 'autoplan gates' }))).toBe(false);
    expect(coversAutoplanRec(row({ words: 'rec', scope: 'autoplan' }))).toBe(true);
  });

  test('standingRecApproval reads every branch\'s record, local and mirror, newest standing row first', () => {
    const state = path.join(TMP, 'state-s'); const mirror = path.join(TMP, 'mirror-s');
    const envS = { GSTACK_STATE_ROOT: state, GSTACK_APPROVALS_DIR: mirror } as NodeJS.ProcessEnv;
    const lane = locate({ cwd: ROOT, env: envS, branch: 'lane-y' }); if ('code' in lane) throw new Error(lane.message);
    expect(standingRecApproval(lane)).toBeUndefined();
    const older = row({ date: '2026-10-18', words: 'take the recommendations' }, 'main');
    const newer = row({ date: '2026-10-20' }, 'captain-branch');
    const other = row({ outcome: 'approved', ask: 'Approve the plan' }, 'captain-branch');
    fs.mkdirSync(path.dirname(lane.mirror!), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(lane.mirror!), 'main-abc.jsonl'), JSON.stringify(older) + '\n');
    fs.mkdirSync(path.dirname(lane.file), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(lane.file), 'captain-branch-def.jsonl'), [newer, other].map(r => JSON.stringify(r)).join('\n') + '\n');
    expect(standingRecApproval(lane)?.id).toBe(newer.id);
  });

  /** Both voices challenge the same item: the gate recommends the plan change (b) and `rec` would reopen phases. */
  function gateRun(name: string, extraFinding: Record<string, unknown> = {}): string {
    const out = startSmallRun(path.join(TMP, name));
    const native = JSON.stringify([
      { id: 'F1', severity: 'High', title: 'The install check lies by omission', file: 'bin/gstack-doctor', line: 12, fix: 'print PASS/FAIL per component', ...extraFinding },
      { id: 'F3', severity: 'High', title: 'Four lanes share result-codes.ts', file: 'lib/result-codes.ts', line: 1, user_challenge: true, changes: 'direction', fix: 'stack the lanes' }]);
    const outside = JSON.stringify([
      { id: 'O1', severity: 'Critical', title: 'The install check lies by omission', file: 'bin/gstack-doctor', line: 14, fix: 'exit non-zero on any FAIL', ...extraFinding },
      { id: 'O3', severity: 'High', title: 'Four lanes share result-codes.ts', file: 'lib/result-codes.ts', line: 1, user_challenge: true, changes: 'direction', fix: 'Stack the lanes.' }]);
    let last = '';
    for (const phase of ['ceo', 'eng']) {
      const n = autoplan(['next', '--out', out]);
      expect(n.status).toBe(0);
      review(path.join(out, `${phase}-native-prompt.md`), { FIXTURE_FINDINGS: native });
      review(path.join(out, `${phase}-outside-prompt.md`), { FIXTURE_FINDINGS: outside });
      const ids = attemptsOf(out, phase);
      expect(autoplan(['submit', '--out', out, '--phase', phase, '--voice', 'native', '--result', resultOf(out, phase, 'native'), '--model', 'anthropic/claude-opus-4-7', '--attempt', ids.native, '--runner', 'host-subagent']).status).toBe(0);
      last = autoplan(['submit', '--out', out, '--phase', phase, '--voice', 'outside', '--result', resultOf(out, phase, 'outside'), '--model', 'openai/gpt-6-astra', '--attempt', ids.outside, '--runner', 'host-subagent']).stdout;
    }
    expect(readRun(out).status).toBe('gate_pending');
    expect(last).toMatch(/^GATE_SPEND: spent=\d+\.\d\d worst_case=\d+\.\d\d cap=\S+ headroom=\S+ attempts=4/m);
    expect(last).toMatch(/^GATE_REC_COST: rec reopens /m);
    return out;
  }

  const approvalsEnv = (dir: string) => env({ GSTACK_APPROVALS_DIR: dir, GSTACK_STATE_ROOT: path.join(TMP, 'state-run') });

  test('with no covering row the answer is refused (STANDING_APPROVAL_ABSENT) and the gate stays pending; --owner-standing takes only rec', () => {
    const out = gateRun('absent');
    const dir = path.join(TMP, 'approvals-absent');
    const r = autoplan(['answer', '--out', out, '--gate-rev', '1', '--owner-standing', 'rec', '--by', 'agent:lane', '--branch', 'lane-z'], { env: approvalsEnv(dir) });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('(STANDING_APPROVAL_ABSENT)');
    expect(readRun(out).status).toBe('gate_pending');
    expect(autoplan(['answer', '--out', out, '--gate-rev', '1', '--owner-standing', 'd1a', '--by', 'agent:lane']).status).toBe(2);
    expect(autoplan(['answer', '--out', out, '--gate-rev', '1', '--owner-standing', 'rec', '--reply', 'rec', '--by', 'agent:lane']).status).toBe(2);
  });

  test('a covering row from another branch answers rec: STANDING line, standing id on every answered row and in the import source; the brief carries the cost sentence', () => {
    const out = gateRun('standing');
    const dir = path.join(TMP, 'approvals-standing');
    const l = locate({ cwd: ROOT, env: { GSTACK_APPROVALS_DIR: dir, GSTACK_STATE_ROOT: path.join(TMP, 'state-run') }, branch: 'lane-z' }); if ('code' in l) throw new Error(l.message);
    fs.mkdirSync(path.dirname(l.mirror!), { recursive: true });
    const standing = row({}, 'main');
    fs.writeFileSync(path.join(path.dirname(l.mirror!), 'main-0000000000.jsonl'), JSON.stringify(standing) + '\n');
    const brief = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'gstack-owner-brief'), 'render', '--out', out], { cwd: ROOT, env: env(), encoding: 'utf8', timeout: 30_000 });
    expect(brief.stdout).toMatch(/Cost so far: spent \d+\.\d\d, worst case \d+\.\d\d \(/);
    const human = autoplan(['answer', '--out', out, '--gate-rev', '1', '--owner-standing', 'rec', '--by', 'human'], { env: approvalsEnv(dir) });
    expect(human.status).toBe(3);
    expect(human.stderr).toContain('(ANSWER_BY_REQUIRED)');
    const r = autoplan(['answer', '--out', out, '--gate-rev', '1', '--owner-standing', 'rec', '--by', 'agent:lane', '--branch', 'lane-z'], { env: approvalsEnv(dir) });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`STANDING: ${standing.id} (2026-10-20, Garry (user-scope AGENTS.md); AGENTS.md) "assume Garry will take the recommendations" — scope: autoplan gates: take the recommendations`);
    expect(r.stdout).not.toContain('GATE_PENDING');
    const answered = decisions(out).filter(d => d.gate_rev === 1 && d.answered_at);
    expect(answered.length).toBeGreaterThan(0);
    for (const d of answered) expect(d).toMatchObject({ answered_by: 'agent:lane', reply: 'rec', owner_reply: 'assume Garry will take the recommendations', owner_reply_parsed: false, standing: standing.id });
    expect(readRun(out).gate).toMatchObject({ answered_by: 'agent:lane', standing: standing.id });
    expect(['amend_pending', 'complete', 'running']).toContain(readRun(out).status);
    const imp = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'gstack-approvals'), 'import', '--autoplan', out, '--by', 'Garry', '--branch', 'lane-z', '--json'], { cwd: ROOT, env: approvalsEnv(dir) as Record<string, string>, encoding: 'utf8', timeout: 30_000 });
    expect(imp.status).toBe(0);
    const recorded = fs.readFileSync(l.mirror!, 'utf8').trim().split('\n').map(x => JSON.parse(x)).find((x: any) => x.source.startsWith('autoplan:'));
    expect(recorded.source).toContain(` standing=${standing.id}`);
    expect(recorded.by).toBe(`Garry, standing approval ${standing.id} cited by agent:lane`);
  });

  test('an urgent finding at the gate makes the standing path refuse (STANDING_APPROVAL_INAPPLICABLE)', () => {
    const out = gateRun('urgent', { urgent: true });
    const dir = path.join(TMP, 'approvals-urgent');
    const l = locate({ cwd: ROOT, env: { GSTACK_APPROVALS_DIR: dir, GSTACK_STATE_ROOT: path.join(TMP, 'state-run') }, branch: 'lane-z' }); if ('code' in l) throw new Error(l.message);
    fs.mkdirSync(path.dirname(l.mirror!), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(l.mirror!), 'main-0000000000.jsonl'), JSON.stringify(row({}, 'main')) + '\n');
    const r = autoplan(['answer', '--out', out, '--gate-rev', '1', '--owner-standing', 'rec', '--by', 'agent:lane', '--branch', 'lane-z'], { env: approvalsEnv(dir) });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('(STANDING_APPROVAL_INAPPLICABLE)');
    expect(readRun(out).status).toBe('gate_pending');
    expect(decisions(out).some(d => d.standing)).toBe(false);
  });
});
