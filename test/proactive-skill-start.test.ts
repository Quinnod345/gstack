/**
 * The PROACTIVE STATUS line (GSTA-93 fix 12, proactive core default): every
 * skill reads `PROACTIVE:` from bin/gstack-skill-start, which asks
 * bin/gstack-config and falls back to a literal when the config binary is
 * missing. The default moved from `true` to `core`.
 *
 * Value: protects=the PROACTIVE STATUS line a skill reads carries the stored
 * proactive value, core when unset, and core for a value the router does not
 * know; fails_when=gstack-skill-start stops consulting gstack-config for
 * proactive, the default moves back to true, or a hand-edited junk value leaks
 * into STATUS; why_new=proactive-config.test.ts exercises gstack-config alone and
 * gstack-skill-start.test.ts asserts only that the key is emitted; seam=none;
 * no_claim=how the model applies the value (prose, not executed here)
 *
 * The fallback test: a broken install (no gstack-config beside the script)
 * must report the same mode as the config default.
 * Value: protects=a skill run whose bin has no gstack-config reports the same
 * proactive mode as the config default; fails_when=lookup_default moves (true
 * to core) without the skill-start fallback literal following; why_new=no test
 * ran skill-start without gstack-config beside it; seam=none (the script is
 * copied next to an empty bin, the OV4 sanitize test's pattern); no_claim=how
 * the model applies the value (prose, not executed here)
 * Regression proof — fails at HEAD (b115142): yes · passes at base: yes · passes after fix (9e22d7f): yes
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runBin } from './helpers/run-bin';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin');

let tmpHome: string;

beforeAll(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-proactive-ss-home-'));
});

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function freshState(config: string): string {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-proactive-ss-state-'));
  fs.writeFileSync(path.join(state, 'config.yaml'), config);
  return state;
}

function runStart(script: string, state: string): string {
  const r = runBin(script, ['--skill', 'testskill'], {
    cwd: tmpHome,
    timeoutMs: 30_000,
    env: {
      PATH: process.env.PATH,
      HOME: tmpHome,
      GSTACK_HOME: state,
      GSTACK_STATE_DIR: state,
      GSTACK_LEASE_DIR: path.join(state, 'leases'),
    },
  });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

const proactiveLine = (out: string) => out.match(/^PROACTIVE: (.*)$/m)?.[1];

describe('gstack-skill-start PROACTIVE status line', () => {
  test('carries core when nothing is stored, and the stored value (new or legacy spelling) otherwise', () => {
    const cases: Array<[string, string]> = [
      ['update_check: false\n', 'core'],
      ['update_check: false\nproactive: all\n', 'all'],
      ['update_check: false\nproactive: off\n', 'off'],
      ['update_check: false\nproactive: true\n', 'true'],
      ['update_check: false\nproactive: on\n', 'core'],
    ];
    for (const [config, expected] of cases) {
      const state = freshState(config);
      try {
        expect(proactiveLine(runStart(path.join(BIN, 'gstack-skill-start'), state)), config).toBe(expected);
      } finally {
        fs.rmSync(state, { recursive: true, force: true });
      }
    }
  });

  test('the CLAUDE.md routing offer fires under core and not under off (the routing rules are the auto-invocation off turns off)', () => {
    const cases: Array<[string, boolean]> = [
      ['update_check: false\n', true],
      ['update_check: false\nproactive: off\n', false],
      ['update_check: false\nproactive: false\n', false],
    ];
    for (const [config, offered] of cases) {
      const state = freshState(config);
      fs.writeFileSync(path.join(state, '.proactive-prompted'), '');
      try {
        const out = runStart(path.join(BIN, 'gstack-skill-start'), state);
        expect(out, config).toContain('HAS_ROUTING: no');
        expect(out.includes('GSTACK_INSTRUCTION_BEGIN: routing-injection '), config).toBe(offered);
      } finally {
        fs.rmSync(state, { recursive: true, force: true });
      }
    }
  });

  test('regression: with no gstack-config beside it, the fallback reports the config default, not a stale literal', () => {
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-proactive-ss-bin-'));
    const state = freshState('update_check: false\n');
    try {
      for (const f of ['gstack-skill-start', 'gstack-state-root.sh']) fs.copyFileSync(path.join(BIN, f), path.join(fakeBin, f));
      fs.chmodSync(path.join(fakeBin, 'gstack-skill-start'), 0o755);
      const configDefault = runBin(path.join(BIN, 'gstack-config'), ['get', 'proactive'], { gstackHome: state, cwd: ROOT, trim: true }).stdout;
      expect(configDefault).not.toBe('');
      expect(proactiveLine(runStart(path.join(fakeBin, 'gstack-skill-start'), state))).toBe(configDefault);
    } finally {
      fs.rmSync(fakeBin, { recursive: true, force: true });
      fs.rmSync(state, { recursive: true, force: true });
    }
  });
});
