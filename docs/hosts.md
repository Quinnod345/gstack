# Running gstack on other agents

The README has the host matrix: one row per agent with its tier, install
command and first invocation. This page has the rest: OpenClaw, how a checkout
decides which agents it renders for, the per-host notes, outside-review
providers, the Codex behavioral profile, model tiers, and the design binary's
models.

## OpenClaw

OpenClaw spawns Claude Code sessions via ACP, so every gstack skill just works
when Claude Code has gstack installed. Paste this to your OpenClaw agent:

> Install gstack: run `git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack && cd ~/.claude/skills/gstack && ./setup` to install gstack for Claude Code. Then add a "Coding Tasks" section to AGENTS.md that says: when spawning Claude Code sessions for coding work, tell the session to use gstack skills. Include these examples — security audit: "Load gstack. Run /cso", code review: "Load gstack. Run /review", QA test a URL: "Load gstack. Run /qa https://...", build a feature end-to-end: "Load gstack. Run /autoplan, implement the plan, then run /ship", plan before building: "Load gstack. Run /office-hours then /autoplan. Save the plan, don't implement."

**After setup, just talk to your OpenClaw agent naturally:**

| You say | What happens |
|---------|-------------|
| "Fix the typo in README" | Simple — Claude Code session, no gstack needed |
| "Run a security audit on this repo" | Spawns Claude Code with `Run /cso` |
| "Build me a notifications feature" | Spawns Claude Code with /autoplan → implement → /ship |
| "Help me plan the v2 API redesign" | Spawns Claude Code with /office-hours → /autoplan, saves plan |

See [docs/OPENCLAW.md](OPENCLAW.md) for advanced dispatch routing and
the gstack-lite/gstack-full prompt templates.

## Native OpenClaw Skills (via ClawHub)

Four methodology skills that work directly in your OpenClaw agent, no Claude Code
session needed. Install from ClawHub:

```
clawhub install gstack-openclaw-office-hours gstack-openclaw-ceo-review gstack-openclaw-investigate gstack-openclaw-retro
```

| Skill | What it does |
|-------|-------------|
| `gstack-openclaw-office-hours` | Product interrogation with 6 forcing questions |
| `gstack-openclaw-ceo-review` | Strategic challenge with 4 scope modes |
| `gstack-openclaw-investigate` | Root cause debugging methodology |
| `gstack-openclaw-retro` | Weekly engineering retrospective |

These are conversational skills. Your OpenClaw agent runs them directly via chat.

## Which agents a checkout renders for

An explicit `--host X` installs for X only and never changes another agent's
install. `/gstack-upgrade` refreshes every install it registered, one row per
host, and says which ones failed.

