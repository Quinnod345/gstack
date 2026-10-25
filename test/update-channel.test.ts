/**
 * Update channels (free; docs/releases.md). A team install follows
 * refs/heads/stable, the weekly release, instead of every merge to main:
 * bin/gstack-update-channel.sh resolves update_channel (auto | stable | main;
 * auto is stable when team_mode is true), bin/gstack-session-update fetches
 * and fast-forwards to the channel ref, falls back to main before the first
 * release exists and never moves an install backwards, bin/gstack-upgrade
 * follows the same ref, and bin/gstack-update-check compares with the channel
 * so a stable install is not told that main moved.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const HELPER = path.join(ROOT, 'bin', 'gstack-update-channel.sh');
const SESSION_UPDATE = path.join(ROOT, 'bin', 'gstack-session-update');
const bases: string[] = [];
afterEach(() => { for (const b of bases.splice(0)) fs.rmSync(b, { recursive: true, force: true }); });

const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x', GIT_CONFIG_NOSYSTEM: '1' };
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...GIT_ENV } }).trim();
}
const write = (file: string, text: string, mode = 0o644) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, { mode }); };

/** A gstack-config stub: team_mode and update_channel come from files the test writes. */
const CONFIG_STUB = '#!/usr/bin/env bash\nif [ "$1" = "get" ]; then case "$2" in auto_upgrade) echo true;; skill_prefix) echo false;; team_mode) cat "$TEAM_MODE_FILE" 2>/dev/null;; update_channel) cat "$CHANNEL_FILE" 2>/dev/null;; *) echo "";; esac; fi\nexit 0\n';

describe.skipIf(process.platform === 'win32')('gstack-update-channel.sh: resolution', () => {
  function install() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-channel-'));
    bases.push(base);
    write(path.join(base, 'bin', 'gstack-config'), CONFIG_STUB, 0o755);
    const resolve = (team: string, channel: string, extra: Record<string, string> = {}) => {
      fs.writeFileSync(path.join(base, 'team'), team);
      fs.writeFileSync(path.join(base, 'channel'), channel);
      const r = spawnSync('bash', ['-c', '. "$1" && gstack_update_channel "$2"', '_', HELPER, base], { encoding: 'utf8', env: { ...process.env, TEAM_MODE_FILE: path.join(base, 'team'), CHANNEL_FILE: path.join(base, 'channel'), GSTACK_UPDATE_CHANNEL: '', ...extra }, timeout: 10_000 });
      return r.stdout.trim() + (r.status === 0 ? '' : ' exit=' + r.status);
    };
    return { base, resolve };
  }

  test('auto is stable for a team install and main otherwise; explicit values win; junk is auto; the env override wins over all', () => {
    const f = install();
    expect(f.resolve('true', '')).toBe('stable');
    expect(f.resolve('true', 'auto')).toBe('stable');
    expect(f.resolve('false', '')).toBe('main');
    expect(f.resolve('', '')).toBe('main');
    expect(f.resolve('true', 'main')).toBe('main');
    expect(f.resolve('false', 'stable')).toBe('stable');
    expect(f.resolve('true', 'weekly')).toBe('stable');
    expect(f.resolve('false', 'weekly')).toBe('main');
    expect(f.resolve('true', 'stable', { GSTACK_UPDATE_CHANNEL: 'main' })).toBe('main');
  });

  test('the refspec and ref name stable only; a missing gstack-config means main', () => {
    const r = spawnSync('bash', ['-c', '. "$1" && gstack_update_channel_refspec stable && gstack_update_channel_ref stable && gstack_update_channel_refspec main | wc -c && gstack_update_channel /nonexistent', '_', HELPER], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, GSTACK_UPDATE_CHANNEL: '' } });
    expect(r.stdout.split('\n').map(l => l.trim())).toEqual(['+refs/heads/stable:refs/remotes/origin/stable', 'refs/remotes/origin/stable', '1', 'main', '']);
    expect(spawnSync('bash', ['-c', '. "$1" && gstack_update_channel_missing "fatal: couldn\'t find remote ref refs/heads/stable" && ! gstack_update_channel_missing "fatal: unable to access"', '_', HELPER], { encoding: 'utf8', timeout: 10_000 }).status).toBe(0);
  });
});

