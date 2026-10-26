/**
 * The copy tier: gstack-design-craft's content-realism and ship-floor tells
 * (lib/design-craft.ts, Elaya-derived, MIT) under the lint's contract. The
 * craft check counts occurrences without positions, so these report at the
 * document's first line with the count as evidence until Phase 2 folds the
 * patterns into the lint. Tells the static tier already reports with a line
 * (transition: all under layout-transition, 100vh under vh-height) are left
 * to it.
 */
import { checkCraft } from '../../design-craft';
import type { LintContext } from '../context';
import type { Doc } from '../html';
import type { Reporter } from '../report';
import { ruleMeta } from './ids';

const STATIC_OWNS = new Set(['transition-all', 'vh-height']);

/** The elements the craft check reads from open tag to close tag with a lazy scan. */
const SPANNED = new Set(['script', 'style', 'template', 'nav']);

/** The page as the craft check reads it: an open script, style, template or nav tag that nothing closes after it is blanked, so each lazy scan to its close finds one and the page costs its length. */
function craftSource(doc: Doc): string {
  const lastClose = new Map<string, number>();
  for (const t of doc.tags) if (t.close && SPANNED.has(t.name)) lastClose.set(t.name, t.pos);
  let out = '', from = 0;
  for (const t of doc.tags) {
    if (t.close || !SPANNED.has(t.name) || t.pos < (lastClose.get(t.name) ?? -1)) continue;
    out += doc.src.slice(from, t.pos) + ' ';
    from = t.pos + 1;
  }
  return out + doc.src.slice(from);
}

export function run(ctx: LintContext, r: Reporter): void {
  for (const doc of ctx.docs) {
    if (doc.kind !== 'html') continue;
    for (const f of checkCraft(craftSource(doc))) {
      if (STATIC_OWNS.has(f.id) || !ruleMeta(f.id)) continue;
      const title = ruleMeta(f.id)!.title;
      r.report(f.id, doc.file, 1, f.count === 1 ? title : `${title}, ${f.count} times`, { fix: f.fix, source: 'copy' });
    }
  }
}
