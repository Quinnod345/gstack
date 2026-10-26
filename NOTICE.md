# Third-Party Notices

gstack is MIT. The files below contain material derived from Apache-2.0 and MIT
works, rewritten in gstack's voice and modified. Rewriting is not an exemption:
the license texts are in `licenses/`, and each file derived from an Apache-2.0
work carries a notice that it was changed. Unmodified copies (the rule-registry fixture, the
license text) carry no header and are listed here instead.

## impeccable — Copyright Paul Bakaus — Apache License 2.0

https://github.com/pbakaus/impeccable

Derived, modified:

- `lib/design-catalog.ts`: rule ids and names from `crates/live/assets/antipatterns.json`; the prose is gstack's.
- `scripts/resolvers/design.ts`: the Persuade / Operate / Read / Experience visitor modes, the craft-floor reflexes (browser surfaces, one authored motion moment, depth has an offset, tinted secondary text, space above headings, light-or-dark from the use scene), and the three-looks calibration, from `SKILL.md`, `reference/craft-floor.md`, and `reference/new-work.md`, rewritten.
- `design-consultation/sections/proposal-and-preview.md.tmpl`: the font-selection procedure and the calibration paragraph, rewritten; and the `SKILL.md` / `sections/*.md` files generated from these sources.

Unmodified copy:

- `test/fixtures/impeccable-antipatterns.json`: `crates/live/assets/antipatterns.json` at commit 87d8f6d6 (engine-v0.1.3), wrapped in a `_source` provenance object.

Not distributed: `bin/gstack-design-detect.ts` invokes an impeccable engine the
user installed. gstack does not ship or mirror that engine and never runs impeccable's
installer or launcher. The one download gstack can make is the engine binary
itself, only after the user accepts a design skill's one-time offer: fetched from
impeccable's own GitHub release into `~/.impeccable/bin/<version>/`, verified
against the checksum pinned in `lib/design-detect-contract.ts`, and recorded in
the egress ledger first. gstack does not audit the engine's network behavior; the
wrapper refuses URL targets so gstack never asks it to touch the network.

## ai-design-skills and redesign-skill — Copyright (c) 2026 Elaya — MIT License

https://github.com/elayadesign/ai-design-skills (`skills/landing-page-design`,
`skills/design-to-motion`, at 38bbe576) and
https://github.com/elayadesign/redesign-skill (`skills/redesign-existing-projects`,
at 64627f6e). License text: `licenses/MIT-elaya.txt`.

Derived, modified (rules rewritten in gstack's voice and reconciled with its
design rules; Elaya's fixed fonts, colors, spacing values, icon sets and
signature components are not carried over):

- `design-html/sections/craft.md.tmpl`: the Persuade intake, page archetypes,
  page structure, conversion and copy rules, indexing and build order from
  landing-page-design Part A; the content-realism, ship-floor, scale-snapping,
  line-break and motion rules from landing-page-design Part B, the website
  context of design-to-motion and the redesign-skill audit; and the generated
  `design-html/SKILL.md` / `sections/craft.md`.
- `lib/design-craft.ts` and `bin/gstack-design-craft`: the content-realism and
  ship-floor tells, turned into a free check.
- `design-shotgun/SKILL.md.tmpl`: page archetypes as a variant axis.

## DESIGN.md specification — Copyright Google LLC — Apache License 2.0

https://github.com/google-labs-code/design.md

`lib/design-md.ts`, `bin/gstack-design-md.ts`, and the Phase 6 template in
`design-consultation/sections/proposal-and-preview.md.tmpl` implement the
format (YAML token front matter in five groups, eight canonical sections in
spec order, `{path}` token references). No specification text is reproduced.
