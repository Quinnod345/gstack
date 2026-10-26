/**
 * Fixture test for bin/gstack-worktree-audit: a bare origin, a main clone and
 * worktrees in every bucket the script knows, with a fake gh on PATH and a
 * Claude Code transcript directory under CLAUDE_CONFIG_DIR. The audit reads
 * only: the fixture is byte-compared before and after.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const BIN = path.join(ROOT, "bin", "gstack-worktree-audit");

let tmp: string;
let repo: string;
let origin: string;
let fakeBin: string;
let claudeDir: string;
const wts: Record<string, string> = {};

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30_000, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}
function commit(cwd: string, file: string, text: string, msg: string): void {
  fs.writeFileSync(path.join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", msg);
}
function audit(...args: string[]) {
  const r = spawnSync("bash", [BIN, ...args], {
    cwd: repo, encoding: "utf8", timeout: 60_000,
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: claudeDir, HOME: tmp },
  });
  const lines = r.stdout.split("\n").filter(Boolean);
  const header = lines[1]?.split("\t") ?? [];
  const rows = lines.slice(2).map(l => Object.fromEntries(l.split("\t").map((v, i) => [header[i]!, v])) as Record<string, string>);
  return { status: r.status, stderr: r.stderr, base: lines[0], header, rows, byPath: Object.fromEntries(rows.map(r => [r.WORKTREE, r])) };
}
function snapshot(dir: string): string {
  const r = spawnSync("bash", ["-c", "find . -path ./.git -prune -o -type f -print0 | sort -z | xargs -0 sha256sum; git -C . status --porcelain; git -C . for-each-ref"], { cwd: dir, encoding: "utf8", timeout: 30_000 });
  return r.stdout;
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-wt-audit-"));
  origin = path.join(tmp, "origin.git");
  repo = path.join(tmp, "repo");
  fs.mkdirSync(origin);
  git(origin, "init", "-q", "--bare", "--initial-branch=main");
  git(tmp, "clone", "-q", origin, repo);
  git(repo, "checkout", "-q", "-b", "main");
  commit(repo, "README.md", "# fixture\n", "initial");
  git(repo, "push", "-q", "-u", "origin", "main");

  // merged: a branch whose commit was fast-forwarded into main and pushed; clean tree, branch never pushed.
  wts.merged = path.join(tmp, "wt-merged");
  git(repo, "worktree", "add", "-q", "-b", "feat/merged", wts.merged);
  commit(wts.merged, "merged.txt", "done\n", "merged work");
  git(repo, "merge", "-q", "--ff-only", "feat/merged");
  git(repo, "push", "-q", "origin", "main");

  // wip: pushed branch with a tracked edit on top; its PR is open.
  wts.wip = path.join(tmp, "wt-wip");
  git(repo, "worktree", "add", "-q", "-b", "feat/wip", wts.wip);
  commit(wts.wip, "wip.txt", "v1\n", "wip work");
  git(wts.wip, "push", "-q", "-u", "origin", "feat/wip");
  fs.writeFileSync(path.join(wts.wip, "wip.txt"), "v2 edited\n");

  // scratch: an unpushed branch, two untracked files, a chat from today → verify-recent-chat.
  wts.scratch = path.join(tmp, "wt-scratch");
  git(repo, "worktree", "add", "-q", "-b", "feat/scratch", wts.scratch);
  commit(wts.scratch, "scratch.txt", "s\n", "scratch work");
  fs.writeFileSync(path.join(wts.scratch, "notes.md"), "untracked\n");
  fs.writeFileSync(path.join(wts.scratch, "tmp.log"), "untracked\n");
  claudeDir = path.join(tmp, "claude");
  const chat = path.join(claudeDir, "projects", wts.scratch.replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(chat, { recursive: true });
  fs.writeFileSync(path.join(chat, "session.jsonl"), "{}\n");

  // stale: an unpushed branch nobody touched, no chat, no PR → review.
  wts.stale = path.join(tmp, "wt-stale");
  git(repo, "worktree", "add", "-q", "-b", "feat/stale", wts.stale);
  commit(wts.stale, "stale.txt", "s\n", "stale work");

  // closed: pushed branch whose PR was closed without merging → safe.
  wts.closed = path.join(tmp, "wt-closed");
  git(repo, "worktree", "add", "-q", "-b", "feat/closed", wts.closed);
  commit(wts.closed, "closed.txt", "c\n", "closed work");
  git(wts.closed, "push", "-q", "-u", "origin", "feat/closed");

  fakeBin = path.join(tmp, "fakebin");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, "gh"), "#!/usr/bin/env bash\nprintf 'feat/wip\\t41\\topen\\nfeat/closed\\t40\\tclosed\\n'\n", { mode: 0o755 });
});
afterAll(() => {
  if (repo) spawnSync("git", ["worktree", "prune"], { cwd: repo, timeout: 30_000 });
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe("gstack-worktree-audit", () => {
  test("classifies every worktree, reads the PR column through gh, the chat through CLAUDE_CONFIG_DIR, and changes nothing", () => {
    const before = Object.values(wts).map(snapshot).join("\n") + snapshot(repo);
    const r = audit();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("warn: no -b given; MERGED checks against origin/main");
    expect(r.base).toBe("# base: origin/main");
    expect(r.header).toEqual(["SIZE", "AGE", "MERGED", "DIRTY", "REMOTE", "PR", "LAST_CHAT", "BUCKET", "WORKTREE"]);
    expect(r.rows).toHaveLength(5);
    expect(r.byPath[repo]).toBeUndefined();

    const merged = r.byPath[wts.merged]!;
    expect(merged).toMatchObject({ MERGED: "YES", DIRTY: "clean", REMOTE: "no-remote", PR: "-", LAST_CHAT: "-", BUCKET: "safe", AGE: "0d" });
    expect(merged.SIZE).toMatch(/^\d+(\.\d+)?[KMG]?$/);

    expect(r.byPath[wts.wip]).toMatchObject({ MERGED: "no", DIRTY: "wip:1", REMOTE: "pushed", PR: "#41/open", BUCKET: "hold-wip" });
    const scratch = r.byPath[wts.scratch]!;
    expect(scratch).toMatchObject({ MERGED: "no", DIRTY: "scratch:2", REMOTE: "no-remote", PR: "-", BUCKET: "verify-recent-chat" });
    expect(scratch.LAST_CHAT).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.byPath[wts.stale]).toMatchObject({ MERGED: "no", DIRTY: "clean", REMOTE: "no-remote", PR: "-", LAST_CHAT: "-", BUCKET: "review" });
    expect(r.byPath[wts.closed]).toMatchObject({ MERGED: "no", DIRTY: "clean", REMOTE: "pushed", PR: "#40/closed", BUCKET: "safe" });

    const after = Object.values(wts).map(snapshot).join("\n") + snapshot(repo);
    expect(after).toBe(before);
  });

  test("an open PR holds a clean worktree, an unpushed commit reads ahead<n>, and -b picks the base", () => {
    git(wts.closed, "commit", "-q", "--allow-empty", "-m", "one more");
    fs.writeFileSync(path.join(fakeBin, "gh"), "#!/usr/bin/env bash\nprintf 'feat/closed\\t40\\topen\\n'\n", { mode: 0o755 });
    const r = audit("-b", "origin/main", "--no-fetch", repo);
    expect(r.stderr).not.toContain("warn: no -b given");
    expect(r.byPath[wts.closed]).toMatchObject({ REMOTE: "ahead1", PR: "#40/open", BUCKET: "hold-open-pr" });
  });

  test("without gh the PR column is - with a warning, and a missing base ref or repo is an error", () => {
    // Shadow every gh on PATH with a directory the audit cannot execute from: `command -v` skips a non-executable file.
    const noGh = path.join(tmp, "nogh");
    fs.mkdirSync(noGh);
    for (const tool of ["git", "bash", "du", "awk", "sed", "sort", "head", "find", "xargs", "stat", "date", "mktemp", "grep", "rm"]) {
      const found = (process.env.PATH ?? "").split(path.delimiter).map(d => path.join(d, tool)).find(p => fs.existsSync(p));
      if (found) fs.symlinkSync(found, path.join(noGh, tool));
    }
    const r = spawnSync("bash", [BIN, "--no-fetch"], { cwd: repo, encoding: "utf8", timeout: 60_000, env: { ...process.env, PATH: noGh, CLAUDE_CONFIG_DIR: claudeDir, HOME: tmp } });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("PR column is -");
    expect(r.stdout.split("\n").filter(Boolean).slice(2).every(l => l.split("\t")[5] === "-")).toBe(true);
    expect(audit("-b", "origin/nope", "--no-fetch").status).toBe(1);
    expect(audit("--no-fetch", path.join(tmp, "not-a-repo")).status).toBe(1);
    expect(audit("--bogus").status).toBe(2);
    expect(audit("--help").status).toBe(0);
  });
});
