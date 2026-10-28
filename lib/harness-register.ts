/**
 * gstack-harness: register gstack's skills with the agent harness gstack is
 * installed into, the harness's own way, and take them back out (GSTA-135).
 *
 * Targets: openclaw and hermes (hosts with renders: real copies in the
 * harness's own skills folder), dots (a router skill in the Dot's skills
 * folder), generic (a router skill and/or a marked context block for any other
 * harness), qm (an org skill pack through QM's admin API, lib/harness-qm.ts),
 * muse and grok (detection only: both already read ~/.claude/skills).
 *
 * Every write is recorded in a ledger, $GSTACK_STATE_ROOT/harness/<id>.ledger,
 * a TSV that bin/gstack-harness-ledger.sh reads without bun, so
 * bin/gstack-uninstall removes exactly what was written before it removes the
 * checkout. A file edited after registration is moved to a backup, never
 * deleted; an entry gstack did not write is never overwritten.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { bunIsolationArgs } from './bun-isolation';

export type SkillsMode = 'router' | 'all';
export type TargetName = 'openclaw' | 'hermes' | 'dots' | 'generic' | 'qm' | 'muse' | 'grok';
type Env = Record<string, string | undefined>;

/** Every-session budgets (rule 30): the router's description and the context block. */
export const ROUTER_DESCRIPTION_MAX = 300;
export const CONTEXT_BLOCK_MAX = 600;
export const BLOCK_BEGIN = '<!-- gstack:begin harness-routing -->';
export const BLOCK_END = '<!-- gstack:end harness-routing -->';
export const ROUTER_DESCRIPTION = 'gstack engineering workflows: code review, QA testing, debugging, security audit, plan and design review, shipping PRs, release docs, retros. Load first for any coding, review, test, plan or release task; it lists every gstack skill and where to read it.';

export interface Target {
  name: TargetName;
  displayName: string;
  mechanism: 'skill-folder' | 'skill-pack-api' | 'verify-only' | 'context-block';
  /** Which skills the payload carries: the host's own render, or the checkout's committed Claude render. */
  render: 'host' | 'claude' | null;
  defaultMode: SkillsMode;
  modes: SkillsMode[];
  /** Destination folder for this target, from its environment, or null when it has no default. */
  dest: (env: Env, home: string) => string | null;
  /** Running inside this harness: a session marker or the harness among this process's ancestors. */
  inside: (env: Env, ancestry: string[]) => boolean;
  /** Installed on this machine (binary on PATH or its home folder). */
  present: (env: Env, home: string) => boolean;
  /** The harness's own command that lists the skills it sees, when it has one. */
  listCommand?: (dest: string) => { argv: string[]; env: Env; expect: RegExp };
}

const onPath = (bin: string, env: Env) => (env.PATH ?? '').split(path.delimiter).some(d => d && fs.existsSync(path.join(d, bin)));
/** An ancestor is the harness when its program, or the script its interpreter runs, is named for it (arguments never count). */
const ancestorIs = (ancestry: string[], name: string) => ancestry.some(id => {
  const [exe, script = ''] = id.split(' ');
  return exe === name || (/^(node|nodejs|bun|python[0-9.]*)$/.test(exe) && script.replace(/.(mjs|js|py)$/, '') === name);
});

