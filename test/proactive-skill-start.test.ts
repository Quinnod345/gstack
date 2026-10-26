/**
 * The PROACTIVE STATUS line (GSTA-93 fix 12, proactive core default): every
 * skill reads `PROACTIVE:` from bin/gstack-skill-start, which asks
 * bin/gstack-config and falls back to a literal when the config binary is
 * missing. The default moved from `true` to `core`.
 *
 * Value: protects=the PROACTIVE STATUS line a skill reads carries the stored
 * proactive value and core when unset; fails_when=gstack-skill-start stops
 * consulting gstack-config for proactive or the default moves back to true;
 * why_new=proactive-config.test.ts exercises gstack-config alone and
 * gstack-skill-start.test.ts asserts only that the key is emitted; seam=none;
 * no_claim=how the model applies the value (prose, not executed here)
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
});
