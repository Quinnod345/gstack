/**
 * changelog-check — CHANGELOG re-heading and checks for gstack-restamp (C2)
 * and the tree receipt (C3). A restamp moves the PR's section (`[Unreleased]`
 * or the version currently stamped on the branch) to the top under the new
 * version, above its predecessor's entry. Duplicate version headings and a
 * top entry that is not VERSION are errors. The tree receipt uses
 * `normalizeChangelog` to accept a heading move as a stamp, never a change.
 */
import type { ResultCodeName } from './result-codes';

export interface ChangelogSection {
  /** The heading line as written. */
  heading: string;
  version: string | null;
  unreleased: boolean;
  /** Line offsets into the file (heading inclusive, end exclusive). */
  start: number;
  end: number;
  lines: string[];
}
export interface ParsedChangelog { header: string[]; sections: ChangelogSection[] }
export interface ChangelogError { code: ResultCodeName; path: string; message: string }

const HEADING_RE = /^##\s+(\[)?(?:v)?(\d+(?:\.\d+){1,3}|Unreleased|unreleased)\]?(?:\s*[-–—]\s*(\S.*))?\s*$/;

export function headingVersion(line: string): { version: string | null; unreleased: boolean } | null {
  const m = HEADING_RE.exec(line);
  if (!m) return null;
  const token = m[2]!;
  if (token.toLowerCase() === 'unreleased') return { version: null, unreleased: true };
  return { version: token, unreleased: false };
}

export function parseChangelog(text: string): ParsedChangelog {
  const lines = text.split('\n');
  const starts: number[] = [];
  lines.forEach((l, i) => { if (headingVersion(l)) starts.push(i); });
  const header = lines.slice(0, starts[0] ?? lines.length);
  const sections = starts.map((start, k) => {
    const end = starts[k + 1] ?? lines.length;
    const hv = headingVersion(lines[start]!)!;
    return { heading: lines[start]!, version: hv.version, unreleased: hv.unreleased, start, end, lines: lines.slice(start, end) };
  });
  return { header, sections };
}

/** Duplicate headings, and (when `expectedTop` is given) the top entry equals VERSION. */
export function checkChangelog(text: string, expectedTop: string | null, file = 'CHANGELOG.md'): ChangelogError[] {
  const errors: ChangelogError[] = [];
  const parsed = parseChangelog(text);
  const seen = new Map<string, number>();
  for (const s of parsed.sections) {
    const key = s.unreleased ? 'Unreleased' : s.version!;
    if (seen.has(key)) errors.push({ code: 'CHANGELOG_DUPLICATE_HEADING', path: `${file}:${s.start + 1}`, message: `${key} already headed at line ${seen.get(key)! + 1}` });
    else seen.set(key, s.start);
  }
  if (expectedTop) {
    const top = parsed.sections[0];
    if (!top) errors.push({ code: 'CHANGELOG_TOP_MISMATCH', path: file, message: `no entry; expected ${expectedTop} at the top` });
    else if (top.unreleased || top.version !== expectedTop) errors.push({ code: 'CHANGELOG_TOP_MISMATCH', path: `${file}:${top.start + 1}`, message: `top entry is ${top.unreleased ? '[Unreleased]' : top.version}, VERSION is ${expectedTop}` });
  }
  return errors;
}

function renderHeading(like: string, version: string, date: string): string {
  const bracket = /^##\s+\[/.test(like);
  const vPrefix = /^##\s+\[?v\d/.test(like);
  const dash = /\s+[–—]\s+/.exec(like)?.[0]?.trim() ?? '-';
  const token = `${vPrefix ? 'v' : ''}${version}`;
  return `## ${bracket ? `[${token}]` : token} - ${date}`.replace(' - ', ` ${dash} `);
}

export interface ReheadResult { text: string; moved: boolean; from: string; to: string; error?: ChangelogError }

/**
 * Move the PR's section to the top under `to`. `from` is the version the
 * branch currently carries (its own earlier stamp) or null; `[Unreleased]`
 * is taken first. Idempotent: a top section already headed `to` is a no-op.
 */
