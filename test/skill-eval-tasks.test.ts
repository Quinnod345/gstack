import { describe, test, expect, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { buildSkillBill, checkEvalTasks, renderSkillBill } from '../lib/skill-bill';

/**
 * Task files for the shared skill eval (docs/designs/SKILL_EVAL_CONTRACT.md) live at
 * test/fixtures/skill-evals/<skill>/tasks.json. gstack-skill-bill reports them for a checkout
 * skill through checkEvalTasks; this test holds every committed file to the contract's format.
 */
const ROOT = path.resolve(import.meta.dir, '..');
const DIR = path.join(ROOT, 'test', 'fixtures', 'skill-evals');
const skills = fs.readdirSync(DIR).filter(d => fs.statSync(path.join(DIR, d)).isDirectory()).sort();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-eval-tasks-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('skill-evals task files follow the shared eval contract', () => {
  test('there is at least one task file', () => {
    expect(skills.length).toBeGreaterThan(0);
  });

  for (const skill of skills) {
    test(`${skill}/tasks.json`, () => {
      const r = checkEvalTasks(path.join(DIR, skill, 'tasks.json'));
      expect(r.problems).toEqual([]);
      expect(r.count).toBeGreaterThan(0);
    });
  }

  test('a malformed task file is reported, one problem per defect', () => {
    const file = path.join(tmp, 'tasks.json');
    fs.writeFileSync(file, JSON.stringify([
      { id: 'Bad Id', prompt: '' },
      { id: 'dup', prompt: 'x', must: ['('], extra: 1 },
      { id: 'dup', prompt: 'y', check: 'true', setup: 'sh "$SKILL_EVAL_FIXTURES/seed.sh"', safety: 'yes' },
      1,
      ['nested'],
    ]));
    expect(checkEvalTasks(file).problems).toEqual([
      'Bad Id: id must be kebab-case',
      'Bad Id: prompt must be a non-empty string',
      'Bad Id: needs must or check, or nothing can fail it',
      'dup: unknown key extra',
      'dup: must pattern /(/ does not compile',
      'dup: duplicate id',
      'dup: safety must be a boolean',
      'dup: setup runs seed.sh but it is missing',
      '?: task must be an object, got 1',
      '?: task must be an object, got ["nested"]',
    ]);
    fs.writeFileSync(file, '{');
    expect(checkEvalTasks(file).problems[0]).toStartWith('not valid JSON');
  });

  test('gstack-skill-bill shows a checkout skill its eval tasks', () => {
    const report = buildSkillBill(path.join(ROOT, 'learn'));
    const count = JSON.parse(fs.readFileSync(path.join(DIR, 'learn', 'tasks.json'), 'utf8')).length;
    expect(report.evalTasks).toEqual({ path: 'test/fixtures/skill-evals/learn/tasks.json', count, problems: [] });
    expect(renderSkillBill(report)).toContain(`EVAL TASKS: test/fixtures/skill-evals/learn/tasks.json (${count} tasks)`);
  });
});
