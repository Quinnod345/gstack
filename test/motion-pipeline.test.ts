/**
 * /design-motion capture -> check -> export, end to end on real Chromium and
 * real ffmpeg (bin/gstack-motion-capture.ts feeding bin/gstack-motion-encode).
 * The unit tests pin the argument lists and the PSNR parser on synthetic
 * lines; this file proves the two bins agree on the capture directory
 * (frame names from the window start, capture.json, still.png and mask.png at
 * the frame scale) and that the checks judge real ffmpeg output both ways.
 * The fixture page is a 0.5 s loop at 640x100 (captured 1920x300), so a run is
 * 54 frames. Self-skips when the Playwright Chromium bundle, ffmpeg or ffprobe
 * is missing.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { chromium } from 'playwright';
import { clockMs, stepMs } from '../lib/motion-capture';
import { resolveFfmpeg, type CaptureManifest } from '../lib/motion-encode';

const ROOT = path.resolve(import.meta.dir, '..');
const CAPTURE = path.join(ROOT, 'bin', 'gstack-motion-capture.ts');
const ENCODE = path.join(ROOT, 'bin', 'gstack-motion-encode');
const CHROMIUM = process.env.GSTACK_CHROMIUM_PATH || (() => { try { return chromium.executablePath(); } catch { return ''; } })();
const FFMPEG = resolveFfmpeg(process.env, bin => Bun.which(bin), p => fs.existsSync(p));
const FFPROBE = Bun.which('ffprobe');
const READY = Boolean(CHROMIUM) && fs.existsSync(CHROMIUM) && Boolean(FFMPEG) && Boolean(FFPROBE) && process.platform !== 'win32';
const PHASES = ['--intro-end', '0.1', '--dissolve-at', '0.3', '--empty-from', '0.4', '--layout', 'cards'];

function page(o: { loops: boolean; contract?: boolean }): string {
  const contract = o.contract === false ? '' : `
  window.__lt = 0;
  window.__start = () => { window.__lt = 0; paint(0); };
  window.__tick = dt => { window.__lt = ${o.loops ? '(window.__lt + dt) % 0.5' : 'window.__lt + dt'}; paint(window.__lt); };`;
  return `<!doctype html><html><head><style>
html, body { margin: 0; background: #f4f1ea; }
.card { position: absolute; left: 40px; top: 20px; width: 400px; height: 60px; background: #fff; border-radius: 8px; overflow: hidden; }
.bar { position: absolute; left: 0; top: 20px; width: 80px; height: 20px; background: #2a6f4f; }
</style></head><body><section class="card"><div class="bar"></div></section><script>
const card = document.querySelector('.card');
const bar = document.querySelector('.bar');
function paint(lt) {
  card.style.visibility = lt >= 0.05 && ${o.loops ? 'lt < 0.3' : 'true'} ? 'visible' : 'hidden';
  bar.style.transform = 'translateX(' + Math.round(Math.min(1, Math.max(0, (lt - 0.05) / 0.1)) * 300) + 'px)';
}
if (location.search.slice(1).split('&').includes('still')) paint(0.25);
else { paint(0);${contract} }
</script></body></html>
`;
}

function run(argv: string[]) {
  const r = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe', timeout: 150_000, env: process.env });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function capture(dir: string, html: string, o: { mask?: boolean } = {}) {
  const file = path.join(dir, 'page.html');
  fs.writeFileSync(file, html);
  return run([CAPTURE, file, '--size', '640x100', '--cycle', '0.5', '--out', path.join(dir, 'cap'), ...(o.mask === false ? [] : ['--mask', '.card'])]);
}

describe.skipIf(!READY)('design-motion pipeline on real Chromium and ffmpeg', () => {
  // Value: protects=a looping page captures 54 frames whose manifest, still and mask the encoder accepts, checks clean and exports a one-cycle MP4;
  //   fails_when=frame naming, start frame, tick units, still/mask scale or the export window drift between the two bins; why_new=only the paid marathon case runs both bins;
  //   seam=none; no_claim=a 0.5 s synthetic loop stands in for an agent-built page; GIF quality and X upload acceptance are not checked
  test('a looping page captures, checks clean and exports one cycle', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-pipeline-'));
    try {
      const cap = path.join(dir, 'cap');
      const c = capture(dir, page({ loops: true }));
      expect(c.code, c.err).toBe(0);
      expect(c.out.trim().split('\n').pop()).toBe(`CAPTURE_OK frames=54 window=14+30 scale=3.0000 dir=${cap}`);
      expect(fs.readdirSync(path.join(cap, 'frames')).sort()).toEqual(Array.from({ length: 54 }, (_, i) => `${String(i).padStart(5, '0')}.png`));
      expect(fs.existsSync(path.join(cap, 'still.png')) && fs.existsSync(path.join(cap, 'mask.png'))).toBe(true);
      const m = JSON.parse(fs.readFileSync(path.join(cap, 'capture.json'), 'utf-8')) as CaptureManifest;
      expect([m.scale, m.windowStart, m.windowFrames, m.frames, m.mask]).toEqual([3, 14, 30, 54, 'mask.png']);
      expect(m.loopTime.length).toBe(54);
      expect(m.loopTime.slice(0, 15).every(t => t === 0)).toBe(true);
      expect(m.loopTime[15]).toBeCloseTo(stepMs(15) / 1000, 9);
      for (let i = 15; i < 44; i++) expect(m.loopTime[i]!).toBeCloseTo(clockMs(i, 15) / 1000, 6);

      const check = run([ENCODE, 'check', cap, ...PHASES]);
      expect(check.code, check.out + check.err).toBe(0);
      for (const id of ['seam', 'empty-beat', 'rest', 'overflow']) expect(check.out).toContain(`MOTION_CHECK: ${id} pass`);
      expect(check.out).toContain(`CONTACT_SHEET ${path.join(cap, 'contact-sheet.png')}`);
      expect(check.out.trim().split('\n').pop()).toBe('MOTION_RESULT: clean');

      const exp = run([ENCODE, 'export', cap, '--name', 'pipe', '--formats', 'mp4,800', '--pad', '#f4f1ea']);
      expect(exp.code, exp.out + exp.err).toBe(0);
      expect(exp.out).toContain(`EXPORT_OK ${path.join(cap, 'pipe-x.mp4')}`);
      expect(exp.out).toContain(`EXPORT_OK ${path.join(cap, 'pipe-800x500.gif')}`);
      const probe = run([FFPROBE!, '-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=width,height,nb_read_frames', '-of', 'csv=p=0', path.join(cap, 'pipe-x.mp4')]);
      expect(probe.out.trim()).toBe('1920,300,30');

      const same = run([ENCODE, 'compare', path.join(cap, 'still.png'), path.join(cap, 'still.png')]);
      expect(same.code).toBe(0);
      expect(same.out).toStartWith('PSNR inf dB');
      const sizes = run([ENCODE, 'compare', path.join(cap, 'still.png'), path.join(cap, 'contact-sheet.png')]);
      expect(sizes.code).toBe(1);
      expect(sizes.err).toContain('COMPARE_FAILED');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);

  // Value: protects=a page that never returns to its empty state fails the seam and empty-beat checks on real ffmpeg output and exits 1;
  //   fails_when=finite psnr_avg lines stop parsing or a failed job stops counting toward MOTION_RESULT; why_new=unit verdicts use hand-written stats lines; seam=none;
  //   no_claim=only the seam/empty-beat failure class; a rest or overflow failure is not reproduced here
  test('a page that does not loop fails the seam and the empty beat', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-pipeline-'));
    try {
      const c = capture(dir, page({ loops: false }));
      expect(c.code, c.err).toBe(0);
      const check = run([ENCODE, 'check', path.join(dir, 'cap'), ...PHASES]);
      expect(check.code).toBe(1);
      expect(check.out).toMatch(/MOTION_CHECK: seam fail 1 frame\(s\) differ, worst \d+\.\d\d dB at compared frame \d+ \(frame 14 vs 44\)/);
      expect(check.out).toMatch(/MOTION_CHECK: empty-beat fail \d+ frame\(s\) differ/);
      expect(check.out).toContain('MOTION_CHECK: rest pass');
      expect(check.out).toContain('MOTION_CHECK: overflow pass');
      expect(check.out.trim().split('\n').pop()).toBe('MOTION_RESULT: 2 failed');
      const relaxed = run([ENCODE, 'check', path.join(dir, 'cap'), ...PHASES, '--min-db', '0']);
      expect(relaxed.code, relaxed.out + relaxed.err).toBe(0);
      expect(relaxed.out).toMatch(/^MOTION_SETTINGS: .*--min-db 0; defaults otherwise$/m);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);

  // Value: protects=a page without window.__start/__tick stops with MOTION_CONTRACT_MISSING and exit 1 before writing capture.json;
  //   fails_when=the contract probe is dropped and frames of an unanimated page are recorded as a capture; why_new=no test loads a page in the capture bin; seam=none;
  //   no_claim=only the missing-contract case; a contract that throws mid-capture is not exercised
  //   The same --out also checks ownership: a foreign still.png is refused and kept, the retry after a refused page succeeds
  //   (here without a mask, so check ends 'clean (overflow not checked)'), and a later failed capture clears that manifest.
  test('a page without the capture contract is refused', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-pipeline-'));
    try {
      const cap = path.join(dir, 'cap');
      fs.mkdirSync(cap);
      fs.writeFileSync(path.join(cap, 'still.png'), 'not ours');
      const foreign = capture(dir, page({ loops: true, contract: false }));
      expect(foreign.code).toBe(2);
      expect(foreign.err).toContain('already holds still.png but no .gstack-motion-capture marker');
      expect(fs.readFileSync(path.join(cap, 'still.png'), 'utf-8')).toBe('not ours');
      fs.rmSync(path.join(cap, 'still.png'));

      const c = capture(dir, page({ loops: true, contract: false }));
      expect(c.code).toBe(1);
      expect(c.err).toContain('MOTION_CONTRACT_MISSING');
      const retry = capture(dir, page({ loops: true }), { mask: false });
      expect(retry.code, retry.err).toBe(0);
      expect(retry.out).toContain('CAPTURE_OK frames=54');
      const check = run([ENCODE, 'check', cap, ...PHASES]);
      expect(check.code, check.out + check.err).toBe(0);
      expect(check.out).toContain('MOTION_CHECK: overflow skipped');
      expect(check.out.trim().split('\n').pop()).toBe('MOTION_RESULT: clean (overflow not checked)');

      expect(capture(dir, page({ loops: true, contract: false })).code).toBe(1);
      expect(fs.existsSync(path.join(cap, 'capture.json')) || fs.existsSync(path.join(cap, 'still.png'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);

  // Value: protects=an offscreen loading=lazy image no longer hangs the still render (img.decode() never settles on it);
  //   fails_when=the eager switch and the 30 s bound are both dropped and --still waits forever; why_new=adversarial probe hung at 90 s; seam=none;
  //   no_claim=one lazy image on a local page; a slow network image is bounded only by the 30 s timer
  test('a page with an offscreen lazy image renders its still', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-pipeline-'));
    try {
      fs.writeFileSync(path.join(dir, 'dot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
      const file = path.join(dir, 'lazy.html');
      fs.writeFileSync(file, '<!doctype html><body style="margin:0"><div style="height:5000px"></div><img loading="lazy" src="dot.png" width="4" height="4"></body>');
      const still = run([CAPTURE, file, '--size', '640x100', '--still', path.join(dir, 'still.png')]);
      expect(still.code, still.err).toBe(0);
      expect(still.err).not.toContain('still loading');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 200_000);
});
