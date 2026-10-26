/**
 * Tailwind reading for the design lint: utility class strings in HTML and
 * component files (class, className, :class, class:list and the cn/clsx/cva
 * helper calls), parsed into the facts the rules ask about (background and
 * text colours, gradients, sizes, tracking, case, families, variants).
 *
 * Ported from Nutlope/hallmark's sloplint.mjs (twParse, twInfo, twGroup and
 * kin; MIT, see NOTICE.md).
 */
import type { LintContext } from './context';
import { memo } from './context';

export interface TwStop { kind: 'token' | 'palette' | 'literal' | 'other'; hue: number | null; value: string }

/** What one element's class string says. */
export interface TwInfo {
  classes: string[];
  bg: string | null;
  text: string | null;
  stops: TwStop[];
  gradientText: boolean;
  sizePx: number | null;
  trackingEm: number | null;
  upper: boolean;
  smallCaps: boolean;
  mono: boolean;
  variants: Set<string>;
}

export interface TwItem {
  file: string;
  line: number;
  /** Tag index in the doc, or -1 for a helper-call site. */
  idx: number;
  tag: string;
  info: TwInfo;
}

export interface TwGroup { items: TwItem[]; variants: Set<string> }

/** Every class-bearing element and helper call in the context, parsed. */
export function twGroup(ctx: LintContext): TwGroup {
  return memo(ctx, 'tw', () => ({ items: [], variants: new Set<string>() }));
}

/** The Tailwind variants (hover, focus-visible, motion-reduce …) used anywhere in the context. */
export function twVariants(ctx: LintContext): Set<string> {
  return twGroup(ctx).variants;
}
