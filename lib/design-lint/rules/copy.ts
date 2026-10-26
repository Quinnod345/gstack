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
import type { Reporter } from '../report';
import { ruleMeta } from './ids';

const STATIC_OWNS = new Set(['transition-all', 'vh-height']);

export function run(ctx: LintContext, r: Reporter): void {
  for (const doc of ctx.docs) {
    if (doc.kind !== 'html') continue;
    for (const f of checkCraft(doc.src)) {
      if (STATIC_OWNS.has(f.id) || !ruleMeta(f.id)) continue;
      const title = ruleMeta(f.id)!.title;
      r.report(f.id, doc.file, 1, f.count === 1 ? title : `${title}, ${f.count} times`, { fix: f.fix, source: 'copy' });
    }
  }
}