export const TARGETS: Record<TargetName, Target> = {
  openclaw: {
    name: 'openclaw', displayName: 'OpenClaw', mechanism: 'skill-folder', render: 'host', defaultMode: 'router', modes: ['router', 'all'],
    dest: (env, home) => path.join(env.OPENCLAW_STATE_DIR || path.join(home, '.openclaw'), 'skills'),
    inside: (env, anc) => !!env.OPENCLAW_SESSION || ancestorIs(anc, 'openclaw'),
    present: (env, home) => onPath('openclaw', env) || fs.existsSync(env.OPENCLAW_STATE_DIR || path.join(home, '.openclaw')),
    listCommand: dest => ({ argv: ['openclaw', 'skills', 'list', '--json'], env: { OPENCLAW_STATE_DIR: path.dirname(dest) }, expect: /"name":\s*"gstack(-[a-z0-9-]+)?"/ }),
  },
  hermes: {
    name: 'hermes', displayName: 'Hermes', mechanism: 'skill-folder', render: 'host', defaultMode: 'all', modes: ['all'],
    dest: (env, home) => path.join(env.HERMES_HOME || path.join(home, '.hermes'), 'skills', 'gstack'),
    inside: (env, anc) => !!env.HERMES_SESSION_KEY || ancestorIs(anc, 'hermes'),
    present: (env, home) => onPath('hermes', env) || fs.existsSync(env.HERMES_HOME || path.join(home, '.hermes')),
    listCommand: dest => ({ argv: ['hermes', 'skills', 'list'], env: { HERMES_HOME: path.dirname(path.dirname(dest)) }, expect: /gstack-[a-z0-9-]+/ }),
  },
  dots: {
    name: 'dots', displayName: 'dots (feder-cr)', mechanism: 'skill-folder', render: 'claude', defaultMode: 'router', modes: ['router', 'all'],
    dest: (_env, home) => path.join(home, 'skills'),
    inside: (env) => fs.existsSync('/opt/invisible-dots') && (env.HOME ?? '') === '/home/dot',
    present: () => fs.existsSync('/opt/invisible-dots'),
  },
  generic: {
    name: 'generic', displayName: 'any other harness', mechanism: 'context-block', render: 'claude', defaultMode: 'router', modes: ['router', 'all'],
    dest: () => null,
    inside: () => false,
    present: () => false,
  },
  qm: {
    name: 'qm', displayName: 'QM', mechanism: 'skill-pack-api', render: null, defaultMode: 'all', modes: ['all'],
    dest: env => env.GSTACK_QM_URL || null,
    inside: () => false,
    present: () => false,
  },
  muse: {
    name: 'muse', displayName: 'Muse Code', mechanism: 'verify-only', render: null, defaultMode: 'all', modes: ['all'],
    dest: () => null, inside: () => false, present: env => onPath('muse', env),
    listCommand: () => ({ argv: ['muse', 'skills', 'list'], env: {}, expect: /\b(gstack|review|ship|office-hours)\b/ }),
  },
  grok: {
    name: 'grok', displayName: 'Grok Build', mechanism: 'verify-only', render: null, defaultMode: 'all', modes: ['all'],
    dest: () => null, inside: () => false, present: env => onPath('grok', env),
    listCommand: () => ({ argv: ['grok', 'inspect'], env: {}, expect: /\b(gstack|review|ship|office-hours)\b/ }),
  },
};

/** Reason codes users can see; each has a section in docs/troubleshooting.md (test/harness-register.test.ts). */
export const HARNESS_CODES = {
  HARNESS_UNKNOWN_TARGET: { anchor: 'harness-unknown-target', fix: 'name one of: openclaw, hermes, dots, generic, qm, muse, grok' },
  HARNESS_NO_DESTINATION: { anchor: 'harness-no-destination', fix: 'pass --skills-dir <dir> or --context <file>, or --print to see the block without writing' },
  HARNESS_MODE_UNSUPPORTED: { anchor: 'harness-mode-unsupported', fix: 'drop --skills, or pass a mode the target supports (Hermes opens only listed skills, so it takes all)' },
  HARNESS_UNSAFE_DESTINATION: { anchor: 'harness-unsafe-destination', fix: 'pick a destination that is a plain folder outside the gstack checkout, not your home folder, with no tab or newline in its path' },
  HARNESS_UNOWNED_ENTRY: { anchor: 'harness-unowned-entry', fix: 'move or rename the existing entry (gstack did not write it), then register again' },
  HARNESS_RENDER_FAILED: { anchor: 'harness-render-failed', fix: 'run bun install in the gstack checkout, then register again; the render output above names the failing skill' },
  HARNESS_BUDGET_EXCEEDED: { anchor: 'harness-budget-exceeded', fix: 'this is a gstack bug: report it with the byte count printed above' },
  HARNESS_NOT_REGISTERED: { anchor: 'harness-not-registered', fix: 'run gstack-harness status to see the registrations on this machine' },
  HARNESS_QM_CREDENTIALS: { anchor: 'harness-qm-credentials', fix: 'set GSTACK_QM_URL and either GSTACK_QM_ADMIN_TOKEN, or GSTACK_QM_SIGNING_SECRET with GSTACK_QM_ADMIN_ACTOR, then rerun with --yes' },
  HARNESS_QM_API: { anchor: 'harness-qm-api', fix: 'check that the QM core URL is reachable and the credential is an org admin; gstack-harness status shows whether a pack was left half-registered' },
} as const;
export type HarnessCode = keyof typeof HARNESS_CODES;

