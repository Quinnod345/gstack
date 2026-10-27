# Voice input (AquaVoice, Whisper, etc.)

Many gstack skills list speech-to-text aliases (`voice-triggers:` in their
templates): "security check" for `/cso`, "run QA" or "test the app" for `/qa`,
"tech review" for `/plan-eng-review`. Say one of those naturally and the right
skill can be picked without the slash command name. On Claude Code the aliases
are routing lines in the root `/gstack` router; on Codex and the other hosts
they are appended to each skill's description, which is what those hosts match
on.

The separate `triggers:` list in a skill's frontmatter is gstack metadata, not a
matching surface. Claude Code and Codex choose a skill from its name and
description, so a phrase that appears only under `triggers:` does not activate
the skill (Codex output drops the field; the GBrain host keeps it).