/** Origin with main A < B < C, stable at B, a single-branch depth-1 install at A (as README's clone command makes). */
function world(opts: { installAt?: 'A' | 'C'; stable?: boolean } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-channel-world-'));
  bases.push(base);
  const origin = path.join(base, 'origin.git');
  const seed = path.join(base, 'seed');
  const install = path.join(base, 'install');
  const state = path.join(base, 'state');
  const home = path.join(base, 'home');
  fs.mkdirSync(state); fs.mkdirSync(home);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { timeout: 30_000 });
  fs.mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'remote', 'add', 'origin', origin);
  write(path.join(seed, 'bin', 'gstack-config'), CONFIG_STUB, 0o755);
  write(path.join(seed, 'bin', 'gstack-patch-names'), '#!/usr/bin/env bash\nexit 0\n', 0o755);
  for (const rel of ['bin/gstack-sanitize-echo.sh', 'bin/gstack-update-channel.sh', 'bin/gstack-bun-version.sh', 'bin/gstack-paths', 'bin/gstack-state-root.sh', 'bin/gstack-egress-lib.sh', 'bin/gstack-egress-receipt', 'lib/egress-receipt.ts', 'lib/state-root.ts', 'bin/gstack-lease', 'bin/gstack-harness-pid.sh', 'bin/gstack-install-verdict.sh', 'bin/gstack-upgrade']) {
    if (!fs.existsSync(path.join(ROOT, rel))) continue;
    fs.mkdirSync(path.dirname(path.join(seed, rel)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), path.join(seed, rel));
    fs.chmodSync(path.join(seed, rel), fs.statSync(path.join(ROOT, rel)).mode);
  }
  write(path.join(seed, 'setup'), '#!/usr/bin/env bash\necho "setup $*" >> "$SETUP_CALLS"\nexit 0\n', 0o755);
  const shas: Record<string, string> = {};
  const release = (name: string, version: string) => {
    write(path.join(seed, 'VERSION'), version + '\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', name);
    git(seed, 'push', '-q', 'origin', 'main');
    shas[name] = git(seed, 'rev-parse', 'HEAD');
  };
  release('A', '1.0.0');
  if (opts.installAt !== 'C') execFileSync('git', ['clone', '-q', '--single-branch', '--depth', '1', 'file://' + origin, install], { timeout: 30_000 });
  release('B', '1.0.1');
  release('C', '1.0.2');
  if (opts.installAt === 'C') execFileSync('git', ['clone', '-q', '--single-branch', '--depth', '1', 'file://' + origin, install], { timeout: 30_000 });
  if (opts.stable !== false) git(seed, 'push', '-q', 'origin', shas.B + ':refs/heads/stable');
  const team = path.join(base, 'team'), channel = path.join(base, 'channel'), calls = path.join(base, 'setup-calls');
  fs.writeFileSync(team, 'true'); fs.writeFileSync(channel, '');
  const env = { ...process.env, ...GIT_ENV, HOME: home, GSTACK_DIR: install, GSTACK_STATE_ROOT: state, TEAM_MODE_FILE: team, CHANNEL_FILE: channel, SETUP_CALLS: calls, TMPDIR: base, GSTACK_UPDATE_CHANNEL: '' };
  return { base, origin, seed, install, state, shas, team, channel, env, head: () => git(install, 'rev-parse', 'HEAD') };
}
type World = ReturnType<typeof world>;