export function reheadChangelog(text: string, opts: { from: string | null; to: string; date: string; file?: string }): ReheadResult {
  const file = opts.file ?? 'CHANGELOG.md';
  const parsed = parseChangelog(text);
  const already = parsed.sections.find(s => s.version === opts.to);
  if (already && parsed.sections[0] === already) return { text, moved: false, from: opts.to, to: opts.to };
  const unreleased = parsed.sections.find(s => s.unreleased);
  const own = opts.from ? parsed.sections.find(s => s.version === opts.from) : undefined;
  const section = unreleased ?? own ?? already;
  if (!section) {
    return { text, moved: false, from: opts.from ?? 'Unreleased', to: opts.to, error: { code: 'CHANGELOG_SECTION_MISSING', path: file, message: `no [Unreleased]${opts.from ? ` or ${opts.from}` : ''} section` } };
  }
  const dup = parsed.sections.filter(s => s !== section && (s.unreleased ? section.unreleased : s.version === section.version));
  if (dup.length) {
    return { text, moved: false, from: section.unreleased ? 'Unreleased' : section.version!, to: opts.to, error: { code: 'CHANGELOG_DUPLICATE_HEADING', path: `${file}:${dup[0]!.start + 1}`, message: `${section.unreleased ? 'Unreleased' : section.version} is headed twice` } };
  }
  const body = section.lines.slice(1);
  const newHeading = renderHeading(section.heading, opts.to, opts.date);
  const rest = parsed.sections.filter(s => s !== section).flatMap(s => s.lines);
  const header = [...parsed.header];
  while (header.length && header[header.length - 1] === '') header.pop();
  const out = [...header, ...(header.length ? [''] : []), newHeading, ...body];
  const trimmed = [...out];
  while (trimmed.length && trimmed[trimmed.length - 1] === '') trimmed.pop();
  const joined = [...trimmed, '', ...rest].join('\n');
  return { text: joined.endsWith('\n') ? joined : joined + '\n', moved: true, from: section.unreleased ? 'Unreleased' : section.version!, to: opts.to };
}

/**
 * Receipt normalization: version headings are replaced by a placeholder and
 * sections are compared as an order-independent multiset of lines, so a
 * heading move or re-heading is a stamp and any other edited byte is a change.
 */
export function normalizeChangelog(text: string): string {
  const parsed = parseChangelog(text);
  const sections = parsed.sections.map(s => ['## <version>', ...s.lines.slice(1)].join('\n').replace(/\n+$/, '')).sort();
  return [parsed.header.join('\n').replace(/\n+$/, ''), ...sections].join('\n\u0000');
}

/**
 * A merged-in head's CHANGELOG, however its conflict was resolved: why it is
 * not main's CHANGELOG with the PR's own entry above it, or null. Main's
 * header and every main section must follow unchanged and in order, and the
 * sections above them may hold only lines the PR itself added (`authored`,
 * the + lines of its pin's CHANGELOG diff), so a hand resolve can drop
 * damage but never add text the train gate did not carry.
 */
export function ownEntryAboveMain(head: string, main: string, authored: ReadonlySet<string>): string | null {
  const h = parseChangelog(head);
  const m = parseChangelog(main);
  const trim = (lines: string[]) => { const out = [...lines]; while (out.length && !out[out.length - 1]!.trim()) out.pop(); return out.join('\n'); };
  if (trim(h.header) !== trim(m.header)) return 'the header differs from main';
  const own = h.sections.length - m.sections.length;
  if (own < 0) return `it has ${h.sections.length} sections, main has ${m.sections.length}`;
  const moved = m.sections.findIndex((s, i) => trim(s.lines) !== trim(h.sections[own + i]!.lines));
  if (moved >= 0) return `main's ${m.sections[moved]!.heading.trim()} is not carried unchanged below the PR's entry`;
  const mainKeys = new Set(m.sections.map(s => s.version ?? 'Unreleased'));
  const clash = h.sections.slice(0, own).find(s => mainKeys.has(s.version ?? 'Unreleased'));
  if (clash) return `${clash.heading.trim()} is headed twice`;
  const added = h.sections.slice(0, own).flatMap(s => s.lines.slice(1)).find(l => l.trim() && !authored.has(l));
  return added === undefined ? null : `the PR's entry holds a line its pin never added: ${JSON.stringify(added.slice(0, 80))}`;
}

const MIN_BLOCK_CHARS = 12;

