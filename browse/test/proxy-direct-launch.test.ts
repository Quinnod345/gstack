/**
 * #3440 item 8: a session browse resolves to direct launches Chromium with
 * `--proxy-server=direct://`, so the proxy variables Chromium reads on its
 * own (HTTPS_PROXY, HTTP_PROXY, ALL_PROXY) never win silently. Two logging
 * CONNECT proxies on loopback stand in for the environment's proxy and a
 * configured one; a name that does not resolve is the target, so a CONNECT at
 * a proxy is the only way the navigation can get past DNS.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

const CLI = path.resolve(import.meta.dir, '../src/cli.ts');
const TARGET = 'proxied.gstack-3440.test';

let scratch = '';
let stateFile = '';
let daemonLog = '';
const proxies: Array<{ server: http.Server; url: string; connects: string[] }> = [];

async function connectProxy() {
  const connects: string[] = [];
  const server = http.createServer((_req, res) => { res.writeHead(502); res.end(); });
  server.on('connect', (req, socket) => {
    connects.push(req.url ?? '');
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const entry = { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, connects };
  proxies.push(entry);
  return entry;
}

beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-proxy-direct-'));
  stateFile = path.join(scratch, 'state', 'browse.json');
  daemonLog = path.join(scratch, 'state', 'browse-daemon.log');
});

// stop works whatever the proxy settings are, so a failed case never leaves
// its daemon behind for the next one to be refused by.
afterEach(async () => { await browse(['stop'], {}); });

afterAll(async () => {
  if (fs.existsSync(stateFile)) {
    try { process.kill(JSON.parse(fs.readFileSync(stateFile, 'utf8')).pid, 'SIGKILL'); } catch {}
  }
  for (const { server } of proxies) await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(scratch, { recursive: true, force: true });
});

async function browse(args: string[], extraEnv: Record<string, string>) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(BROWSE_|GSTACK_|NO_PROXY$|no_proxy$|HTTPS?_PROXY$|https?_proxy$|ALL_PROXY$|all_proxy$)/.test(key)) env[key] = value;
  }
  Object.assign(env, {
    HOME: scratch,
    GSTACK_HOME: path.join(scratch, '.gstack'),
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), ...(process.platform === 'darwin' ? ['Library', 'Caches'] : ['.cache']), 'ms-playwright'),
    BROWSE_STATE_FILE: stateFile,
    BROWSE_PARENT_PID: '0',
  }, extraEnv);
  const cli = Bun.spawn([process.execPath, CLI, ...args], { cwd: scratch, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => cli.kill('SIGKILL'), 60_000);
  const [code, stdout, stderr] = await Promise.all([cli.exited, new Response(cli.stdout).text(), new Response(cli.stderr).text()]);
  clearTimeout(timer);
  return { code, stdout, stderr, out: stdout + stderr };
}

const readDaemonLog = () => fs.existsSync(daemonLog) ? fs.readFileSync(daemonLog, 'utf8') : '';

describe.skipIf(process.platform === 'win32')('#3440 item 8: direct mode never lets Chromium pick a proxy from the environment', () => {
  test('BROWSE_PROXY_URL=direct with HTTPS_PROXY set: no CONNECT reaches the proxy, and the daemon names what it ignored', async () => {
    const envProxy = await connectProxy();
    const env = { HTTPS_PROXY: envProxy.url, BROWSE_PROXY_URL: 'direct' };
    const r = await browse(['goto', `https://${TARGET}/`], env);
    expect(r.stderr).toContain('Starting server...');
    expect(r.stderr).not.toContain('Starting server with proxy');
    expect(r.out).toContain('ERR_NAME_NOT_RESOLVED');
    expect(r.out).not.toContain('ERR_TUNNEL_CONNECTION_FAILED');
    expect(envProxy.connects).toEqual([]);
    expect(readDaemonLog()).toContain('[browse] [proxy] none: direct connection (--proxy-server=direct://; ignoring HTTPS_PROXY)');
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).proxy).toBeUndefined();
  }, 120_000);

  test('control: the same HTTPS_PROXY without the opt-out is the configured proxy, and the CONNECT reaches it', async () => {
    const envProxy = await connectProxy();
    const env = { HTTPS_PROXY: envProxy.url };
    const r = await browse(['goto', `https://${TARGET}/`], env);
    expect(r.stderr).toContain(`Starting server with proxy ${envProxy.url}/ from HTTPS_PROXY...`);
    expect(r.out).toContain('ERR_TUNNEL_CONNECTION_FAILED');
    expect(envProxy.connects).toEqual([`${TARGET}:443`]);
    expect(readDaemonLog()).toContain(`[browse] [proxy] using ${envProxy.url}/ from HTTPS_PROXY (pass-through to Chromium)`);
  }, 120_000);

  test('control: --proxy beats HTTPS_PROXY explicitly, so only the configured proxy sees the CONNECT', async () => {
    const envProxy = await connectProxy();
    const configured = await connectProxy();
    const env = { HTTPS_PROXY: envProxy.url };
    const r = await browse(['--proxy', configured.url, 'goto', `https://${TARGET}/`], env);
    expect(r.stderr).toContain(`Starting server with proxy ${configured.url}/ from --proxy...`);
    expect(r.out).toContain('ERR_TUNNEL_CONNECTION_FAILED');
    expect(configured.connects).toEqual([`${TARGET}:443`]);
    expect(envProxy.connects).toEqual([]);
  }, 120_000);
});
