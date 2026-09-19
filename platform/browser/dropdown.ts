/** Browser-only UI predicates. No DOM access, so they are usable from SSR and tests. */

/**
 * Whether a dropdown anchored at `index` should open upward instead of downward.
 *
 * The first two rows always open downward — a menu above them would clip at the top of the
 * viewport instead — and a list of two or fewer items has nothing to clip.
 */
export function shouldDropdownOpenUp(index: number, totalLength: number): boolean {
  return totalLength > 2 && index >= 2
}
