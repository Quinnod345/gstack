import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Task files for the shared skill eval (docs/designs/SKILL_EVAL_CONTRACT.md) live at
 * test/fixtures/skill-evals/<skill>/tasks.json. gstack ships no harness, so this free test
 * is their only in-repo reader: it holds every file to the contract's task format.
 */
const ROOT = path.resolve(import.meta.dir, '..');
const DIR = path.join(ROOT, 'test', 'fixtures', 'skill-evals');
const KEYS = new Set(['id', 'prompt', 'setup', 'must', 'must_not', 'check', 'safety']);
const skills = fs.readdirSync(DIR).filter(d => fs.statSync(path.join(DIR, d)).isDirectory()).sort();

describe('skill-evals task files follow the shared eval contract', () => {
  test('there is at least one task file', () => {
    expect(skills.length).toBeGreaterThan(0);
  });

  for (const skill of skills) {
    test(`${skill}/tasks.json`, () => {
      const tasks = JSON.parse(fs.readFileSync(path.join(DIR, skill, 'tasks.json'), 'utf8'));
      expect(Array.isArray(tasks)).toBe(true);
      const problems: string[] = [];
      const ids = new Set<string>();
      for (const t of tasks) {
        const where = `${skill}/${t?.id ?? '?'}`;
        for (const k of Object.keys(t)) if (!KEYS.has(k)) problems.push(`${where}: unknown key ${k}`);
        if (typeof t.id !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(t.id)) problems.push(`${where}: id must be kebab-case`);
        if (ids.has(t.id)) problems.push(`${where}: duplicate id`);
        ids.add(t.id);
        if (typeof t.prompt !== 'string' || !t.prompt.trim()) problems.push(`${where}: prompt must be a non-empty string`);
        for (const k of ['setup', 'check']) if (k in t && typeof t[k] !== 'string') problems.push(`${where}: ${k} must be a string`);
        for (const k of ['must', 'must_not']) {
          if (!(k in t)) continue;
          if (!Array.isArray(t[k]) || !t[k].every((x: unknown) => typeof x === 'string')) { problems.push(`${where}: ${k} must be a string array`); continue; }
          for (const re of t[k]) { try { new RegExp(re); } catch { problems.push(`${where}: ${k} pattern /${re}/ does not compile`); } }
        }
        if ('safety' in t && typeof t.safety !== 'boolean') problems.push(`${where}: safety must be a boolean`);
        if (!('must' in t) && !('check' in t)) problems.push(`${where}: needs must or check, or nothing can fail it`);
        if (typeof t.setup === 'string' && t.setup.includes('seed.sh') && !fs.existsSync(path.join(DIR, skill, 'seed.sh'))) problems.push(`${where}: setup runs seed.sh but ${skill}/seed.sh is missing`);
      }
      expect(problems).toEqual([]);
    });
  }
});
