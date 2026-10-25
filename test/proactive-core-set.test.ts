/**
 * The core-set proactive default (GSTA-93 fix 12): the router and every skill's
 * preamble carry the same three-way rule, the one-time prompt offers core, all
 * and off, and the question registry agrees. Negative controls: no surface
 * still describes true as "the default", and the preamble never tells a skill to
 * auto-invoke a non-core skill under core.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

import { QUESTIONS } from '../scripts/question-registry';
import { generateUpgradeCheck } from '../scripts/resolvers/preamble/generate-upgrade-check';

const ROOT = path.resolve(import.meta.dir, '..');
const CORE = ['/office-hours', '/review', '/qa', '/ship'];
const NON_CORE_SAMPLE = ['/investigate', '/plan-ceo-review', '/design-review', '/retro'];

const routerTmpl = fs.readFileSync(path.join(ROOT, 'SKILL.md.tmpl'), 'utf-8');
const routerOut = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
const skillStart = fs.readFileSync(path.join(ROOT, 'bin', 'gstack-skill-start'), 'utf-8');

describe('proactive core set: the router', () => {
  test('the template names core as the default and lists exactly the four core skills', () => {
    const block = routerTmpl.slice(routerTmpl.indexOf('If `PROACTIVE` is `core` (default)'), routerTmpl.indexOf('If `PROACTIVE` is `all`'));
    expect(block.length).toBeGreaterThan(50);
    for (const skill of CORE) expect(block).toContain(`\`${skill}\``);
    for (const skill of NON_CORE_SAMPLE) expect(block).not.toContain(`\`${skill}\``);
    expect(block).toContain('A skill the user names is always invoked');
  });

  test('off and all are spelled with their legacy aliases; true is no longer "the default" (negative control)', () => {
    expect(routerTmpl).toContain('If `PROACTIVE` is `false` or `off`');
    expect(routerTmpl).toContain('If `PROACTIVE` is `all` (or `true`)');
    expect(routerTmpl).not.toMatch(/`PROACTIVE` is `true` \(default\)/);
    expect(routerTmpl).toContain('gstack-config set proactive off');
    expect(routerTmpl).toContain('gstack-config set proactive all');
    expect(routerTmpl).not.toContain('gstack-config set proactive false');
  });

  test('the generated router carries the same rule', () => {
    expect(routerOut).toContain('If `PROACTIVE` is `core` (default)');
    for (const skill of CORE) expect(routerOut).toContain(`\`${skill}\``);
  });
});

describe('proactive core set: every skill preamble', () => {
  const line = generateUpgradeCheck({ paths: { skillRoot: '~/.claude/skills/gstack' } } as never);

  test('the steady-state rule names core as the default with the four core skills, and keeps the false marker the order test reads', () => {
    expect(line).toMatch(/^If `PROACTIVE` is `false` or `off`/);
    expect(line).toContain('if `core` (default), only /office-hours, /review, /qa and /ship');
    expect(line).toContain('`all` or `true`: any');
    expect(line).toContain('suggest no skill, even by asking');
    for (const skill of NON_CORE_SAMPLE) expect(line).not.toContain(skill);
  });

  test('the preamble did not grow: the size guard pins only move down, so the rule stays within the old line budget', () => {
    const old = 'If `PROACTIVE` is `false`, do not auto-invoke or suggest skills, including by asking whether to run one. Only run skills the user explicitly invokes.\n\nIf `SKILL_PREFIX` is `"true"`, suggest/invoke `/gstack-*` names. Disk paths stay `~/.claude/skills/gstack/[skill-name]/SKILL.md`.';
    expect(line.length).toBeLessThanOrEqual(old.length);
  });

  test('a generated core skill and a generated non-core skill both carry it (it is the same preamble)', () => {
    for (const skill of ['review', 'investigate']) {
      const out = fs.readFileSync(path.join(ROOT, skill, 'SKILL.md'), 'utf-8');
      expect(out).toContain('if `core` (default), only /office-hours, /review, /qa and /ship');
    }
  });
});

describe('proactive core set: the one-time prompt and the registry', () => {
  test('the prompt offers core (recommended), all and off, and never writes true or false', () => {
    const block = skillStart.slice(skillStart.indexOf('_emit_block proactive-prompt'), skillStart.indexOf('.proactive-prompted"\\`', skillStart.indexOf('_emit_block proactive-prompt')));
    expect(block).toContain('Keep the core four (recommended)');
    expect(block).toContain('gstack-config set proactive core');
    expect(block).toContain('gstack-config set proactive all');
    expect(block).toContain('gstack-config set proactive off');
    expect(block).not.toContain('set proactive true');
    expect(block).not.toContain('set proactive false');
    expect(block).toContain("Turn it off — I'll type /commands myself");
  });

  test('the registry entry matches the prompt options', () => {
    expect(QUESTIONS['preamble-proactive-behavior'].options).toEqual(['core', 'all', 'off']);
  });
});
