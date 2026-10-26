# Digest (<CREW_NAME>) — <date time, timezone>

Rewritten at every controller turn. One line per row, newest first within a section,
every row with its thread and an age. Codes are the thread codes the host assigns.

## Needs you

<empty when the owner has nothing to do>

- <thread> · <age since asked> · <one-line plain-language ask> · default reply: **<one word>** · cost: <amount or none>

## New

- <thread> · <age> · merged #<n> as v<X> (train <nonce>, slot <i>)
- <thread> · <age> · READY #<n> <sha12> (<--screen|--no-screen>), waiting for a train
- <thread> · <age> · train <nonce> built: <order>; gate dispatched
- <thread> · <age> · <incident: freeze, red base, backstop dispatched; what is being done>

## In progress

| Thread | Owns | State | Last report |
|---|---|---|---|
| <code> | <files or area> | <building / READY / train slot i / blocked on …> | <age> |

Stalls to act on: a lane with no report for longer than <N hours>, a READY older than
`FILL_HOURS` with no train, a slot call unanswered for longer than <N minutes>.
