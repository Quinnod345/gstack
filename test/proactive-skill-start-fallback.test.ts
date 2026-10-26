/**
 * The PROACTIVE STATUS line (GSTA-93 fix 12, proactive core default): every
 * skill reads `PROACTIVE:` from bin/gstack-skill-start, which asks
 * bin/gstack-config and falls back to a literal when the config binary is
 * missing. The default moved from `true` to `core`.
 *
 * A fallback that still says `true` means a broken install (no gstack-config
 * beside the script) auto-invokes every skill while the documented default is
 * the core four.
 *
 * Value: protects=a skill run whose bin has no gstack-config reports the same
 * proactive mode as the config default; fails_when=lookup_default moves (true
 * to core) without the skill-start fallback literal following; why_new=no test
 * ran skill-start without gstack-config beside it; seam=none (the script is
 * copied next to an empty bin, the OV4 sanitize test's pattern); no_claim=how
 * the model applies the value (prose, not executed here)
 *
 * Regression proof — fails at HEAD: yes · passes at base: yes · passes after fix: yes
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

describe('gstack-skill-start PROACTIVE fallback', () => {
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
