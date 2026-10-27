/**
 * skill-bill — size per level for one agent skill, and its growth since the last diet.
 *
 * Levels: the frontmatter description (every session), SKILL.md (every use), its template when it
 * has one, and each file under sections/ or references/ (read on demand). The last diet is the
 * newest commit whose message carries a "Skill-Diet: <name>" trailer; growth past DUE_PCT since
 * then means the skill is due for another diet. Read-only: runs git, never writes.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { estimateTokens } from "./context-bill";

export const DUE_PCT = 10;

export type SkillKind = "gstack-checkout" | "gstack-install" | "user";

export interface LevelRow { level: string; path: string; bytes: number; tokens: number; generated: boolean }

export interface Baseline { status: "none" | "unknown" | "found"; reason?: string; sha?: string; date?: string; bytes?: number; growthPct?: number; due?: boolean }

export interface SkillBillReport {
  name: string;
  dir: string;
  kind: SkillKind;
  authored: string;
  rows: LevelRow[];
  baseline: Baseline;
  warnings: string[];
}

export class SkillBillError extends Error {
  constructor(readonly code: "SKILL_NOT_FOUND" | "SKILL_AMBIGUOUS" | "SKILL_MD_MISSING", message: string, readonly fix: string) {
    super(message);
  }
}

const GENERATED = "<!-- AUTO-GENERATED from";

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", timeout: 15_000 });
  return { ok: r.status === 0, out: (r.stdout || "").trim() };
}

function isSkillDir(dir: string): boolean {
  return existsSync(join(dir, "SKILL.md")) || existsSync(join(dir, "SKILL.md.tmpl"));
}

function gstackRootOf(dir: string): string | null {
  const parent = dirname(dir);
  return existsSync(join(parent, "SKILL.md.tmpl")) && existsSync(join(parent, "VERSION")) && existsSync(join(parent, "bin")) ? parent : null;
}

export function skillSearchRoots(cwd: string, home: string = homedir()): string[] {
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  const roots = [
    top.ok && existsSync(join(top.out, "SKILL.md.tmpl")) && existsSync(join(top.out, "VERSION")) ? top.out : "",
    join(cwd, ".claude", "skills"),
    join(cwd, ".agents", "skills"),
    join(home, ".claude", "skills"),
    join(home, ".claude", "skills", "gstack"),
    join(home, ".agents", "skills"),
    join(process.env.CODEX_HOME || join(home, ".codex"), "skills"),
  ];
  return [...new Set(roots.filter((r) => r && existsSync(r)))];
}

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** Exact path or exact name; never a fuzzy pick. */
export function resolveSkill(target: string, cwd: string, home: string = homedir()): string {
  const asPath = resolve(cwd, target);
  if (target.includes("/") || target.startsWith(".")) {
    if (!existsSync(asPath)) throw new SkillBillError("SKILL_NOT_FOUND", `no folder at ${asPath}`, "pass a skill folder or an exact skill name");
    if (!isSkillDir(asPath)) throw new SkillBillError("SKILL_MD_MISSING", `${asPath} has no SKILL.md or SKILL.md.tmpl`, "point at the folder that holds SKILL.md");
    return realpathSync(asPath);
  }
  const roots = skillSearchRoots(cwd, home);
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top.ok && roots[0] === top.out && isSkillDir(join(top.out, target))) return realpathSync(join(top.out, target));
  const found = [...new Set(roots.map((r) => join(r, target)).filter(isSkillDir).map((p) => realpathSync(p)))];
  const editable = found.filter((p) => skillKind(p) !== "gstack-install");
  const hits = editable.length ? editable : found;
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new SkillBillError("SKILL_AMBIGUOUS", `"${target}" names ${hits.length} skills:\n  ${hits.join("\n  ")}`, "pass the folder path of the one you mean");
  const names = roots.flatMap((r) => { try { return readdirSync(r).filter((n) => isSkillDir(join(r, n))); } catch { return []; } });
  const close = [...new Set(names)].sort((a, b) => editDistance(target, a) - editDistance(target, b)).slice(0, 3);
  throw new SkillBillError("SKILL_NOT_FOUND", `no skill named "${target}" in ${roots.join(", ") || "any skill folder"}`, close.length ? `closest: ${close.join(", ")}; pass an exact name or a path` : "pass a skill folder path");
}