export class HarnessError extends Error {
  constructor(readonly code: HarnessCode, message: string) { super(message); }
  line(): string {
    const c = HARNESS_CODES[this.code];
    return 'gstack-harness: ' + this.message + '. Fix: ' + c.fix + ' (' + this.code + '; docs/troubleshooting.md#' + c.anchor + ')';
  }
}

export function getTarget(name: string): Target {
  const t = (TARGETS as Record<string, Target>)[name];
  if (!t) throw new HarnessError('HARNESS_UNKNOWN_TARGET', 'unknown harness ' + JSON.stringify(name));
  return t;
}

/** This process's ancestors as "<program> <first argument>" basenames, nearest first (Linux /proc, else ps). */
export function processAncestry(pid = process.pid, depth = 16): string[] {
  const out: string[] = [];
  let cur = pid;
  for (let i = 0; i < depth && cur > 1; i++) {
    let ppid = 0; let cmd = '';
    try {
      const stat = fs.readFileSync('/proc/' + cur + '/stat', 'utf8');
      ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      cmd = fs.readFileSync('/proc/' + cur + '/cmdline', 'utf8').split('\0').slice(0, 2).map(a => path.basename(a)).join(' ');
    } catch {
      const r = spawnSync('ps', ['-o', 'ppid=,command=', '-p', String(cur)], { encoding: 'utf8', timeout: 5000 });
      const m = (r.stdout ?? '').trim().match(/^(\d+)\s+(.*)$/);
      if (!m) break;
      ppid = Number(m[1]); cmd = m[2].split(/\s+/).slice(0, 2).map(a => path.basename(a)).join(' ');
    }
    if (i > 0) out.push(cmd);
    if (!ppid || ppid === cur) break;
    cur = ppid;
  }
  return out;
}

export interface Detection { inside: TargetName[]; present: TargetName[] }
export function detect(env: Env = process.env, home = os.homedir(), ancestry = processAncestry()): Detection {
  const names = Object.keys(TARGETS) as TargetName[];
  return {
    inside: names.filter(n => TARGETS[n].inside(env, ancestry)),
    present: names.filter(n => TARGETS[n].present(env, home)),
  };
}

// --- payload --------------------------------------------------------------

export interface SkillEntry { name: string; use: string; dir: string }

