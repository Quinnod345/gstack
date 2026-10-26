# Releases and update channels

gstack stamps a version at every merge to main, about a dozen a day. Since
late October 2026 there is also a weekly tagged release, and team-mode
installs follow it instead of every merge.

## What a release is

Every Monday at 07:00 Pacific (06:00 in winter) the **Weekly release**
workflow (`.github/workflows/weekly-release.yml`, which runs
`scripts/release-cut.ts`) takes the newest green commit on main and:

1. tags it `v<VERSION>` (the VERSION file at that commit, an annotated tag);
2. publishes a GitHub Release whose notes are one line per CHANGELOG version
   since the previous release, with a compare link and a link to the full
   CHANGELOG at that tag;
3. fast-forwards the `stable` branch to it.

A tag and its release never change. `stable` is a moving pointer: always a
commit on main's first-parent history, moved only by this workflow, only
forward.

**Green** means, on that exact commit: the `free-tests` check run succeeded
(the status main requires), the commit was gated (below), every check run on
it has completed and none failed, and `refs/notes/gstack-trains` holds no
active freeze. A cancelled check run counts as red. A commit with a check run
still going is skipped and the next older one is considered, back through 7
days or 200 first-parent commits. The workflow runs no tests and no paid evals
of its own; it only reads what the trains and the backstop already recorded.
With nothing green in the window it fails and lists why each commit was
skipped.

**Gated** means one of two pieces of evidence. The first is the
`main-backstop` check run: the Main backstop gate workflow publishes it on
each push to main from a job of its own, success when a green train record
covers the tree or the backstop gated it green, neutral when main moved past
the push before it was gated (superseded) or a freeze's own backstop run owns
it (deferred), failure when it froze the queue or could not finish. The second
is a train record in `refs/notes/gstack-trains` (kind `train`, state
`green`, `merging` or `merged`) whose `merged[]` lists the commit's sha or
its tree: those entries are the main commits `gstack-ship-queue verify
--train` confirmed, so a commit a green train merged is gated even when trains
merged faster than the backstop could settle and its own backstop run ended
neutral or never ran. The `CANDIDATE` line says which: `gated by
main-backstop` or `gated by train <nonce>`. Train evidence relaxes nothing
else: a red backstop run, a failed or missing `free-tests` run, any other red
check run or a run still going keeps the commit out, and a record in any other
state (`red`, `superseded`, `free-green`, …) is not evidence. A commit with
neither a successful backstop run nor a train record is not released: a
dependabot push, a policy without a train block, or a tree that was never
gated.

Another repository runs the same script with its own names:
`--required-check <name>` (default `free-tests`), `--backstop-check <name>`
(default `main-backstop`) and `--notes-ref <ref>` (default
`refs/notes/gstack-trains`). `weekly-release.yml` passes none of them.

A cut that stopped half-way (tag and `stable` pushed, release not created) is
finished by the next run, by cron or by hand: `stable` itself stays a
candidate until its release exists, and its notes compare against the release
tag before it.

## Channels

| Channel | Follows | Who |
|---|---|---|
| `stable` | `refs/heads/stable`: the weekly release, plus any hotfix cut off-cycle | team mode (`./setup --team`) by default |
| `main` | every merge to main | plain `./setup`, contributors, Capy crew machines |

The config key is `update_channel` (`bin/gstack-config`):

```bash
gstack-config get update_channel          # auto (default) | stable | main
gstack-config set update_channel main     # a team install that wants every merge
gstack-config set update_channel stable   # a solo install that wants weekly releases
gstack-config unset update_channel        # back to auto
```

`auto` resolves to `stable` when `team_mode` is true and to `main` otherwise,
so existing team installs moved to weekly releases with nothing to migrate and
contributor installs did not move at all. `GSTACK_UPDATE_CHANNEL=stable|main`
overrides the key for one command. The resolution lives in one helper,
`bin/gstack-update-channel.sh`, used by:

- `bin/gstack-session-update`, the team-mode session-start hook: it fetches
  the channel ref and fast-forwards to it. Its log
  (`<state root>/analytics/session-update.log`) carries `CHANNEL stable target=<sha>`
  when it follows a release.
- `bin/gstack-update-check`, the "update available" line in every skill
  preamble: it reads `<channel>/VERSION` and compares with `refs/heads/<channel>`,
  so a stable install is not told every hour that main moved.
- `bin/gstack-upgrade` and `/gstack-upgrade`: they fast-forward to the channel
  ref (`UPSTREAM_REF=origin/stable` in the skill's output) and say which channel
  they followed.

Two edge cases are handled on purpose:

- **Before the first release exists** origin has no `stable`. Every caller then
  follows main and says so (`CHANNEL_FALLBACK stable->main` in the hook log,
  `channel stable has no release on origin yet` from `gstack-upgrade`).
- **An install already past the release** (it followed main until now, or a
  hotfix was cut below it) stays where it is until stable passes it. The
  updater never moves a checkout backwards. A depth-1 clone cannot see that an
  older release is its ancestor, so the VERSIONs decide: main stamps a higher
  version at every merge and stable is always a main commit.

The local branch stays `main` either way. A stable install is a `main`
checkout parked at the last released commit, which is why fast-forward-only
still holds and nothing about version stamping changed.

## Cutting a release by hand (hotfixes)

A hotfix is an ordinary PR: it merges to main through a train and gets its
version like any other change. To put it on stable before Monday, run the
workflow by hand with the merge commit's SHA:

```bash
gh workflow run weekly-release.yml -f ref=<full sha on main> -f dry_run=false
```

or Actions → **Weekly release** → Run workflow, on main (the cut job runs
only from `refs/heads/main`, with main's tooling; `ref` must be the full
40-hex SHA). The same green checks apply. The commit is tagged with its VERSION, the release notes say "hotfix release"
and list every version since the previous release (everything merged in
between ships with it), and stable fast-forwards. Team installs pick it up at
their next hourly check.

There is no release branch and no cherry-picking: stable only ever names main
commits. If main carries a change that must not ship yet, revert it on main
first, then promote.

## Dry runs

Run the workflow with `dry_run=true` (the default for a manual run) to see the
plan without changing anything: the candidate, its VERSION and tag, the stable
move, how many version lines the notes would carry, every skipped commit with
its reason, and the exact commands a real cut would run. The scheduled Monday
run is never a dry run.

```bash
gh workflow run weekly-release.yml -f dry_run=true
gh run watch
```

The step summary carries the same plan plus the full release notes.

A pull request that touches `.github/workflows/weekly-release.yml` or
`scripts/release-cut.ts` runs the same dry run against main as its own job
(`Dry run against main`, read-only token), so a change to the release tooling
is exercised against real check runs before it merges.

## Outcomes

| Line | Meaning |
|---|---|
| `CANDIDATE: <sha> (<date>) gated by main-backstop|train <nonce>` | the commit that will be (or was) released, and which evidence gated it (`[hotfix: --ref]` before `gated by` on a `--ref` cut) |
| `NOTHING_NEW: origin/main <sha> is already released as v<X>` | nothing merged since the last release; exit 0 |
| `NO_GREEN_COMMIT: ...` with `SKIPPED:` lines | nothing in the window passed the gate; exit 1 (a dry run exits 0: the skips are its answer) |
| `REFUSED: non-fast-forward: ...` | the candidate is behind stable; stable only moves forward |
| `REFUSED: queue frozen since train ...` | the main backstop froze the queue; clear it first (docs/ship-policy.md) |
| `REFUSED: tag v<X> already names <other sha>` | a version was stamped twice; needs a look before anything is cut |
| `TAG:`, `STABLE:`, `RELEASE:` | what the cut did; a re-run reports each step as already done and finishes a step an earlier run did not reach |