/** Paragraph blocks of a section's entry text (heading lines dropped), long enough to identify one entry. */
function entryBlocks(s: ChangelogSection): string[] {
  const blocks: string[] = [];
  let run: string[] = [];
  const flush = () => { const text = run.join('\n').trim(); if (text.length >= MIN_BLOCK_CHARS) blocks.push(text); run = []; };
  for (const line of s.lines.slice(1)) {
    if (!line.trim() || line.startsWith('#')) flush();
    else run.push(line);
  }
  flush();
  return blocks;
}

/**
 * Why one side of a CHANGELOG merge damaged released history, or null. A
 * side damages it when it lacks a released heading the merge base carries
 * (dropped, or renamed), or when a section only that side carries holds a
 * paragraph of a released entry the other side carries (a released heading
 * replaced, so its body reads as part of the section above it; #3345).
 */
export function changelogDamage(ours: string, theirs: string, base?: string): string | null {
  const sides = [{ name: 'ours', parsed: parseChangelog(ours) }, { name: 'theirs', parsed: parseChangelog(theirs) }];
  const key = (s: ChangelogSection) => (s.unreleased ? 'Unreleased' : s.version!);
  if (base !== undefined) {
    const released = parseChangelog(base).sections.filter(s => !s.unreleased).map(key);
    for (const side of sides) {
      const has = new Set(side.parsed.sections.map(key));
      const missing = released.find(v => !has.has(v));
      if (missing) return `${side.name} drops released heading ${missing} that the merge base carries`;
    }
  }
  for (const [i, side] of sides.entries()) {
    const other = sides[1 - i]!.parsed.sections;
    const otherKeys = new Set(other.map(key));
    const releasedText = new Map<string, string>();
    for (const s of other.filter(s => !s.unreleased)) for (const b of entryBlocks(s)) releasedText.set(b, s.version!);
    for (const s of side.parsed.sections.filter(s => !otherKeys.has(key(s)))) {
      const hit = entryBlocks(s).find(b => releasedText.has(b));
      if (hit) return `${side.name}'s ${key(s)} section holds released ${releasedText.get(hit)} text (${JSON.stringify(hit.slice(0, 60))}); a released heading was dropped or renamed`;
    }
  }
  return null;
}

/**
 * Gate-ahead merge of two CHANGELOGs that conflict textually but not
 * semantically: the predecessor's header and sections, with the branch's own
 * sections (those the predecessor lacks, by heading) placed first. When the
 * branch's top section carries the same version heading as a predecessor
 * section with a different body (both took the same tentative stamp), the
 * branch's entry is kept under `[Unreleased]` so the restamp re-heads it.
 * Both sides carrying `[Unreleased]` is a real conflict and returns null, and
 * so is damage to released history (`changelogDamage`): null means a hand
 * resolve, never a merge that carries the damage through.
 */
export function mergeChangelogs(ours: string, theirs: string, base?: string): string | null {
  if (changelogDamage(ours, theirs, base)) return null;
  const a = parseChangelog(ours);
  const b = parseChangelog(theirs);
  const key = (s: ChangelogSection) => (s.unreleased ? 'Unreleased' : s.version!);
  const entryText = (s: ChangelogSection) => s.lines.slice(1).join('\n').replace(/\n+$/, '');
  const top = a.sections[0];
  if (top && !top.unreleased && b.sections.some(s => key(s) === key(top) && entryText(s) !== entryText(top))) {
    const heading = /^##\s+\[/.test(top.heading) ? '## [Unreleased]' : '## Unreleased';
    a.sections[0] = { ...top, unreleased: true, version: null, heading, lines: [heading, ...top.lines.slice(1)] };
  }
  const theirKeys = new Set(b.sections.map(key));
  const ownOnly = a.sections.filter(s => !theirKeys.has(key(s)));
  if (a.sections.filter(s => s.unreleased).length > 1) return null;
  if (a.sections.some(s => s.unreleased) && b.sections.some(s => s.unreleased)) return null;
  const header = [...b.header];
  while (header.length && header[header.length - 1] === '') header.pop();
  const body = [...ownOnly, ...b.sections].flatMap(s => { const lines = [...s.lines]; while (lines.length && lines[lines.length - 1] === '') lines.pop(); return [...lines, '']; });
  return [...header, ...(header.length ? [''] : []), ...body].join('\n').replace(/\n+$/, '\n');
}