function frontmatterField(md: string, field: string): string {
  const fm = md.startsWith('---\n') ? md.slice(4, md.indexOf('\n---', 4)) : '';
  const lines = fm.split('\n');
  const i = lines.findIndex(l => l.startsWith(field + ':'));
  if (i < 0) return '';
  const first = lines[i].slice(field.length + 1).trim();
  if (first !== '|' && first !== '>') return first.replace(/^["']|["']$/g, '');
  const body: string[] = [];
  for (const l of lines.slice(i + 1)) { if (!/^\s/.test(l)) break; body.push(l.trim()); }
  return body.join(' ');
}

/** First sentence of a description, without the trailing "(gstack)" tag, at most 160 characters. */
export function oneLineUse(description: string): string {
  const d = description.replace(/\s*\(gstack\)\s*$/, '').replace(/\s+/g, ' ').trim();
  const s = (d.match(/^.*?[.!?](\s|$)/)?.[0] ?? d).trim();
  return s.length > 160 ? s.slice(0, 157).trimEnd() + '...' : s;
}

function skillDirs(root: string): SkillEntry[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).sort().flatMap(name => {
    const md = path.join(root, name, 'SKILL.md');
    if (!fs.existsSync(md)) return [];
    const text = fs.readFileSync(md, 'utf8');
    if (!text.includes('AUTO-GENERATED')) return [];
    return [{ name: frontmatterField(text, 'name') || name, use: oneLineUse(frontmatterField(text, 'description')), dir: path.join(root, name) }];
  });
}

/** The skills a target's payload carries: the host render (made for this checkout as the install root) or the checkout's committed Claude render. */
export function sourceSkills(target: Target, checkout: string, scratch: string): SkillEntry[] {
  if (target.render === 'claude') return skillDirs(checkout).filter(s => s.name !== 'gstack');
  const out = path.join(scratch, 'render');
  fs.rmSync(out, { recursive: true, force: true });
  const r = spawnSync(process.execPath, [...bunIsolationArgs(), 'scripts/gen-skill-docs.ts', '--host', target.name, '--install-root', checkout, '--out-dir', out],
    { cwd: checkout, encoding: 'utf8', timeout: 300_000 });
  if (r.status !== 0) throw new HarnessError('HARNESS_RENDER_FAILED', 'could not render ' + target.name + ' skills: ' + ((r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' | ')));
  const skills = skillDirs(path.join(out, '.' + target.name, 'skills'));
  if (!skills.length) throw new HarnessError('HARNESS_RENDER_FAILED', 'the ' + target.name + ' render produced no skills');
  return skills;
}

export function routerSkill(skills: Array<{ name: string; use: string; path: string }>, target: Target): string {
  const claudeNote = target.render === 'claude'
    ? '\nThese files use Claude Code tool names (Bash, Read, Edit, Agent, AskUserQuestion); use your own equivalents.\n' : '';
  return [
    '---', 'name: gstack', 'description: ' + ROUTER_DESCRIPTION, '---',
    '<!-- AUTO-GENERATED by gstack-harness register: rerun it instead of editing -->',
    '# gstack skills', '',
    'Pick the one skill whose line matches the task, then read that SKILL.md in full and follow it. Read nothing else up front.' + claudeNote,
    ...skills.map(s => '- **' + s.name + '**: ' + s.use + ' Read `' + s.path + '`'),
    '',
  ].join('\n');
}

export function contextBlock(routerPath: string): string {
  return [BLOCK_BEGIN, '## gstack skills',
    "gstack's engineering workflows (code review, QA, debugging, security audit, plan review, shipping) are installed here. For a coding, review, test, plan or release task, read `" + routerPath + '`, pick the one skill whose line matches, then read and follow that skill. Load nothing else up front.',
    BLOCK_END].join('\n');
}

// --- ledger ----------------------------------------------------------------

export interface Ledger { meta: Record<string, string>; files: Array<{ sha: string; path: string }>; dirs: string[]; blocks: string[] }

export const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
export const ledgerDir = (stateRoot: string) => path.join(stateRoot, 'harness');
export const registrationId = (target: string, dest: string) => target + '-' + sha256(dest).slice(0, 12);
export const ledgerPath = (stateRoot: string, id: string) => path.join(ledgerDir(stateRoot), id + '.ledger');

export function readLedger(file: string): Ledger | null {
  if (!fs.existsSync(file)) return null;
  const l: Ledger = { meta: {}, files: [], dirs: [], blocks: [] };
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const [kind, a, ...rest] = line.split('\t');
    const b = rest.join('\t');
    if (kind === 'meta') l.meta[a] = b;
    else if (kind === 'file') l.files.push({ sha: a, path: b });
    else if (kind === 'dir') l.dirs.push(b);
    else if (kind === 'block') l.blocks.push(b);
  }
  return l;
}

