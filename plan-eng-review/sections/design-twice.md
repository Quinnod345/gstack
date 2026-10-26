<!-- AUTO-GENERATED from design-twice.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
<!-- "Design it twice" and the red flags derive from pstack's architect skill (Lauren Tan, MIT), rewritten for gstack. See NOTICE.md. -->
## Two shapes before one

Use this inside Section 1 (Architecture review) when the plan introduces a
new module, service, package or boundary: a public surface other code calls.

### Ask for the second shape

A plan with one design usually took the first shape that compiled in the
author's head. Before judging it, require a second shape that is structurally
different: another owner for the state, another split of responsibilities,
another place for the boundary. A point fix inside the first shape is not a
second candidate. When the plan has none, sketch one in five lines (types and
signatures, bodies `not implemented`) and record it as the alternative.

Compare the candidates on interface depth: how much behavior and policy each
hides behind how small a public surface, and prefer the one that hides more
behind less. A deep module is not a deep call chain: the chain scatters the
understanding across layers, the module concentrates it behind one interface.

### The eight red flags

Screen the chosen shape before Section 1 closes. Assume the next contributor
is an agent that sees only the files it opened, copies the nearest example
and takes the shortest path that compiles; prefer the design where a change
that looks right from one file is right for the whole repo. A flag is a
finding with a file or symbol and a reason to revise the shape, not a comment
asking for care.

1. **Shallow module.** A large interface over little hidden complexity:
   several calls per operation, options that expose internal stages.
2. **Information leakage.** One decision (a representation, a policy, a wire
   or storage detail) lives in more than one module. Re-exported transport
   types are leakage; parse external data into domain types at the boundary.
3. **Temporal decomposition.** Modules split by execution order (load,
   validate, transform, save) instead of by the knowledge they own.
4. **Pass-through method.** A function that forwards the same arguments to
   another with the same shape; remove it or move the responsibility.
5. **Split ownership.** Two modules write the same state or each keep a copy;
   an agent editing one cannot see the other. One owner per piece of state.
6. **Two ways to do one task.** An agent copies whichever it meets first.
   Keep one; move the callers and delete the rest in the same change.
7. **Importable internals.** The shortest path that compiles imports them and
   they become interface. Make an outside import fail the build.
8. **Hand-synced list.** The same items in two places; an agent that sees one
   list edits one. Derive the second, or fail the build when they disagree.

Record under Architecture: both shapes, the pick, the depth argument for it,
and each flag with its fix.