async function updaterLog(w: World, pattern: RegExp, ms = 20_000): Promise<string> {
  const logFile = path.join(w.state, 'analytics', 'session-update.log');
  const deadline = Date.now() + ms;
  let content = '';
  while (Date.now() < deadline) {
    content = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    if (pattern.test(content) && !fs.existsSync(path.join(w.state, '.setup-lock'))) return content;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('timed out waiting for ' + pattern + '; log:\n' + content);
}
function runHook(w: World) {
  return spawnSync('bash', [SESSION_UPDATE], { encoding: 'utf8', env: { ...w.env, PATH: path.dirname(process.execPath) + ':' + process.env.PATH }, timeout: 20_000 });
}

describe.skipIf(process.platform === 'win32')('gstack-session-update on the stable channel', () => {
  test('a team install moves to origin/stable (B), not main (C), and logs the channel', async () => {
    const w = world();
    expect(w.head()).toBe(w.shas.A);
    expect(runHook(w).stdout).toBe('');
    const log = await updaterLog(w, /UPDATED|PULL_FAILED|UP_TO_DATE/);
    expect(log).toContain('CHANNEL stable target=' + w.shas.B);
    expect(log).toContain('UPDATING old=' + w.shas.A + ' new=' + w.shas.B);
    expect(log).toContain('UPDATED from=1.0.0 to=1.0.1');
    expect(w.head()).toBe(w.shas.B);
    expect(fs.readFileSync(path.join(w.install, 'VERSION'), 'utf8').trim()).toBe('1.0.1');
  });

  test('update_channel=main on a team install follows every merge (C), as before channels existed', async () => {
    const w = world();
    fs.writeFileSync(w.channel, 'main');
    runHook(w);
    const log = await updaterLog(w, /UPDATED|PULL_FAILED|UP_TO_DATE/);
    expect(log).not.toContain('CHANNEL ');
    expect(log).toContain('UPDATING old=' + w.shas.A + ' new=' + w.shas.C);
    expect(w.head()).toBe(w.shas.C);
  });

  test('before the first release exists (no stable on origin) the install follows main and says so', async () => {
    const w = world({ stable: false });
    runHook(w);
    const log = await updaterLog(w, /UPDATED|PULL_FAILED|UP_TO_DATE/);
    expect(log).toContain('CHANNEL_FALLBACK stable->main reason=no-stable-on-origin');
    expect(log).toContain('UPDATING old=' + w.shas.A + ' new=' + w.shas.C);
    expect(w.head()).toBe(w.shas.C);
  });

  test('an install already past the release (at C, stable at B) stays where it is: up to date, no pull failure, nothing pending', async () => {
    const w = world({ installAt: 'C' });
    runHook(w);
    const log = await updaterLog(w, /UPDATED|PULL_FAILED|UP_TO_DATE/);
    expect(log).toContain('CHANNEL stable ahead_of_release head=' + w.shas.C + ' stable=' + w.shas.B);
    expect(log).toContain('UP_TO_DATE head=' + w.shas.C);
    expect(log).not.toContain('PULL_FAILED');
    expect(w.head()).toBe(w.shas.C);
    expect(fs.existsSync(path.join(w.state, 'session-update-pending'))).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('gstack-upgrade on the stable channel', () => {
  const run = (w: World, args: string[] = []) => spawnSync('bash', [path.join(w.install, 'bin', 'gstack-upgrade'), ...args], { cwd: w.base, encoding: 'utf8', env: w.env, timeout: 60_000 });

  test('--check and the upgrade follow stable (B) and name the channel; update_channel=main then goes on to C', () => {
    const w = world();
    const check = run(w, ['--check']);
    expect(check.status, check.stdout + check.stderr).toBe(1);
    expect(check.stdout).toContain('gstack-upgrade: behind 1.0.0 -> 1.0.1 (1 commits)');
    expect(check.stderr).toContain('gstack-upgrade: channel stable');
    const up = run(w);
    expect(up.status, up.stdout + up.stderr).toBe(0);
    expect(up.stdout).toContain('gstack-upgrade: upgraded 1.0.0 -> 1.0.1');
    expect(w.head()).toBe(w.shas.B);
    expect(run(w, ['--check']).stdout).toContain('gstack-upgrade: current 1.0.1');
    fs.writeFileSync(w.channel, 'main');
    const main = run(w, ['--check']);
    expect(main.stdout).toContain('gstack-upgrade: behind 1.0.1 -> 1.0.2 (1 commits)');
    expect(main.stderr).not.toContain('channel stable');
    expect(run(w).status).toBe(0);
    expect(w.head()).toBe(w.shas.C);
  });

  test('a depth-1 install already past the release (at C, stable at B) is current, not diverged', () => {
    const w = world({ installAt: 'C' });
    const check = run(w, ['--check']);
    expect(check.status, check.stdout + check.stderr).toBe(0);
    expect(check.stdout).toContain('gstack-upgrade: current 1.0.2');
    expect(w.head()).toBe(w.shas.C);
  });

  test('with no stable on origin yet, a team install follows main and the note says so', () => {
    const w = world({ stable: false });
    const check = run(w, ['--check']);
    expect(check.status).toBe(1);
    expect(check.stdout).toContain('gstack-upgrade: behind 1.0.0 -> 1.0.2 (2 commits)');
    expect(check.stderr).toContain('channel stable has no release on origin yet; following main');
  });
});

describe.skipIf(process.platform === 'win32')('gstack-update-check on the stable channel', () => {
  test('a checkout at stable stays silent while main is ahead; the cache identity carries the channel; ls-remote asks for refs/heads/stable', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-channel-check-'));
    bases.push(base);
    const gstack = path.join(base, 'gstack'), origin = path.join(base, 'origin.git'), state = path.join(base, 'state'), raw = path.join(base, 'raw'), shim = path.join(base, 'shim');
    for (const d of [path.join(gstack, 'bin'), state, raw, shim]) fs.mkdirSync(d, { recursive: true });
    const realGit = execFileSync('bash', ['-c', 'command -v git'], { encoding: 'utf8', timeout: 10_000 }).trim();
    const gitLog = path.join(base, 'git.log');
    fs.writeFileSync(path.join(shim, 'git'), '#!/usr/bin/env bash\ncase "$1" in ls-remote) echo "git $*" >> "' + gitLog + '" ;; esac\nexec "' + realGit + '" "$@"\n', { mode: 0o755 });
    for (const name of ['gstack-config', 'gstack-egress-lib.sh', 'gstack-state-root.sh', 'gstack-egress-receipt', 'gstack-update-channel.sh']) fs.symlinkSync(path.join(ROOT, 'bin', name), path.join(gstack, 'bin', name));
    fs.writeFileSync(path.join(gstack, 'VERSION'), '1.0.0\n');
    fs.writeFileSync(path.join(gstack, '.gitignore'), 'bin/\n');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { timeout: 30_000 });
    git(gstack, 'init', '-q', '-b', 'main'); git(gstack, 'add', '-A'); git(gstack, 'commit', '-q', '-m', 'base');
    git(gstack, 'remote', 'add', 'origin', origin); git(gstack, 'push', '-q', 'origin', 'main'); git(gstack, 'push', '-q', 'origin', 'main:stable');
    const local = git(gstack, 'rev-parse', 'HEAD');
    const clone = path.join(base, 'upstream');
    execFileSync('git', ['clone', '-q', origin, clone], { timeout: 30_000 });
    fs.writeFileSync(path.join(clone, 'VERSION'), '1.0.1\n');
    git(clone, 'commit', '-qam', 'main moved'); git(clone, 'push', '-q', 'origin', 'HEAD:main');
    const main = git(clone, 'rev-parse', 'HEAD');
    for (const [sha, v] of [[local, '1.0.0'], [main, '1.0.1']]) { fs.mkdirSync(path.join(raw, sha!)); fs.writeFileSync(path.join(raw, sha!, 'VERSION'), v + '\n'); }
    const env = { ...process.env, ...GIT_ENV, HOME: base, GSTACK_DIR: gstack, GSTACK_STATE_ROOT: state, GSTACK_REMOTE_REPO: origin, GSTACK_REMOTE_RAW_BASE: 'file://' + raw, GSTACK_COMPARE_API: 'file://' + path.join(base, 'compare'), PATH: shim + ':' + process.env.PATH };
    delete (env as Record<string, string | undefined>).GSTACK_REMOTE_URL;
    const run = (extra: Record<string, string>) => spawnSync('bash', [path.join(ROOT, 'bin', 'gstack-update-check')], { encoding: 'utf8', timeout: 30_000, env: { ...env, ...extra } });
    const stable = run({ GSTACK_UPDATE_CHANNEL: 'stable' });
    expect(stable.stdout.trim()).toBe('');
    expect(fs.readFileSync(path.join(state, 'last-update-check'), 'utf8')).toBe('UP_TO_DATE 1.0.0\nIDENTITY head=' + local + ' remote=' + local + ' upstream=' + origin + '#stable\n');
    expect(fs.readFileSync(gitLog, 'utf8')).toContain('refs/heads/stable');
    expect(fs.readFileSync(gitLog, 'utf8')).not.toContain('refs/heads/main');
    const onMain = run({ GSTACK_UPDATE_CHANNEL: 'main' });
    expect(onMain.stdout.trim()).toBe('UPGRADE_AVAILABLE 1.0.0 1.0.1');
    expect(fs.readFileSync(gitLog, 'utf8')).toContain('refs/heads/main');
  });
});