export function writeLedger(file: string, l: Ledger): void {
  const rows = ['# gstack-harness ledger v1 (read by bin/gstack-harness-ledger.sh)',
    ...Object.entries(l.meta).map(([k, v]) => 'meta\t' + k + '\t' + v),
    ...l.files.map(f => 'file\t' + f.sha + '\t' + f.path),
    ...l.dirs.map(d => 'dir\t-\t' + d),
    ...l.blocks.map(b => 'block\t-\t' + b)];
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file + '.tmp', rows.join('\n') + '\n', { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}

export function listLedgers(stateRoot: string): Array<{ file: string; ledger: Ledger }> {
  const dir = ledgerDir(stateRoot);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.ledger')).sort()
    .flatMap(f => { const ledger = readLedger(path.join(dir, f)); return ledger ? [{ file: path.join(dir, f), ledger }] : []; });
}

// --- register ----------------------------------------------------------------

export interface RegisterOptions {
  target: Target;
  mode?: SkillsMode;
  /** Destination override: the harness skills folder (--skills-dir). */
  skillsDir?: string;
  /** Context file for the routing block (generic). */
  context?: string;
  checkout: string;
  stateRoot: string;
  env: Env;
  home: string;
  version: string;
  /** Publish an installs.tsv row for host targets (setup's own arm publishes it instead). */
  registry?: boolean;
}
export interface RegisterResult {
  id: string; target: TargetName; dest: string; mode: SkillsMode;
  status: 'installed' | 'updated' | 'unchanged'; written: number; skills: number; router: string | null; ledger: string;
}

const PLAIN = /^[^\t\n\r]+$/;

function assertSafeDest(dest: string, opts: RegisterOptions): void {
  const bad = (why: string) => { throw new HarnessError('HARNESS_UNSAFE_DESTINATION', 'refusing to write into ' + dest + ': ' + why); };
  if (!path.isAbsolute(dest) || !PLAIN.test(dest)) bad('not a plain absolute path');
  const norm = path.resolve(dest);
  if (norm === '/' || norm === path.resolve(opts.home)) bad('it is the filesystem root or your home folder');
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const co = real(opts.checkout);
  let probe = norm;
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  const resolved = path.join(real(probe), path.relative(probe, norm));
  if (resolved === co || resolved.startsWith(co + path.sep)) bad('it is inside the gstack checkout');
  if (fs.existsSync(norm) && fs.lstatSync(norm).isSymbolicLink()) bad('it is a symlink');
}

function walkFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    const st = fs.statSync(p);
    return st.isDirectory() ? walkFiles(p) : st.isFile() ? [p] : [];
  });
}

function resolveDest(opts: RegisterOptions, id?: string): string | null {
  if (opts.skillsDir) return path.resolve(opts.skillsDir);
  const d = opts.target.dest(opts.env, opts.home);
  if (d) return d;
  return opts.context && id ? path.join(ledgerDir(opts.stateRoot), id) : null;
}

/** Desired files (absolute path -> bytes) and the router path, for a skill-folder or generic target. */
export function planPayload(opts: RegisterOptions, dest: string, mode: SkillsMode, scratch: string): { files: Map<string, Buffer>; router: string | null; skills: number } {
  const t = opts.target;
  const skills = sourceSkills(t, opts.checkout, scratch);
  const files = new Map<string, Buffer>();
  const copyDir = (from: string, to: string) => { for (const f of walkFiles(from)) files.set(path.join(to, path.relative(from, f)), fs.readFileSync(f)); };
  const claudeFiles = (s: SkillEntry, to: string) => {
    files.set(path.join(to, 'SKILL.md'), fs.readFileSync(path.join(s.dir, 'SKILL.md')));
    if (fs.existsSync(path.join(s.dir, 'sections'))) copyDir(path.join(s.dir, 'sections'), path.join(to, 'sections'));
  };
  if (mode === 'all') {
    for (const s of skills) {
      const to = path.join(dest, path.basename(s.dir));
      if (t.render === 'host') copyDir(s.dir, to); else claudeFiles(s, to);
    }
    return { files, router: null, skills: skills.length };
  }
  const routerDir = path.join(dest, 'gstack');
  const entries = skills.map(s => {
    if (t.render !== 'host') return { name: s.name, use: s.use, path: path.join(s.dir, 'SKILL.md') };
    const to = path.join(routerDir, 'skills', path.basename(s.dir));
    copyDir(s.dir, to);
    return { name: s.name, use: s.use, path: path.join(to, 'SKILL.md') };
  });
  const router = path.join(routerDir, 'SKILL.md');
  files.set(router, Buffer.from(routerSkill(entries, t)));
  return { files, router, skills: skills.length };
}

function backupFile(file: string, stateRoot: string, stamp: string): void {
  const to = path.join(stateRoot, 'backups', 'harness', stamp, file.replace(/^\/+/, ''));
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(file, to);
}

function onDiskSha(file: string): string | null {
  try { return sha256(fs.readFileSync(file)); } catch { return null; }
}

export function insertBlock(file: string, block: string): void {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const a = text.indexOf(BLOCK_BEGIN);
  const b = text.indexOf(BLOCK_END, a);
  const next = a >= 0 && b > a
    ? text.slice(0, a) + block + text.slice(b + BLOCK_END.length)
    : text + (text && !text.endsWith('\n') ? '\n' : '') + (text ? '\n' : '') + block + '\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
}

