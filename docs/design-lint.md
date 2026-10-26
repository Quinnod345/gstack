# design-lint: the free, deterministic design check

`bin/gstack-design-lint` reads a page (or a directory of pages, stylesheets
and components) and prints every machine-checkable design tell it finds, with
a file and line, in under a second. With `--render` it also measures the page
in gstack's own browser: the fold, the word budget per screen, contrast
against the painted pixels, focus rings by tabbing, crowded headings, text
painted under other elements, the share of the page that is photographs.
Nothing is installed and nothing is paid for: the static tier is TypeScript
over the files, and the render tier drives the same engine `gstack-render`
picks (Aside when it is running, otherwise the browse daemon `./setup` built).

The rules are ported from [Nutlope/hallmark](https://github.com/Nutlope/hallmark)'s
`sloplint` (MIT; see NOTICE.md and licenses/MIT-hallmark.txt), rewritten in
gstack's voice and mapped onto gstack's severity words. The copy tier is
`gstack-design-craft`'s content-realism and ship-floor check under the same
contract. Phase 1 (this document) is the tool alone; /design-html and
/design-review call it in Phase 2.

## Usage

```
gstack-design-lint <file-or-dir ...> [--render] [--url <http://…>] [--scope page|component] [--job <job>] [--json] [--rules]
```

- Reads `.html`, `.css`, `.jsx`, `.tsx`, `.vue`, `.svelte` and `.astro`.
  Tailwind class strings in components are read too, including `cn()`,
  `clsx()`, `cva()` and their kin. `node_modules`, dot folders and build
  output below the top level are skipped.
- A page is linted with the stylesheets it links (`<link rel=stylesheet>`,
  `@import`, and anything they reach); a directory of components shares the
  project's tokens and global state styles, so a focus ring declared once in
  `globals.css` is not reported missing on every component.
- `--render` measures every HTML page found; `--url` measures a running dev
  server (and implies `--render`). When no browser is available the render
  tier is skipped and the summary says why.
- `--scope component` skips the page-only rules (the nav, the footer, the
  eyebrow, section gaps, the wireframe count) when linting a component alone.
- `--job <job>` names what the visitor came to do (`book`, `buy`,
  `subscribe`, `attend`, `visit`, `hire`, `listen`, `join`, `try`,
  `sign up`): an email sign-up as the page's close is only a finding when the
  job is not one where a mailing list is native.
- `--json` prints `{ summary, files, findings }`; `--rules` prints the table below.

## Output

One line per finding, then one summary line:

```
LINT: <blocks|ask|polish|waived> <rule-id> <file>:<line> <evidence> | fix: <fix>
LINT_SUMMARY: blocks=N ask=N waived=N polish=N render=<ran|skipped: reason>
```

Exit **2** when anything blocks, **1** when an ask is unanswered, **0**
otherwise (**3** on a usage error). Findings sort blocks, ask, waived, polish,
then by rule, file and line.

## Tiers

The lint uses gstack's severity words, not a fourth scale:

| Tier | Meaning | hallmark's word |
|---|---|---|
| **blocks** | Never waivable. Correctness, access, honesty and the bans: a card in a card, a purple-blue gradient, a missing focus ring, contrast under threshold, a reveal that hides content until JavaScript runs. | Floor |
| **ask** | A default a model falls into. Fix it, or waive it on the record with a reason about this page. | Reflex |
| **polish** | Craft detail invisible at arm's length. Printed, never blocks. | Finish |

`waived` marks an ask or polish finding a waiver answered. **Blocking and
waived are never summed**: `blocks=0` is always a true sentence about the
Floor. Three house rules hallmark holds at Floor stay at ask here on purpose:
the eyebrow (`kicker-above-heading`; a figure caption or a plan name above a
heading is often right), the 80-word screen (`screen-word-budget`; a Read-mode
page legitimately exceeds it) and the dash (`em-dash-overuse`; gstack's rule is
overuse, not a ban). A blocking rule the lint can only *suspect* (an invented
metric it cannot prove invented) reports at ask so a person confirms it.

## Waivers

A finding is answered in a comment that names the rule and gives a reason
about this page:

```html
<!-- gstack-lint-disable kicker-above-heading: the chapter number is the reader's bookmark through a forty-page spec -->
```
```css
/* gstack-lint-disable section-gap: the ledger separates its rows with rules, not air */
```
```tsx
// gstack-lint-disable template-nav: the three links are the product's three modes
```

`impeccable-disable <rule>: <reason>` is accepted as an alias, so a comment
that already silences the impeccable engine answers the same tell here. The
lint refuses, each as its own `waiver` finding at ask: a rule it does not
know; a **blocking** rule (the Floor is never waivable); a reason under 24
characters, boilerplate ("by design", "intentional", "looks better"), reused
word for word on another waiver, or sharing no word of four letters or more
with the page's own text; a second waiver of one rule. More than three waivers
on one page is a house style and belongs in DESIGN.md: reported once at polish
as `house-style`.

## Rules

| Rule | Tier | Source gate | The tell | The fix |
|---|---|---|---|---|
| `purple-blue-gradient` | blocks | 2a | purple-to-blue, purple-to-pink or cyan-on-dark gradient | one anchor hue and solid ink |
| `gradient-text` | ask | 2b | gradient text | solid ink; carry emphasis with weight or a display face |
| `pure-black-white` | blocks | 7a | #000 or #fff as a colour outside the token block | tint toward the anchor hue: chroma 0.005 or more |
| `absolute-surface-token` | ask | 7b | a surface token that resolves to pure black or white | tint the paper |
| `zero-chroma-neutrals` | ask | 22 | zero-chroma neutrals on a page with an anchor hue | give the neutrals chroma 0.005 or more |
| `accent-footprint` | ask | 23 | accent colour past about 5% of a viewport | retreat the accent to actions and one signal |
| `glow-wash` | ask | 29 | glow and wash: blurred orbs, a radial halo or a zero-offset coloured glow | a solid or grained surface; elevation by lightness, shadows with offset and blur |
| `cream-palette` | ask | 65 | the cream paper, serif display and terracotta accent look | move one axis: the accent first, the paper second, the display last |
| `framework-palette` | ask | 74 | a framework default palette (Tailwind indigo-500, slate-900 and kin) as a token or utility | a colour mixed for the page in OKLCH |
| `overused-font` | ask | 1 | Inter, Roboto, Open Sans, Poppins, Lato or a system face as the display | a display face chosen for the page |
| `line-length` | ask | 25 | running prose outside 45 to 75 characters a line | max-width: 65ch |
| `font-family-count` | ask | 37 | more than three font families | display, body and one outlier |
| `italic-word-in-heading` | blocks | 38i | one italic word inside an otherwise roman heading | a line break, or the whole head set one way |
| `italic-serif-display` | ask | 38ii | an italic display system | roman display, or declare it on --font-display with font-synthesis: none |
| `accented-word` | ask | 38iii | one word in a heading set apart by colour, weight, a highlight or an underline | the whole head one way; a line break; a second line at a second size |
| `caps-leading` | blocks | 55a | an uppercase display head that can wrap with line-height under 1.0 | line-height 1.0 at least (1.02 to 1.08 recommended) |
| `caps-lockup-leading` | ask | 55b | a single-line caps lockup under 1.02 | line-height 1.02, or make sure it cannot wrap at 320px |
| `monospace-costume` | ask | 64 | monospace on labels, captions or small type when the content is not code | labels in the body face, a step smaller, normal case |
| `tiny-text` | ask | 75 | running text under 12px, functional text under 11px, or prose leaded under 1.3 (render) | body 16px at 1.5 to 1.65; labels one step smaller |
| `wide-tracking` | blocks | 67 | the tracked-caps label: small text set uppercase or letter-spaced past 0.03em | the body face, a step smaller, sentence case, untracked |
| `template-cards` | ask | 3 | three equal icon-above-heading tiles, an icon in a rounded tile, or a thick coloured side stripe | vary widths and heights, inline icons, hairline or no border |
| `nested-cards` | blocks | 4 | a card inside a card | one containment layer |
| `vh-height` | blocks | 6a | a hero sized in vh | dvh or svh |
| `raw-spacing` | blocks | 24a | a raw padding, margin or gap length where a --space-* token exists | the token |
| `off-scale-spacing` | ask | 24b | spacing off the page's scale | the scale; three optical nudges at most |
| `overflow-x-unclipped` | ask | 34 | overflow-x missing on html and body, or a 100vw width | overflow-x: clip on both; width: 100% |
| `horizontal-scroll` | blocks | 34 | horizontal scroll at a width between 320 and 1920 (render) | find the element wider than its viewport and cap it |
| `hero-balance` | ask | 44a/44c | the hero's content sits off centre for its screen, or its visual stands apart from the text (render) | centre the content in its screen; put the visual beside the text |
| `hero-fold` | blocks | 44b | headline, lede, primary action and visual not all visible at 1280x800 (render) | pull the display clamp down, tighten leading, a two-line lede, trim padding |
| `wide-container` | blocks | 44d | at 1920x1080 the container has no max-width, gutters under 120px, or a grid gains columns | cap 1360 to 1520px and centre; hold column counts; cap vw visuals |
| `bare-fr-track` | blocks | 50 | an image-bearing grid track on bare 1fr | minmax(0, 1fr) |
| `display-head-unwrapped` | blocks | 50 | a display head without overflow-wrap: break-word and min-width: 0 | overflow-wrap: break-word; min-width: 0 (never anywhere) |
| `radio-tab-jump` | blocks | 53 | CSS-only radio tabs at position: absolute; top: 0 with no JS guard | radios in flow at zero size, or a handler with preventScroll |
| `double-sticky` | blocks | 56 | two position: sticky; top: 0 elements | top: var(--banner-height) on the second |
| `screen-word-budget` | ask | 58 | more than about 80 words in one 900px window, or a hero with more than two text blocks before its actions | headline, one sentence, actions; a section is a head block, then its composition |
| `section-gap` | ask | 59 | a gap under 120px between sections, or every gap the same | 120px at least, varied |
| `heading-rhythm` | ask | 71 | a heading nearer what precedes it than what it heads (render) | at least twice the space above a head as below it |
| `cramped-padding` | ask | 72 | text closer than 8px (or half an em) to the side of its filled box (render) | pad the box; a 16px gutter |
| `thin-section` | ask | 77 | a section below the hero with no mass: a narrow body on a wide canvas (render) | widen the body, add a visual, set a statement, or merge the section |
| `small-section-heads` | ask | 78 | the median h2 below the hero renders under 40px at 1440 (render) | h2 at the section size, item titles at the title size |
| `dead-band` | ask | 79 | more than 160px of nothing between the hero's lowest content and the fold (render) | centre the content and grow the visual or the head; never fill with copy |
| `hand-drawn-svg` | ask | 80 | an inline SVG of 120px or more with three curves or fills and no text: a drawn illustration (render) | a photograph, the product built, or type at scale |
| `empty-picture` | ask | 81 | a slot or gradient block of 300x200px or more showing nothing but its wash (render) | the user's image, a credited photograph, or the product at full fidelity |
| `counting-marks` | ask | 82 | 24 or more identical marks standing for a quantity (render) | set the number in type |
| `photo-wall` | ask | 83 | photographs cover more than a third of the page below the hero (render) | keep the strongest pictures, set big; carry the rest in type, figures, the product, a table |
| `email-band-close` | ask | 85 | the page ends on an email sign-up form on a page whose job is not subscribe, join, attend, listen or visit | end on what the visitor came to do, or on the last strong section |
| `aphoristic-cadence` | blocks | 19 | the rebuttal cadence three or more times ("Not a feature. A platform.") | say what the product does, in its own nouns |
| `generic-hero-copy` | blocks | 19 | a filler opener ("Built for the modern team", "In today's landscape") or "quietly trusted by" | say what the product does, in its own nouns |
| `generic-cta-copy` | ask | 19/42 | a stock second action beside the primary (Learn more, Get started, Book a demo) | one action, or a second that names where it goes |
| `em-dash-overuse` | ask | 19 | em or en dashes carrying the prose | a comma, a colon, a full stop or a line break |
| `template-footer-line` | ask | 19 | a stock footer line (All rights reserved) | the page's own line, or nothing |
| `template-nav` | ask | 42 | the reflex nav: wordmark left, inline links, a button right, hairline under | decide the nav and build another shape, or keep it on the record |
| `template-footer` | ask | 42 | the reflex footer: four link columns, a social row, a copyright | decide the footer and build another shape, or keep it on the record |
| `invented-proof` | blocks | 46a | an invented metric, testimonial, logo wall or case-study count | the user's number, a text slot, or nothing |
| `drawn-browser-chrome` | blocks | 47a | a hand-drawn browser bar (traffic lights, URL pill) or OS window title bar | a real screenshot in a <figure>, or no chrome |
| `device-frame` | ask | 47b | a phone, laptop, terminal or editor frame | one frame with real content inside, or none |
| `imitation-material` | ask | 47c | styled divs standing in for a product, a photo edge or a physical object | the product built inside a slot, a real asset, or nothing |
| `kicker-above-heading` | ask | 54 | the eyebrow: short inert type before a heading that only announces it | open the section another way; where the heading is figurative, the label becomes the heading |
| `template-punctuation` | blocks | 63 | template punctuation: middle-dot meta strings, an arrow glued to link text, decorative status dots | line breaks, columns, hairlines; a verb as the label |
| `wireframe-slots` | ask | 68 | more than five empty slots on one page, or four or more in one row | set the set in type; a slot that stays holds a real photo or the product |
| `repeated-fact` | ask | 69 | one fact (a price, a time, a count) printed in four or more sections | say each fact once, where it does work |
| `fake-send` | blocks | 70 | a form that prints success with no request behind it | validate, post nowhere and say so plainly until the endpoint exists |
| `layout-transition` | blocks | 10a | transition: all, or animating width, height, top or left | list the properties; transform and opacity |
| `spacing-transition` | ask | 10b | transitioning margin or padding | transform |
| `hover-tells` | ask | 11 | the same lift on every card, two effects on one element, an image scaling on hover, or a hover on something inert | one signal per element, on the container, not the image |
| `bounce-easing` | ask | 12 | bounce or overshoot easing on UI state | an exponential ease-out |
| `focus-ring-fade` | blocks | 15 | a focus ring that fades in | instant: exclude outline and box-shadow from the transition |
| `tooltip-focus-delay` | blocks | 17 | a tooltip whose focus delay equals its hover delay | hover 800 to 1000ms, focus 0 |
| `autorotate-no-pause` | blocks | 18 | auto-rotating content with no pause on hover and focus | pause on hover and focus; a visible pause control past 5 seconds |
| `missing-focus-visible` | blocks | 26a | an interactive element with no :focus-visible ring, or an outline removed with nothing in its place | a ring at 3:1 or better, instant |
| `missing-states` | ask | 26b | no :active or :disabled state | all the states a control can be in |
| `missing-reduced-motion` | blocks | 27 | a keyframe or transform transition without a prefers-reduced-motion fallback | add @media (prefers-reduced-motion: reduce) |
| `autoplay-unmuted` | blocks | 28a | a video autoplaying without muted | autoplay muted loop playsinline |
| `lazy-lcp` | blocks | 28a | loading="lazy" on the first image | fetchpriority="high" on the LCP image |
| `video-without-poster` | ask | 28b | a video without poster or a priority hint | add them |
| `input-state-shift` | blocks | 39a | input states that break: a border that changes width, a focus ring built from border, disabled by opacity alone | constant border, outline, shared height, three disabled channels |
| `control-height` | ask | 39b | control height outside 44 to 52px on a marketing page | the number |
| `content-hidden-at-rest` | blocks | 62 | a reveal class hiding content until JavaScript runs | visible by default; hide only under a .js class, or animate from visible with @starting-style |
| `emoji-decoration` | blocks | 30a | an emoji standing in for an icon | one icon library, custom SVG, or typography |
| `two-icon-libraries` | ask | 30b | two icon libraries on one page | one library |
| `unlabeled-decoration` | blocks | 33 | a decorative <svg>, <canvas> or CSS-art element with neither aria-hidden="true" nor a label | hide it or name it |
| `broken-image` | blocks | 76 | an <img> with no source or one that does not load | the real file |
| `stock-photo-hotlink` | blocks | 76 | a stock-site photo hotlink | the user's image, or a library photograph credited on the page |
| `text-occlusion` | blocks | 73 | text painted under another element (render) | give the text its own space, or its own surface above the cover |
| `low-contrast` | blocks | 40 | text, an icon, a focus ring or a field edge under its contrast threshold | fix the pair; body 4.5:1, large text and edges 3:1 |
| `gray-on-color` | blocks | 41 | button text within a step of its fill, or grey text on a coloured surface | the paired ink token |
| `literal-outside-tokens` | blocks | 48 | a colour or font-family literal outside the token block | lift it into the tokens |
| `button-label-wraps` | blocks | 49a | a button label or primary nav link that wraps | shorten it; white-space: nowrap |
| `link-wraps` | ask | 49b | a footer link, tab or breadcrumb that wraps | shorten it |
| `straight-quotes` | polish | F1 | straight quotes in prose | curly quotes |
| `three-dot-ellipsis` | polish | F2 | three dots for an ellipsis | the ellipsis character |
| `balanced-display-head` | polish | F3 | a display head without text-wrap: balance | text-wrap: balance |
| `two-primary-buttons` | polish | F4 | two filled primary buttons on one page, or side by side | one filled primary; the second as a text or outline action |
| `icon-coin` | polish | F5 | an icon in a coloured coin | the icon inline, bare |
| `display-figures-tabular` | polish | F6 | display-size figures without tabular numerals | font-variant-numeric: tabular-nums |
| `stamped-recipe` | polish | F7 | one container recipe stamped on six or more selectors, or the pill radius on five or more non-controls | vary the recipe; pills on controls, tags and badges only |
| `scroll-choreography-mix` | polish | F8 | more than one scroll-choreography pattern | one pattern a page |
| `fake-avatar` | blocks | F9 | a fake-human avatar hotlink | the user's people, initials, or no portrait |
| `stock-person-photo` | polish | F9 | a person-keyword stock photo URL | the user's photograph |
| `page-invariants` | polish | F15 | page invariants broken: primary button style, container width, column gap or radius drifting | one recipe for each |
| `unthemed-browser-surfaces` | polish | F16 | no ::selection, caret-color or scrollbar-color on a page with a committed palette | theme the browser surfaces |
| `text-sliver` | polish | F17 | a text block squeezed into a sliver at 1440 (render) | give the block room or merge the columns |
| `tiny-slot` | polish | F18 | a slot rendering under 40px in either dimension (render) | size the slot for what it will hold |
| `font-weight-count` | polish | F19 | more than three font weights in running use (render) | three weights |
| `lonely-grid-item` | polish | F20 | a grid or wrapping row leaving one item alone on its last row (render) | change the count or the columns |
| `skipped-heading` | polish | F21 | a heading level skipped | step the levels one at a time |
| `justified-text` | polish | F22 | justified text without hyphens: auto | hyphens: auto, or left-aligned |
| `missing-lang` | polish | F23 | a document without lang | lang on <html> |
| `hairline-under-shadow` | polish | F24 | a hairline border under a wide soft shadow on one surface | the shadow or the border, not both |
| `placeholder-name` | blocks | craft | a placeholder name (John Doe) | use a supplied name, or one that fits the product in sample data |
| `placeholder-brand` | blocks | craft | a placeholder brand (Acme, Nexus) | use a supplied customer, or a fitting name in sample data |
| `lorem` | blocks | craft | lorem ipsum placeholder text | write real copy |
| `marketing-buzzword` | ask | craft | a marketing buzzword | say the specific thing |
| `round-number` | blocks | craft | a round invented number | use the supplied figure, or drop the claim |
| `needs-proof` | blocks | craft | a [Needs proof] marker left in the page | supply the proof or remove the claim before publishing |
| `oops` | ask | craft | "oops" as an error message | say what happened and what to do |
| `scroll-listener` | ask | craft | a scroll event listener | use IntersectionObserver; read scroll inside requestAnimationFrame for a scroll-linked effect |
| `dead-link` | ask | craft | a dead link (href="#") | link it, or render the control disabled |
| `alert` | ask | craft | alert() for a message | show the message inline |
| `img-no-alt` | blocks | craft | an <img> without alt | add alt text (alt="" when decorative) |
| `missing-title` | blocks | craft | a document without a <title> | add a <title> |
| `missing-meta-description` | ask | craft | no meta description | add <meta name="description"> |
| `missing-favicon` | polish | craft | a document without a favicon | add a favicon <link rel="icon"> |
| `missing-skip-link` | ask | craft | no skip link reaching <main> | add a "Skip to content" link first in <body> whose #id exists on <main> |
| `missing-aria-current` | ask | craft | route navigation without aria-current | mark the current nav link aria-current="page" |

Source gates are Nutlope/hallmark `references/gates.md` at 7ec8682; `craft`
marks a rule carried over from `gstack-design-craft` (Elaya-derived). Three
ids are the lint's own: `waiver` (a refused waiver, ask), `house-style` (more
than three waivers, polish) and `render` (a page that did not render, blocks:
an unrendered page is never a pass).

## What is deliberately not ported

hallmark's theme stamp (the CSS comment that declares a theme, a posture and a
hero shape) and every guard that reads it; the genre flag; the judged gates
(the AI template shape, section rhythm, hover by judgement, toasts, the
reviews); the `--before` / `--kept` redesign record (Phase 2); the photo index.
