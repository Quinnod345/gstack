# Proactive skill suggestions

gstack notices what stage you are in (a new idea, a diff to review, "does this
work?", time to land it) and can invoke the matching skill without you typing
its slash command. The `proactive` config key says how far that goes.

| Value | What auto-invokes | Who it is for |
|-------|-------------------|---------------|
| `core` (default) | `/office-hours`, `/review`, `/qa` and `/ship` only. Every other skill waits for you to type it. | Most people, and anyone running gstack beside another skill pack: the four core skills are the ones users praise, and the others no longer compete with another pack's niche skills. |
| `all` | Any skill whose purpose matches your request. | You use gstack on its own and want the whole sprint suggested. |
| `off` | Nothing. gstack never suggests or auto-invokes a skill, not even by asking "want me to run /X?". | You type every command yourself. |

`true` and `false` still work as the older spellings of `all` and `off`, so a
config written before the `core` default keeps its behavior.

```bash
gstack-config get proactive          # core, all, off (or a legacy true/false)
gstack-config set proactive all      # suggest every matching skill
gstack-config set proactive off      # suggest nothing
gstack-config set proactive core     # back to the default
```

A skill you name is always invoked, whatever the setting. The setting governs
unasked suggestions only: a step inside a skill you invoked (`/office-hours`
offering the next review, `/ship` dispatching `/document-release`) is part of
that skill and still runs; under `off`, `/office-hours` recommends the next
review in one line instead of offering to launch it, and the one-time first-run
tips stay quiet. The change takes effect on the next skill run; no `./setup` is
needed, because every skill reads `PROACTIVE` from `gstack-skill-start` at the
start of each run and the router (`/gstack`) applies it to its routing rules. A
value gstack does not know (a hand-edited `proactive: maybe`) reads as `core`.

One surface follows the setting only in part: the `## Skill routing` section
gstack offers to append to your project's CLAUDE.md. Under `off` the offer is
not made, because those rules are the auto-invocation you turned off (a section
already in CLAUDE.md stays; delete it yourself). Under `core` the offered
section still lists every routing rule and tells the host to invoke any
matching skill. If you accepted it before the `core` default, trim that section
to the four core rules (or delete it and let gstack offer it again); making the
offered section follow `core` is tracked as a follow-up.

gstack asks once, after the telemetry question, which of the three you want.
"Say stop suggesting" in a session runs `gstack-config set proactive off` for you.

If collisions with other skill packs keep coming up under `core`, the fallback
Garry approved on 2026-10-25 is `off` by default.