function shellRegistry(opts: RegisterOptions, fn: string, args: string[]): boolean {
  const lib = path.join(opts.checkout, 'bin', 'gstack-install-registry.sh');
  const r = spawnSync('bash', ['-c', '. "$0" && ' + fn + ' "$@"', lib, ...args],
    { env: { ...process.env, ...opts.env, GSTACK_STATE_ROOT: opts.stateRoot }, encoding: 'utf8', timeout: 30_000 });
  return r.status === 0;
}

export function register(opts: RegisterOptions): RegisterResult {
  const t = opts.target;
  if (t.mechanism === 'verify-only' || t.mechanism === 'skill-pack-api') throw new HarnessError('HARNESS_UNKNOWN_TARGET', t.name + ' is not registered through files (use status for ' + t.name + ', or lib/harness-qm.ts for qm)');
  const mode = opts.mode ?? t.defaultMode;
  if (!t.modes.includes(mode)) throw new HarnessError('HARNESS_MODE_UNSUPPORTED', t.displayName + ' does not support --skills ' + mode);
  if (ROUTER_DESCRIPTION.length > ROUTER_DESCRIPTION_MAX) throw new HarnessError('HARNESS_BUDGET_EXCEEDED', 'router description is ' + ROUTER_DESCRIPTION.length + ' bytes');
  const provisional = opts.skillsDir ? path.resolve(opts.skillsDir) : t.dest(opts.env, opts.home) ?? (opts.context ? path.resolve(opts.context) : null);
  if (!provisional) throw new HarnessError('HARNESS_NO_DESTINATION', t.displayName + ' has no default skills folder');
  const id = registrationId(t.name, provisional);
  const dest = resolveDest(opts, id)!;
  assertSafeDest(dest, opts);
  if (opts.context) assertSafeDest(path.resolve(opts.context), opts);
  const lfile = ledgerPath(opts.stateRoot, id);
  const prev = readLedger(lfile);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-harness-'));
  try {
    const { files, router, skills } = planPayload(opts, dest, mode, scratch);
    const prevFiles = new Map((prev?.files ?? []).map(f => [f.path, f.sha]));
    const topOf = (p: string) => path.join(dest, path.relative(dest, p).split(path.sep)[0]);
    const owned = new Set([...prevFiles.keys()].map(topOf));
    for (const top of new Set([...files.keys()].map(topOf))) {
      let st: fs.Stats;
      try { st = fs.lstatSync(top); } catch { continue; }
      if (st.isSymbolicLink()) throw new HarnessError('HARNESS_UNSAFE_DESTINATION', top + ' is a symlink');
      if (!owned.has(top)) throw new HarnessError('HARNESS_UNOWNED_ENTRY', top + ' already exists and gstack did not write it');
    }
    const want = [...files].map(([p, b]) => ({ path: p, sha: sha256(b) }));
    const same = prev && prev.meta.mode === mode && prev.files.length === want.length
      && want.every(w => prevFiles.get(w.path) === w.sha && onDiskSha(w.path) === w.sha);
    const block = opts.context ? contextBlock(router ?? '') : null;
    if (block && block.length > CONTEXT_BLOCK_MAX) throw new HarnessError('HARNESS_BUDGET_EXCEEDED', 'context block is ' + block.length + ' bytes');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let written = 0;
    if (!same) {
      for (const [p, sha] of prevFiles) {
        if (files.has(p)) continue;
        const disk = onDiskSha(p);
        if (disk === sha) fs.rmSync(p, { force: true }); else if (disk) backupFile(p, opts.stateRoot, stamp);
      }
      const dirs = new Set(prev?.dirs ?? []);
      for (const [p, b] of files) {
        const disk = onDiskSha(p);
        const sha = sha256(b);
        if (disk === sha) continue;
        if (disk && prevFiles.get(p) !== disk) backupFile(p, opts.stateRoot, stamp);
        let d = path.dirname(p);
        const made: string[] = [];
        while (!fs.existsSync(d)) { made.push(d); d = path.dirname(d); }
        fs.mkdirSync(path.dirname(p), { recursive: true });
        made.forEach(m => dirs.add(m));
        fs.writeFileSync(p + '.gstack-new', b);
        fs.renameSync(p + '.gstack-new', p);
        written++;
      }
      writeLedger(lfile, {
        meta: { id, target: t.name, dest, mode, checkout: opts.checkout, version: opts.version, ...(router ? { router } : {}), ...(opts.context ? { context: path.resolve(opts.context) } : {}) },
        files: want, dirs: [...dirs].sort((a, b) => b.length - a.length), blocks: opts.context ? [path.resolve(opts.context)] : [],
      });
    }
    if (block) insertBlock(path.resolve(opts.context!), block);
    if (opts.registry && t.render === 'host') shellRegistry(opts, 'gstack_install_registry_upsert', [t.name, 'global', '-', dest, opts.checkout, opts.checkout, opts.version, '-', '-']);
    return { id, target: t.name, dest, mode, status: !prev ? 'installed' : same ? 'unchanged' : 'updated', written, skills, router, ledger: lfile };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** The router and context block for a harness gstack cannot write into (Grok Bot, a chat-only skill library). */
export function printPayload(checkout: string): string {
  const t = TARGETS.generic;
  const skills = sourceSkills(t, checkout, os.tmpdir()).map(s => ({ name: s.name, use: s.use, path: path.join(s.dir, 'SKILL.md') }));
  return [routerSkill(skills, t), contextBlock(path.join(checkout, 'SKILL.md'))].join('\n');
}

/** Remove one registration through the bash ledger reader (the same code gstack-uninstall runs). */
export function unregister(stateRoot: string, checkout: string, idOrTarget: string, env: Env = process.env): string[] {
  const all = listLedgers(stateRoot).filter(l => l.ledger.meta.id === idOrTarget || l.ledger.meta.target === idOrTarget);
  if (!all.length) throw new HarnessError('HARNESS_NOT_REGISTERED', 'no registration named ' + JSON.stringify(idOrTarget));
  for (const { file } of all) {
    const r = spawnSync('bash', ['-c', '. "$0" && gstack_harness_unregister_ledger "$1"', path.join(checkout, 'bin', 'gstack-harness-ledger.sh'), file],
      { env: { ...process.env, ...env, GSTACK_STATE_ROOT: stateRoot }, encoding: 'utf8', timeout: 60_000 });
    if (r.status !== 0) throw new HarnessError('HARNESS_NOT_REGISTERED', 'could not remove ' + file + ': ' + (r.stderr || '').trim());
  }
  return all.map(l => l.ledger.meta.id);
}

/** Re-register every file registration this checkout made (setup runs it on every pass, so upgrades refresh them). */
export function refresh(base: Omit<RegisterOptions, 'target'>): RegisterResult[] {
  return listLedgers(base.stateRoot)
    .filter(({ ledger: l }) => l.meta.checkout === base.checkout && l.meta.target !== 'qm')
    .map(({ ledger: l }) => register({
      ...base, target: getTarget(l.meta.target), mode: l.meta.mode as SkillsMode,
      skillsDir: l.meta.context && l.meta.dest.startsWith(ledgerDir(base.stateRoot)) ? undefined : l.meta.dest,
      context: l.meta.context || undefined,
    }));
}

export interface StatusRow { id: string; target: string; dest: string; mode: string; files: number; version: string; stale: boolean; visible: 'yes' | 'no' | 'unknown'; checked?: string }

export function harnessSees(t: Target, dest: string, env: Env): { visible: 'yes' | 'no' | 'unknown'; checked?: string } {
  const lc = t.listCommand?.(dest);
  if (!lc || !onPath(lc.argv[0], env)) return { visible: 'unknown' };
  const r = spawnSync(lc.argv[0], lc.argv.slice(1), { env: { ...process.env, ...env, ...lc.env }, encoding: 'utf8', timeout: 60_000 });
  return { visible: lc.expect.test((r.stdout ?? '') + (r.stderr ?? '')) ? 'yes' : 'no', checked: lc.argv.join(' ') };
}

export function status(stateRoot: string, version: string, env: Env, check = true): StatusRow[] {
  return listLedgers(stateRoot).map(({ ledger: l }) => {
    const t = (TARGETS as Record<string, Target>)[l.meta.target];
    const seen = check && t ? harnessSees(t, l.meta.dest, env) : { visible: 'unknown' as const };
    return { id: l.meta.id, target: l.meta.target, dest: l.meta.dest, mode: l.meta.mode, files: l.files.length, version: l.meta.version, stale: l.meta.version !== version, ...seen };
  });
}