A checkout carries skills only for the agents installed from it. Setup records
them in `.gstack-installed-hosts` and never drops one, so adding an agent later
is just `./setup --host <name>`. Copies rendered for other agents are pruned:
generated files move to `~/.gstack/backups/host-renders/`, and files gstack
can't prove it generated stay where they are. A global Claude install went
from 632 `SKILL.md` files (34.7 MB) to its own 63 (2.5 MB), which keeps Cursor-agent
from freezing on the skills tree (#1694). In a development checkout,
`bun run build` still renders every agent; inside an install it renders the
recorded ones, and `GSTACK_RENDER_HOSTS=all bun run build` renders them all.

## Per-host notes

Copilot invokes gstack skills by their prefixed names (`/gstack-review`) because
`/review` is a Copilot built-in. Copilot ignores skill hooks, so `/careful` and
`/freeze` only advise there, and `COPILOT_HOME` other than `~/.copilot` is not
supported yet (setup refuses and changes nothing).

Antigravity CLI also invokes skills by prefixed name (`/gstack-review`). Setup
writes only `~/.gemini/antigravity-cli/skills/gstack*`: Gemini CLI's
`~/.gemini/skills` and settings are never touched, and `--host auto` selects
Antigravity only when `agy` is on `PATH` or `~/.gemini/antigravity-cli` exists,
never for a Gemini-CLI-only `~/.gemini`. The Antigravity 2.0 app and IDE read
`~/.gemini/config/skills`, which this host does not install.

Outside reviews require the selected CLI to be installed and authenticated: Claude Code when using gstack in Codex, or Codex on other harnesses. External harnesses discover these commands as `/gstack-claude-code` and `/gstack-codex`; each harness omits its own wrapper. Explicit provider requests keep that provider. The existing `codex_reviews` setting controls automatic outside reviews where supported, regardless of the provider selected.

`/claude` has been renamed to `/claude-code`. Re-run `./setup --host <name>` to migrate managed installations, including other harnesses sharing the checkout. Setup preserves the previous installation if replacement generation or installation fails and prints repair instructions.

## Instruction-only agents

**Instruction-only tier (any rules-reading agent — Zed, Amp, Jules, side projects):**
copy the 2KB digest at [`agents-digest/gstack-AGENTS.md`](../agents-digest/gstack-AGENTS.md)
into a location your agent reads (for example, append it to your project's `AGENTS.md`).
It carries gstack's ethos, reuse ladder, and voice rules — no install required. The
digest's first line shows its gstack version; re-copy it after upgrading.

## Codex: the behavioral profile and model selection

For Codex, setup reads the top-level `model` from
`${CODEX_HOME:-~/.codex}/config.toml` and generates the matching behavioral
profile, falling back to `gpt-6-astra` when no usable model is configured.
`gpt-5.6-sol` automatically receives bounded-scope instructions that
finish the requested lake without expanding into adjacent cleanup or speculative
hardening. The Sol profile is exact-match only: dated snapshots and other 5.6
variants get the generic GPT profile, and setup warns on near-misses like
`gpt-5.6-sol-2026-08-01`. Override detection with `./setup --host codex --model <id>` — the
override applies to that run only; set `model` in your Codex `config.toml` to
make it stick across upgrades. After changing your Codex model, rerun
`./setup --host codex` to regenerate the skills.

**Plan-review and implementation tiers.** Plan workflows use an independent
`frontier` reviewer: Fable 5.1 from Codex, or GPT-6 Astra from Claude Code.
Implementation handoffs recommend the `smart` tier: Opus 5.5 or GPT-6.1 Sol.
Choose a different tier, pin either provider's model, or use `host` mode to
preserve native model settings. The read-only `gstack-models` command explains
the effective choices; changing these settings does not require regenerating
skills or switch your running session. A weekly maintenance check flags changed
official recommendations and retirement notices without automatically changing
models. See [model policy: setup, overrides and freshness](model-policy.md).

**Other Codex calls keep their existing selection.** Without the explicit
`plan-review` role (including ordinary review and ship adversarial passes), gstack picks the model in this
order: a model you name for that request, then `GSTACK_CODEX_MODEL`, then
`model` in your Codex `config.toml` (for native `codex review`, `review_model`
first; a custom `CODEX_HOME` is honored), and only then gstack's default,
`gpt-6-astra`. Before spending anything, it prints the choice and where it came
from, for example `CODEX_MODEL: gpt-5.6-terra (exec; source: ~/.codex/config.toml model)`.
If your choice is invalid or your account cannot use it, gstack stops with a
repair message and reports the outside review as unavailable. It never silently
switches to its default. Nested Codex reviews also run with installed skills
hidden (`-c skills.include_instructions=false`), so a review cannot turn into a
whole nested skill run. Runtime model selection is separate from the setup-time
behavioral profile above. Without the plan-review role, `/claude-code` (`gstack-claude-code`
on Codex) preserves Claude's configured model. Set `GSTACK_CLAUDE_MODEL=<model>`
or name a model in your request to override it for the invocation, including
resumed consultations. See [eval defaults and overrides](../CONTRIBUTING.md#testing--evals)
for capture, judge, and benchmark model selection.

## The design binary's models

The design binary (`$D`) uses OpenAI's `gpt-5.5` by default, with image
generation through `gpt-image-2`. Set `GSTACK_DESIGN_MODEL=<model>` to use
another gpt-5-class model for both image generation and screenshot analysis;
if OpenAI rejects it, the error names `GSTACK_DESIGN_MODEL`. Set
`GSTACK_DESIGN_IMAGE_MODEL=<gpt-image model>` to change the image tool model; a
value that is not a gpt-image model name is refused before any request. Check a
key against the defaults with `bun run design/scripts/live-model-check.ts`,
which always tests the default models and ignores both overrides; the weekly
periodic census runs the same check. Set `OPENAI_BASE_URL` to send every `$D`
call to an OpenAI-compatible gateway instead of `api.openai.com`; egress
receipts record the gateway host. On Codex, `/design-shotgun` generates mockups
with Codex's built-in `$imagegen` skill instead, so it needs no
`OPENAI_API_KEY`; `$D` still builds and serves the comparison board.

## Adding a host

**Want to add support for another agent?** See [docs/ADDING_A_HOST.md](ADDING_A_HOST.md).
Rendering a new agent is one TypeScript config file; installing it also needs a
setup arm and the conformance kit, and it starts as experimental.
