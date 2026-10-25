import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { builtinModules } from 'module';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runBashScript } from './helpers/bash-script';

// ./setup installs production dependencies only (GSTA-97). devDependencies are
// the test and eval toolchain, chiefly the Claude Agent SDK's per-platform
// native binaries (~440 MB on Linux). This file pins the two halves of that:
// every install setup runs passes --production (contributors and CI install
// the full set themselves), and nothing setup, the build or an installed skill
// loads is a devDependency.

const ROOT = path.resolve(import.meta.dir, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
const PKG = JSON.parse(read('package.json'));
const bases: string[] = [];
afterEach(() => { for (const b of bases.splice(0)) fs.rmSync(b, { recursive: true, force: true }); });

function tempBase(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-prod-deps-'));
  bases.push(base);
  return base;
}

/** A bash function sliced out of a script, by its `name() {` line through the closing `}`. */
function sliceFunction(source: string, name: string): string {
  const start = source.indexOf(`\n${name}() {\n`);
  if (start === -1) throw new Error(`${name}() not found`);
  const end = source.indexOf('\n}\n', start);
  return source.slice(start + 1, end + 3);
}

/** A bun that records each argv line; `install` with --frozen-lockfile exits $FROZEN_RC. */
function stubBun(base: string): { bun: string; calls: () => string[] } {
  const log = path.join(base, 'calls');
  const bun = path.join(base, 'bun');
  fs.writeFileSync(bun, `#!/usr/bin/env bash\necho "$*" >> ${JSON.stringify(log)}\ncase "$*" in *--frozen-lockfile*) exit "\${FROZEN_RC:-0}" ;; esac\nexit 0\n`, { mode: 0o755 });
  return { bun, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf-8').trim().split('\n') : []) };
}

describe.skipIf(process.platform === 'win32')('setup installs production dependencies only', () => {
  const setup = read('setup');
  const script = (bun: string, call: string) =>
    `set -e\nBUN_CMD=${JSON.stringify(bun)}\n${sliceFunction(setup, 'bun_cmd')}\n${sliceFunction(setup, 'install_runtime_deps')}\n${call}\n`;

  test('install_runtime_deps passes --production with the frozen lockfile, and keeps it on the fallback', () => {
    const base = tempBase();
    const { bun, calls } = stubBun(base);
    expect(runBashScript(script(bun, 'install_runtime_deps'), { env: { ...process.env, FROZEN_RC: '0' } }).status).toBe(0);
    expect(calls()).toEqual(['install --production --frozen-lockfile']);

    const base2 = tempBase();
    const stub2 = stubBun(base2);
    expect(runBashScript(script(stub2.bun, 'install_runtime_deps'), { env: { ...process.env, FROZEN_RC: '1' } }).status).toBe(0);
    expect(stub2.calls()).toEqual(['install --production --frozen-lockfile', 'install --production']);
  });

  test('every bun install in setup goes through install_runtime_deps', () => {
    const body = setup.replace(sliceFunction(setup, 'install_runtime_deps'), '');
    const direct = body.split('\n').filter((l) => /\b(bun_cmd|"\$BUN_CMD"|bun)\s+install\b/.test(l) && !l.trim().startsWith('#'));
    expect(direct).toEqual([]);
    // The build, the Codex render and each host render install first.
    expect(setup.match(/^\s+install_runtime_deps$/gm)?.length).toBeGreaterThanOrEqual(7);
    // Negative control: the pre-GSTA-97 line is caught by the same filter.
    expect(/\b(bun_cmd|"\$BUN_CMD"|bun)\s+install\b/.test('    bun_cmd install --frozen-lockfile 2>/dev/null || bun_cmd install')).toBe(true);
  });

  test('gstack-browser-ensure installs production dependencies too', () => {
    const line = read('bin/gstack-browser-ensure').split('\n').find((l) => /bun install/.test(l) && !l.trim().startsWith('#') && !/log /.test(l))!;
    expect(line).toContain('bun install --production --frozen-lockfile');
    expect(line).toContain('|| bun install --production >/dev/null');
  });

  test('bin/dev-setup installs the full set even over a production-only node_modules', () => {
    const devSetup = read('bin/dev-setup');
    const start = devSetup.indexOf('# 2. Install dependencies');
    const block = devSetup.slice(start, devSetup.indexOf('# 3.', start));
    const base = tempBase();
    const { bun, calls } = stubBun(base);
    fs.mkdirSync(path.join(base, 'node_modules'));
    const r = runBashScript(`set -e\nREPO_ROOT=${JSON.stringify(base)}\nbun() { ${JSON.stringify(bun)} "$@"; }\n${block}`);
    expect(r.status).toBe(0);
    expect(calls()).toEqual(['install']);
  });
});

/** Bare package names a source file loads (import/require/dynamic import), type-only imports excluded. */
export function importedPackages(text: string): string[] {
  const out = new Set<string>();
  const patterns = [
    /^\s*import\s+(?!type\b)[^'"\n]*?from\s+['"]([^'"]+)['"]/gm,
    /^\s*import\s+['"]([^'"]+)['"]/gm,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const spec = m[1];
      if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:') || spec === 'bun' || spec.startsWith('bun:')) continue;
      const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (builtinModules.includes(name)) continue;
      out.add(name);
    }
  }
  return [...out];
}

/** Every shipped-runtime file that loads a package which is not a production dependency. */
export function nonProductionImports(pkg: { dependencies?: Record<string, string> }, files: Record<string, string>): string[] {
  const deps = pkg.dependencies ?? {};
  const bad: string[] = [];
  for (const [file, text] of Object.entries(files)) {
    for (const name of importedPackages(text)) if (!(name in deps)) bad.push(`${file}: ${name}`);
  }
  return bad.sort();
}

/** The code setup, the build and installed skills run: shipped dirs plus the scripts setup and the build call by path. */
function runtimeFiles(): Record<string, string> {
  const roots = ['bin/', 'lib/', 'browse/src/', 'design/src/', 'make-pdf/src/', 'hosts/', 'extension/', 'scripts/resolvers/'];
  const tracked = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf-8', timeout: 30_000 }).stdout
    .split('\n').filter((rel) => roots.some((r) => rel.startsWith(r)));
  const ownPackage = (rel: string) => rel.startsWith('lib/diagram-render/');
  const invoked = new Set(['scripts/gen-skill-docs.ts']);
  for (const src of ['setup', 'scripts/build.sh']) for (const m of read(src).matchAll(/scripts\/[A-Za-z0-9_./-]+\.ts/g)) invoked.add(m[0]);
  const files: Record<string, string> = {};
  for (const rel of [...tracked, ...invoked]) {
    if (ownPackage(rel) || /(^|\/)(test|node_modules|dist)\//.test(rel) || /\.(test\.ts|md|json|png|svg|css|html|c|h)$/.test(rel)) continue;
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile() || fs.statSync(abs).size > 2_000_000) continue;
    const text = fs.readFileSync(abs, 'utf-8');
    if (text.includes('\u0000')) continue;
    files[rel] = text;
  }
  return files;
}

describe('setup and runtime need only production dependencies', () => {
  test('no shipped code loads a devDependency or an undeclared package', () => {
    const files = runtimeFiles();
    expect(Object.keys(files).length).toBeGreaterThan(300);
    expect(nonProductionImports(PKG, files)).toEqual([]);
  });

  test('negative controls: a devDependency import and a moved-back runtime package are caught', () => {
    expect(nonProductionImports(PKG, { 'bin/x': "import { query } from '@anthropic-ai/claude-agent-sdk';" })).toEqual(['bin/x: @anthropic-ai/claude-agent-sdk']);
    expect(nonProductionImports(PKG, { 'bin/x': "import type { Q } from '@anthropic-ai/claude-agent-sdk';\nimport fs from 'node:fs';" })).toEqual([]);
    const { ['@anthropic-ai/sdk']: _sdk, ...rest } = PKG.dependencies;
    const files = runtimeFiles();
    expect(nonProductionImports({ dependencies: rest }, files)).toContain('bin/gstack-distill-free-text: @anthropic-ai/sdk');
  });

  test('packages the build copies out of node_modules are production dependencies', () => {
    const scripts: Record<string, string> = PKG.scripts;
    const run = [...read('scripts/build.sh').matchAll(/"\$BUN_CMD" run ([A-Za-z0-9:_-]+)/g)].map((m) => m[1]);
    expect(run).toContain('vendor:xterm');
    const copied = run.flatMap((name) => [...(scripts[name] ?? '').matchAll(/node_modules\/((?:@[^/\s]+\/)?[^/\s]+)\//g)].map((m) => m[1]));
    expect(copied.sort()).toEqual(['xterm', 'xterm', 'xterm-addon-fit']);
    for (const name of copied) expect(PKG.dependencies).toHaveProperty([name]);
  });

  test('the dev toolchain stays out of the user install', () => {
    for (const name of ['@anthropic-ai/claude-agent-sdk', 'typescript', 'prettier', '@types/bun']) {
      expect(PKG.devDependencies).toHaveProperty([name]);
      expect(PKG.dependencies).not.toHaveProperty([name]);
    }
  });
});
