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

A skill you name is always invoked, whatever the setting. The change takes
effect on the next skill run; no `./setup` is needed, because every skill
reads `PROACTIVE` from `gstack-skill-start` at the start of each run and the
router (`/gstack`) applies it to its routing rules.

gstack asks once, after the telemetry question, which of the three you want.
"Say stop suggesting" in a session runs `gstack-config set proactive off` for you.

If collisions with other skill packs keep coming up under `core`, the fallback
Garry approved on 2026-10-25 is `off` by default.
