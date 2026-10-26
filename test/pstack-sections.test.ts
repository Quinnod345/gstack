/**
 * pstack absorb (GSTA-116 plan, items 6 and 9): benchmark's vet-the-number
 * section and plan-eng-review's design-twice section. Pins the carve shape
 * (manifest ids, STOP pointers, where each pointer sits) and the tokens each
 * section must carry; prose is not pinned.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CARVE_GUARDS } from './helpers/carve-guards';

const ROOT = path.resolve(import.meta.dir, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('benchmark carve: vet the number', () => {
  const skeleton = read('benchmark/SKILL.md');
  const section = read('benchmark/sections/vet-the-number.md');
  const manifest = JSON.parse(read('benchmark/sections/manifest.json')) as { skill: string; sections: Array<{ id: string; file: string }> };

  test('one section, registered, pointed to at the top of Phase 5 before any comparison is written', () => {
    expect(manifest.skill).toBe('benchmark');
    expect(manifest.sections.map(s => s.id)).toEqual(['vet-the-number']);
    expect(CARVE_GUARDS.benchmark!.expectedSections).toEqual(['vet-the-number.md']);
    const phase5 = skeleton.indexOf('### Phase 5: Comparison');
    const stop = skeleton.indexOf('> **STOP.**');
    expect(skeleton.indexOf('## Arguments')).toBeLessThan(stop);
    expect(stop).toBeGreaterThan(phase5);
    expect(stop).toBeLessThan(skeleton.indexOf('If baseline exists, compare current metrics against it'));
    expect(skeleton.match(/> \*\*STOP\.\*\*/g)).toHaveLength(1);
    expect(skeleton).toContain('sections/vet-the-number.md');
    expect(skeleton).toMatch(/\*\*Vet every number before reporting it\.\*\*/);
  });

  test('the seven questions, the one-run ballpark rule, the 11% arithmetic, alternating runs, and the inconclusive verdict', () => {
    expect(section).toContain('## Vet the number');
    const questions = ['**Why not double?**', '**Was it tuned?**', '**Did it break a limit?**', '**Did it error?**', '**Does it reproduce?**', '**Does it matter?**', '**Did it even happen?**'];
    let last = -1;
    for (const q of questions) {
      const at = section.indexOf(q);
      expect(at, q).toBeGreaterThan(last);
      last = at;
    }
    expect(section).toContain('Name the limiter');
    expect(section).toMatch(/one run,\s+still answer questions 4 and 7/);
    expect(section).toMatch(/10%[\s\S]*at most about 11% faster/);
    expect(section).toMatch(/alternating A, B, A, B/);
    expect(section).toContain('A gap smaller than the run-to-run');
    expect(section).toMatch(/faster, slower, no measurable difference, or\s+inconclusive/);
    expect(section).toMatch(/cannot name the limiter/);
  });
});

describe('plan-eng-review carve: two shapes before one', () => {
  const skeleton = read('plan-eng-review/SKILL.md');
  const section = read('plan-eng-review/sections/design-twice.md');
  const manifest = JSON.parse(read('plan-eng-review/sections/manifest.json')) as { sections: Array<{ id: string; file: string; scope?: string; runner_only?: boolean }> };

  test('registered beside review-sections, pointed to before it, and visible to the autoplan runner', () => {
    expect(manifest.sections.map(s => s.id)).toEqual(['review-sections', 'design-twice', 'checklist']);
    const entry = manifest.sections.find(s => s.id === 'design-twice')!;
    expect(entry.scope).toBe('always');
    expect(entry.runner_only).toBeUndefined();
    expect(CARVE_GUARDS['plan-eng-review']!.expectedSections).toEqual(['design-twice.md', 'review-sections.md']);
    const designStop = skeleton.indexOf('sections/design-twice.md', skeleton.indexOf('> **STOP.**'));
    const reviewStop = skeleton.indexOf('sections/review-sections.md', skeleton.indexOf('> **STOP.**'));
    expect(designStop).toBeGreaterThan(0);
    expect(designStop).toBeLessThan(reviewStop);
    expect(skeleton.lastIndexOf('EXIT PLAN MODE GATE')).toBeGreaterThan(skeleton.lastIndexOf('> **STOP.**'));
    expect(read('plan-eng-review/sections/checklist.md')).toContain('Two shapes before one (design-twice)');
  });

  test('a second structurally distinct shape, interface depth, the agent-contributor assumption, and the eight red flags in order', () => {
    expect(section).toContain('## Two shapes before one');
    expect(section).toContain('### Ask for the second shape');
    expect(section).toMatch(/require a second shape that is structurally\s+different/);
    expect(section).toMatch(/A point fix inside the first shape is not a\s+second candidate\./);
    expect(section).toContain('interface depth');
    expect(section).toContain('A deep module is not a deep call chain');
    expect(section).toMatch(/an agent that sees only the files it opened, copies the nearest example\s+and takes the shortest path that compiles/);
    const flags = ['**Shallow module.**', '**Information leakage.**', '**Temporal decomposition.**', '**Pass-through method.**', '**Split ownership.**', '**Two ways to do one task.**', '**Importable internals.**', '**Hand-synced list.**'];
    let last = section.indexOf('### The eight red flags');
    expect(last).toBeGreaterThan(0);
    for (const f of flags) {
      const at = section.indexOf(f);
      expect(at, f).toBeGreaterThan(last);
      last = at;
    }
  });
});

describe('every pstack-derived section carries its credit line', () => {
  for (const rel of ['investigate/sections/blast-radius.md.tmpl', 'context-restore/sections/transcripts.md.tmpl', 'benchmark/sections/vet-the-number.md.tmpl', 'plan-eng-review/sections/design-twice.md.tmpl']) {
    test(rel, () => {
      const first = read(rel).split('\n')[0]!;
      expect(first.startsWith('<!--')).toBe(true);
      expect(first).toContain('pstack');
      expect(first).toContain('MIT');
      expect(first).toContain('rewritten');
      expect(first).toContain('See NOTICE.md');
      expect(read('NOTICE.md')).toContain(rel.replace('.tmpl', ''));
    });
  }
});