export function skillKind(dir: string): SkillKind {
  if (existsSync(join(dir, "SKILL.md.tmpl")) && gstackRootOf(dir)) return "gstack-checkout";
  const md = join(dir, "SKILL.md");
  const generated = existsSync(md) && readFileSync(md, "utf-8").includes(GENERATED) && !existsSync(join(dir, "SKILL.md.tmpl"));
  if (generated || /\/skills\/gstack(-[^/]+)?\//.test(dir + "/")) return "gstack-install";
  return "user";
}

function frontmatterDescription(text: string): string {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return "";
  try {
    const parsed = Bun.YAML.parse(fm[1]) as Record<string, unknown> | null;
    return typeof parsed?.description === "string" ? parsed.description.trim() : "";
  } catch { return ""; }
}

function row(level: string, dir: string, file: string): LevelRow {
  const text = readFileSync(file, "utf-8");
  const bytes = Buffer.byteLength(text);
  return { level, path: relative(dir, file) || basename(file), bytes, tokens: estimateTokens(bytes), generated: text.includes(GENERATED) };
}

function onDemandFiles(dir: string): string[] {
  return ["sections", "references"].flatMap((sub) => {
    const base = join(dir, sub);
    if (!existsSync(base) || !statSync(base).isDirectory()) return [];
    return readdirSync(base, { recursive: true }).map(String).filter((f) => f.endsWith(".md")).sort().map((f) => join(base, f));
  });
}

export function findBaseline(dir: string, name: string, authored: string): Baseline {
  const inside = git(dir, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok) return { status: "unknown", reason: "not a git folder; keep the Skill-Size line yourself" };
  const rel = git(dir, ["ls-files", "--full-name", "--", authored]);
  const log = git(dir, ["log", "-1", "--format=%H%x09%cs", "-E", `--grep=^Skill-Diet: ${name}\\b`, "--", "."]);
  if (!log.ok || !log.out) {
    const shallow = git(dir, ["rev-parse", "--is-shallow-repository"]).out === "true";
    return shallow ? { status: "unknown", reason: "shallow history; fetch more to find the last Skill-Diet commit" } : { status: "none", reason: `no commit carries "Skill-Diet: ${name}"` };
  }
  const [sha, date] = log.out.split("\t");
  const top = git(dir, ["rev-parse", "--show-toplevel"]).out;
  const path = rel.out || relative(top, join(dir, authored));
  const then = git(top, ["show", `${sha}:${path}`]);
  if (!then.ok) return { status: "unknown", reason: `${path} did not exist at ${sha.slice(0, 7)}` };
  const bytes = Buffer.byteLength(then.out + "\n");
  const now = statSync(join(dir, authored)).size;
  const growthPct = Math.round(((now - bytes) / bytes) * 1000) / 10;
  return { status: "found", sha, date, bytes, growthPct, due: growthPct > DUE_PCT };
}

export function buildSkillBill(dir: string): SkillBillReport {
  const kind = skillKind(dir);
  const md = join(dir, "SKILL.md");
  const tmpl = join(dir, "SKILL.md.tmpl");
  const authored = existsSync(tmpl) ? "SKILL.md.tmpl" : "SKILL.md";
  const source = readFileSync(join(dir, authored), "utf-8");
  const name = (source.match(/^name:\s*(.+)$/m)?.[1] || basename(dir)).trim();
  const description = frontmatterDescription(existsSync(md) ? readFileSync(md, "utf-8") : source) || frontmatterDescription(source);
  const rows: LevelRow[] = [{ level: "description", path: "frontmatter", bytes: Buffer.byteLength(description), tokens: estimateTokens(Buffer.byteLength(description)), generated: false }];
  if (existsSync(tmpl)) rows.push(row("template", dir, tmpl));
  if (existsSync(md)) rows.push(row("SKILL.md", dir, md));
  for (const f of onDemandFiles(dir)) rows.push(row("on-demand", dir, f));
  const warnings: string[] = [];
  if (kind === "gstack-checkout") {
    const changed = git(dir, ["status", "--porcelain", "--", "SKILL.md.tmpl", "SKILL.md"]).out.split("\n").filter(Boolean);
    if (changed.some((l) => l.endsWith("SKILL.md.tmpl")) && !changed.some((l) => l.endsWith(" SKILL.md") || l.endsWith("/SKILL.md")))
      warnings.push("RENDER_STALE: SKILL.md.tmpl changed but SKILL.md did not. fix: bun run gen:skill-docs");
  }
  if (kind === "gstack-install") warnings.push("INSTALLED_GSTACK_SKILL: gstack-upgrade overwrites this folder. fix: edit <skill>/SKILL.md.tmpl in a gstack checkout, or copy the skill to a folder you own");
  return { name, dir, kind, authored, rows, baseline: findBaseline(dir, name, authored), warnings };
}

export function renderSkillBill(r: SkillBillReport): string {
  const lines = [`SKILL: ${r.name} (${r.kind}) ${r.dir}`];
  for (const x of r.rows) lines.push(`  ${x.level.padEnd(11)} ${x.path.padEnd(28)} ${String(x.bytes).padStart(7)} B  ~${String(x.tokens).padStart(6)} tok${x.generated ? "  (generated)" : ""}`);
  const b = r.baseline;
  if (b.status === "found") lines.push(`BASELINE: ${b.sha!.slice(0, 7)} ${b.date} ${r.authored} ${b.bytes} B; now ${b.growthPct! >= 0 ? "+" : ""}${b.growthPct}%${b.due ? ` DUE: over ${DUE_PCT}% since the last diet, so diet before adding` : ""}`);
  else lines.push(`BASELINE: ${b.status} (${b.reason})`);
  lines.push(...r.warnings);
  lines.push(`Commit line: Skill-Size: <before>→<after> bytes (${r.authored})`);
  return lines.join("\n");
}
