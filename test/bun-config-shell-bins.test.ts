/**
 * #3415: gstack's shell bins start Bun with
 * --config="${GSTACK_BUN_CONFIG:-/dev/null}", and each defines
 * GSTACK_BUN_CONFIG as NUL under MINGW, MSYS and Cygwin. Native bun.exe cannot
 * open /dev/null (EINVAL), so a Windows bash with MSYS path conversion off
 * (MSYS_NO_PATHCONV=1, MSYS2_ARG_CONV_EXCL=*) made the literal spelling fail:
 * the record bins wrote nothing, and gstack-timeline-log still exited 0.
 *
 * On every platform the free lanes run, windows-latest included, the record
 * bins run through lib/script-invocation.ts with conversion off in a hostile
 * repository: each writes its record, and the repository's bunfig.toml preload
 * and .env never load. On POSIX a simulated Windows bash (uname reporting
 * MINGW64, a bun that rejects /dev/null the way bun.exe does) reproduces the
 * bug; its controls, with uname reporting Linux, show each bin fails loudly
 * with nothing written instead of exiting 0.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runScriptSync } from '../lib/script-invocation';

const ROOT = path.resolve(import.meta.dir, '..');
const IS_WINDOWS = process.platform === 'win32';

let tmp = '';
let repo = '';
let stateRoot = '';
let evilRoot = '';
let preloadMarker = '';
let fakeWindows = '';
let fakeBunOnly = '';

const BINS: Array<{ bin: string; input: string; log: string }> = [
  { bin: 'gstack-review-log', log: 'main-reviews.jsonl', input: JSON.stringify({ skill: 'plan-eng-review', timestamp: '2026-10-25T00:00:00Z', status: 'clean', unresolved: 0, critical_gaps: 0, issues_found: 0, mode: 'FULL_REVIEW', commit: 'abc1234' }) },
  { bin: 'gstack-question-log', log: 'question-log.jsonl', input: JSON.stringify({ skill: 'ship', question_id: 'ship-test-failure-triage', question_summary: 'Tests failed', options_count: 3, user_choice: 'fix-now', recommended: 'fix-now', session_id: 's1' }) },
  { bin: 'gstack-learnings-log', log: 'learnings.jsonl', input: JSON.stringify({ skill: 'review', type: 'pitfall', key: 'n-plus-one', insight: 'fixture insight', confidence: 8, source: 'observed' }) },
  { bin: 'gstack-timeline-log', log: 'timeline.jsonl', input: JSON.stringify({ skill: 'review', event: 'started', branch: 'main' }) },
];

function env(pathPrefix?: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(GSTACK_|MSYS)/.test(k)) out[k] = v;
  const PATH = Object.keys(out).find(k => k.toUpperCase() === 'PATH') ?? 'PATH';
  if (pathPrefix) out[PATH] = pathPrefix + path.delimiter + (out[PATH] ?? '');
  return { ...out, HOME: path.join(tmp, 'home'), GSTACK_STATE_ROOT: stateRoot, MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' };
}

function run(bin: string, input: string, pathPrefix?: string) {
  return runScriptSync(path.join(ROOT, 'bin', bin), [input], { cwd: repo, env: env(pathPrefix), encoding: 'utf8', timeout: 60_000 });
}

function records(log: string): string[] {
  const projects = path.join(stateRoot, 'projects');
  if (!fs.existsSync(projects)) return [];
  return fs.readdirSync(projects).flatMap(slug => {
    const file = path.join(projects, slug, log);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  });
}

function resetState(): void {
  fs.rmSync(stateRoot, { recursive: true, force: true });
  fs.mkdirSync(stateRoot, { recursive: true });
}

function writeExec(file: string, text: string): void {
  fs.writeFileSync(file, text);
  fs.chmodSync(file, 0o755);
}

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-bunconfig-')));
  repo = path.join(tmp, 'repo');
  stateRoot = path.join(tmp, 'state');
  evilRoot = path.join(tmp, 'evil');
  preloadMarker = path.join(tmp, 'preload-ran');
  for (const d of [repo, stateRoot, path.join(tmp, 'home')]) fs.mkdirSync(d, { recursive: true });
  for (const args of [['init', '-q', '-b', 'main'], ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']]) {
    expect(spawnSync('git', args, { cwd: repo, timeout: 30_000 }).status).toBe(0);
  }
  fs.writeFileSync(path.join(repo, '.env'), `GSTACK_STATE_ROOT=${evilRoot}\nGSTACK_HOME=${evilRoot}\n`);
  fs.writeFileSync(path.join(repo, 'preload.ts'), `require('fs').writeFileSync(${JSON.stringify(preloadMarker)}, 'ran');\n`);
  fs.writeFileSync(path.join(repo, 'bunfig.toml'), 'preload = ["./preload.ts"]\n');
  if (IS_WINDOWS) return;
  fakeWindows = path.join(tmp, 'fake-windows');
  fakeBunOnly = path.join(tmp, 'fake-bun-only');
  for (const dir of [fakeWindows, fakeBunOnly]) {
    fs.mkdirSync(dir);
    writeExec(path.join(dir, 'bun'), [
      '#!/usr/bin/env bash',
      'a=()',
      'for x in "$@"; do',
      '  case "$x" in',
      '    --config=/dev/null) echo "EINVAL: Invalid argument (open())" >&2; echo "while reading config \\"/dev/null\\"" >&2; exit 1 ;;',
      '    --config=NUL) a+=(--config=/dev/null) ;;',
      '    *) a+=("$x") ;;',
      '  esac',
      'done',
      `exec ${JSON.stringify(process.execPath)} "\${a[@]}"`,
      '',
    ].join('\n'));
  }
  writeExec(path.join(fakeWindows, 'uname'), '#!/usr/bin/env bash\n[ "$1" = -s ] && { echo MINGW64_NT-10.0-26100; exit 0; }\nexec /usr/bin/uname "$@"\n');
  writeExec(path.join(fakeWindows, 'cygpath'), '#!/usr/bin/env bash\nprintf "%s\\n" "$2"\n');
});

afterAll(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

describe('#3415: record bins start Bun on a Windows bash with path conversion off', () => {
  test('fixture control: a plain bun in the repository runs its bunfig preload', () => {
    const r = spawnSync(process.execPath, ['-e', '0'], { cwd: repo, encoding: 'utf8', timeout: 60_000 });
    expect(r.status).toBe(0);
    expect(fs.existsSync(preloadMarker)).toBe(true);
    fs.rmSync(preloadMarker);
  });

  for (const { bin, input, log } of BINS) {
    test(`${bin} writes its record and ignores the repository bunfig.toml and .env`, () => {
      resetState();
      const r = run(bin, input);
      expect(r.stderr).not.toContain('EINVAL');
      expect(r.status).toBe(0);
      expect(records(log).length).toBe(1);
      expect(fs.existsSync(preloadMarker)).toBe(false);
      expect(fs.existsSync(evilRoot)).toBe(false);
    });
  }

  test('gstack-timeline-log still skips invalid input silently with exit 0', () => {
    resetState();
    for (const bad of ['not json', '{"skill":"review"}', 'null']) {
      const r = run('gstack-timeline-log', bad);
      expect(r.status).toBe(0);
      expect(r.stderr).toBe('');
    }
    expect(records('timeline.jsonl')).toEqual([]);
  });
});

describe.skipIf(IS_WINDOWS)('#3415: simulated Windows bash (POSIX hosts)', () => {
  for (const { bin, input, log } of BINS) {
    test(`${bin} passes NUL and writes its record`, () => {
      resetState();
      const r = run(bin, input, fakeWindows);
      expect(r.stderr).not.toContain('EINVAL');
      expect(r.status).toBe(0);
      expect(records(log).length).toBe(1);
      expect(fs.existsSync(preloadMarker)).toBe(false);
    });

    test(`control: when Bun rejects the config, ${bin} fails loudly and writes nothing`, () => {
      resetState();
      const r = run(bin, input, fakeBunOnly);
      expect(r.stderr).toContain('EINVAL');
      expect(r.status).not.toBe(0);
      expect(records(log)).toEqual([]);
    });
  }
});
