/**
 * pregate/environment — tells a failure the machine caused from one the diff
 * caused (Lane D, GSTA-112; truther #617). A check that could not run its
 * command (a runner or guard binary missing from PATH, a network error or a
 * quota refusal before any test ran, a full disk) is `incomplete` under
 * PREGATE_ENVIRONMENT with `cause: 'environment'`, a kind and the line that
 * proves it, so a lane waives by cause and a reader never mistakes it for the
 * branch's fault. The classifier reads a command's output and exit code only;
 * the caller decides when to ask it: a local lane whose runner printed a test
 * summary is the diff's failure whatever its log says, and only a run with no
 * summary (nothing ran) is classified from its output.
 */
import type { CheckResult, EnvironmentCause, EnvironmentKind } from './types';

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
/** The shell's own "no such command" text (POSIX and cmd.exe); exit 127 says the same without text. */
const NOT_FOUND = /command not found|is not recognized as an internal or external command/;
const RULES: Array<{ kind: EnvironmentKind; re: RegExp }> = [
  { kind: 'missing-binary', re: new RegExp(`${NOT_FOUND.source}|No such file or directory: ['"]?[\\w./-]+|spawn \\S+ ENOENT|\\bENOENT\\b.*\\bspawn\\b|not on PATH`) },
  { kind: 'quota', re: /\bquota\b|\b429 Too Many Requests|status(?: code)?[:= ]+429\b|HTTP(?:\/[\d.]+)? 429\b|\brate.?limit(?:ed)?\b|insufficient_quota/i },
  { kind: 'network', re: /\bE(?:NOTFOUND|CONNREFUSED|CONNRESET|TIMEDOUT|HOSTUNREACH|NETUNREACH|AI_AGAIN|PIPE)\b|getaddrinfo|Could not resolve host|Connection refused|Connection reset|Network is unreachable|fetch failed|TLS handshake|certificate verify failed|UNABLE_TO_GET_ISSUER_CERT|Temporary failure in name resolution/ },
  { kind: 'disk', re: /\bENOSPC\b|No space left on device|\bEDQUOT\b|Disk quota exceeded/ },
];

/** The first line (trimmed, capped) of ANSI-free `text` that matches `re`, else its first line. */
function evidenceLine(text: string, re: RegExp): string {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  return (lines.find(l => re.test(l)) ?? lines[0] ?? '').replace(/^(?:Error|error|ERROR):\s*/, '').slice(0, 200);
}

/**
 * The environment cause a command's output and exit code show, or null for an
 * ordinary failure. Exit 127 (the shell found no such command) is
 * missing-binary with or without text; a disk rule outranks quota (EDQUOT is a
 * disk quota); otherwise the first rule in order whose text appears wins.
 */
export function classifyEnvironment(output: string, exit: number | null): EnvironmentCause | null {
  const text = output.replace(ANSI, '');
  if (exit === 127 || NOT_FOUND.test(text)) return { kind: 'missing-binary', evidence: evidenceLine(text, RULES[0]!.re) || 'exit 127: the shell found no such command' };
  const disk = RULES.find(r => r.kind === 'disk')!;
  if (disk.re.test(text)) return { kind: 'disk', evidence: evidenceLine(text, disk.re) };
  for (const rule of RULES) if (rule.kind !== 'disk' && rule.re.test(text)) return { kind: rule.kind, evidence: evidenceLine(text, rule.re) };
  return null;
}

const FIX: Record<EnvironmentKind, string> = {
  'missing-binary': 'install the named tool on this machine (or put it on PATH), or run the lane remotely (--remote, or clear it with a run URL); the diff is not at fault',
  network: 'check the network, proxy or registry this machine reaches, then rerun; or run the lane remotely; the diff is not at fault',
  quota: 'wait for the quota or raise it, free the backend\'s capacity, then rerun; the diff is not at fault',
  disk: 'free disk space (or move the state root) and rerun; the diff is not at fault',
  runtime: 'repair the runtime the line names (the install verdict or the pinned Bun), then rerun; the diff is not at fault',
  tool: 'repair or reinstall the named gstack tool, then rerun; the diff is not at fault',
};

/** An `incomplete` result under PREGATE_ENVIRONMENT: cause, kind, evidence, an `environment:` line and the kind's fix. */
export function environmentResult(base: CheckResult, cause: EnvironmentCause, detail: string): CheckResult {
  return { ...base, status: 'incomplete', code: 'PREGATE_ENVIRONMENT', cause: 'environment', environment: cause, detail, fix: FIX[cause.kind], lines: [...(base.lines ?? []), environmentLine(cause)] };
}

export const environmentLine = (cause: EnvironmentCause) => `environment: ${cause.kind} — ${cause.evidence}`;
