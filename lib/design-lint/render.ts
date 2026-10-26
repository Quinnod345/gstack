/**
 * The render tier: what only a browser can measure. Drives the same engine
 * gstack-render picks (Aside when it is running, otherwise gstack's own
 * headless browser) through lib/aside-render, so nothing is installed and no
 * puppeteer is needed.
 *
 * Ported from Nutlope/hallmark's sloplint-render.mjs (MIT, see NOTICE.md).
 */
import type { Finding } from './report';

export interface RenderOptions {
  cwd?: string;
  job?: string | null;
  scope?: 'page' | 'component';
  timeoutMs?: number;
}

export interface RenderResult {
  findings: Finding[];
  /** 'ran', or 'skipped: <reason>' naming why no page was measured. */
  status: string;
}

export async function lintRender(targets: string[], _opts: RenderOptions = {}): Promise<RenderResult> {
  if (!targets.length) return { findings: [], status: 'skipped: no HTML page to render' };
  return { findings: [], status: 'skipped: render tier not built yet' };
}
