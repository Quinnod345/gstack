# Changelog

## [Unreleased]

**/design-html builds landing pages around one visitor action and pages that look finished, without inventing proof; adapted from Elaya's design skills (GSTA-92).** Freeform /design-html asked for purpose, audience and feel, then built. It never asked for the one action the page exists for or where the traffic comes from, and nothing caught a page that shipped with invented customers and numbers, a dead `href="#"`, a scroll-listener reveal, `100vh`, or no description, favicon or working skip link. Now every run reads a craft section at Step 1, and a free checker counts the tells at Step 4. Adapted from Elaya's [ai-design-skills](https://github.com/elayadesign/ai-design-skills) (landing-page-design, design-to-motion) and [redesign-skill](https://github.com/elayadesign/redesign-skill), MIT, © 2026 Elaya. Thank you, Elaya.

### Changed
- **/design-html reads `sections/craft.md` on every run (Step 1).** The spec opens with `Surface: Persuade` or `Surface: other`. A Persuade page (landing, pricing, waitlist, campaign, comparison) asks at most three multiple-choice questions (primary action, traffic source, published or reference) and states the rest in one `Assumed:` line; picks one of four archetypes with a reason; keeps the hero budget (one proof signal only when real proof exists, never a metric row) and chooses the rest of the page from the archetype and objections; gives the primary action real invalid, pending, failure and success states. Every page: claims (testimonials, logos, results, prices, guarantees) come only from the user, and missing proof is left out or marked `[Needs proof: …]`; illustrative data looks real; a ship floor scoped to full documents (title, description, favicon, share tags on shareable pages, `og:image` only from a supplied URL, a skip link that reaches `<main>`, landmarks, alt text, inline validation, no dead links, `aria-current` on route navigation); scale snapping with readability floors and the nested-radius rule; balanced line breaks; motion rules for the one authored moment (content visible without script, `IntersectionObserver`, cheap properties only, no `scale(0)`, named curves, `100dvh`).
- **Step 4** runs `bin/gstack-design-craft` after the Slop Gate, whether or not the detector is installed, with the gate's contract: one fix pass, one rerun, the rest accepted with a reason, once more when the refinement loop ends. The hand-off opens with a "Before this can ship" block: proof markers, production dependencies, exceptions, and every claim the check changed.
- **/design-shotgun**: a landing, pricing or campaign screen's variants also differ in page archetype, keep the one primary action identical, and carry their section outline as a caption.

### Added
- **`bin/gstack-design-craft`** (`lib/design-craft.ts`): prints `CRAFT_CHECK: <id> <count> <fix>` per tell and `CRAFT_RESULT: clean` (exit 0) or `<n> issue(s)` (exit 1); exit 2 on a non-HTML, empty or unreadable file. Copy rules read decoded visible text; `alert()` counts only in scripts; head and navigation rules run only on a full document. Buzzwords report under the catalog's `marketing-buzzword` id.
- **NOTICE.md** and `licenses/MIT-elaya.txt`. Not carried over, because they conflict with gstack's design rules: Elaya's fixed fonts (Geist and Poppins are on gstack's overused-display list), palette, spacing values and icon sets, gradient hero text, mandatory scroll reveals and tagline section, and the island nav.

### Tests
- `test/design-craft.test.ts`: every tell with its count; a finished page, inlined Pretext, a `100vh` line with its `100dvh` fallback, discount copy and in-page anchors stay clean; look-alike attributes, encoded markers, `!important` and reversed fallbacks; skip links judged by position and target in any language; the craft section's banned words and names all flagged; CLI exit codes.
- `design-html-slop-gate` also requires the craft check to run once or twice; the design-html carve guard requires the craft section read.

## [1.91.216.0] - 2026-10-25

**/sync-gbrain refuses an active autopilot before it touches the brain's source list (#3360, part 2; ported from #3362 by @exGeni).** The code stage checked for a running `gbrain autopilot` only right before its destructive walk. By then it had already cleaned up legacy sources, renamed a source and run `gbrain sources add`, so a refused run still registered a source it never synced.

### Fixed
- **`bin/gstack-gbrain-sync.ts`**: the code stage runs the autopilot check before Step 0a, so a refusal leaves the source list untouched. The check before the walk stays, because autopilot can start while the steps in between run. Dry-run, read-only and deny policies and the local-engine skip still return earlier and are unchanged. Which processes count as an autopilot (the machine-wide probe, #3360 part 1) is unchanged.

### Tests
- `test/gstack-gbrain-sync.test.ts` runs the real script against a fake `gbrain` and a `pgrep` that reports an autopilot: the stage is refused and the fake saw no `sources add`, `rename`, `remove` or `sync`. On main the same run issues `sources add`.

## [1.91.215.0] - 2026-10-25

**An unattended `/ship` leaves its receipt in a file the parent can read, and the parent is told to read that file (GSTA-88).** Before, Step 18's handoff section wrote the ship receipt only to stdout, and `docs/unattended.md` told the parent to read it from the PR body with `gstack-ship-receipt read --pr <n> --json`. An unattended run must not push, so there is no PR: the parent got a usage error or `RECEIPT_MISSING`, or, if an older PR existed, read that PR's receipt with exit 0 and a stale `head`. Now the handoff writes `.gstack/tmp/ship-receipt.md`, the parent reads it with `read --body` in the child's checkout, and it compares the receipt's `head` to the branch SHA either way.
