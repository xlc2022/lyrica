/**
 * Which answers of a resource fetched again and again to show (useLoad). Each fetch gets the next number; an answer
 * shows when it is newer than the one shown, so one that comes back late never replaces a newer one, and a newer
 * fetch that is still on its way (or never comes back) never hides an answer that already did. `reset` starts over
 * for a different resource, whose earlier answers no longer count.
 */
export function answers() {
  let key = 0;
  let sent = 0;
  let shown = 0;
  return {
    reset() { key++; sent = 0; shown = 0; },
    /** A fetch starts: what its answer is checked with. */
    send(): { key: number; n: number } { return { key, n: ++sent }; },
    /** Its answer came back: whether to show it. */
    take(a: { key: number; n: number }): boolean {
      if (a.key !== key || a.n <= shown) return false;
      shown = a.n;
      return true;
    },
    /** Its error came back: shown only for the newest fetch, so an old failure never covers a newer answer. */
    latest(a: { key: number; n: number }): boolean { return a.key === key && a.n === sent; },
  };
}
