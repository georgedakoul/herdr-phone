/**
 * Failure counter for the login form. Pure logic, no clock of its own and no I/O, so the
 * tests can drive it without sleeping. A few free attempts cover a typo on a phone keyboard,
 * then the wait doubles until guessing is pointless. The wait is capped rather than being a
 * lock, because anything on the tailnet can fail on purpose and a real lock would let it shut
 * the owner out of their own app.
 */

export const GLOBAL = "\u0000global"

export function createGate({
  free = 3,
  base = 2000,
  cap = 5 * 60 * 1000,
  forget = 30 * 60 * 1000,
  max = 500,
  now = Date.now,
} = {}) {
  const seen = new Map()

  /** Runs on every write. Forgotten entries go first, then the oldest, so a forged key cannot grow the map. */
  function prune() {
    const cutoff = now() - forget
    for (const [key, entry] of seen) {
      if (entry.at <= cutoff) seen.delete(key)
    }
    while (seen.size > max) seen.delete(seen.keys().next().value)
  }

  return {
    /** Whole seconds, rounded up, so a caller told to wait 1s never comes back early. */
    check(key) {
      const entry = seen.get(key)
      if (!entry) return { ok: true }
      const left = entry.until - now()
      if (left <= 0) return { ok: true }
      return { ok: false, retryAfter: Math.ceil(left / 1000) }
    },

    /** `tripped` is true only on the attempt that starts a wait, which is what keeps the alert to one mail. */
    fail(key) {
      const at = now()
      const entry = seen.get(key) ?? { fails: 0, until: 0, tripped: false }
      seen.delete(key)
      entry.fails += 1
      entry.at = at
      let waitMs = 0
      let tripped = false
      if (entry.fails > free) {
        waitMs = Math.min(cap, base * 2 ** (entry.fails - free - 1))
        entry.until = at + waitMs
        tripped = !entry.tripped
        entry.tripped = true
      }
      // Re-inserted at the end, so map order stays oldest first for prune().
      seen.set(key, entry)
      prune()
      return { fails: entry.fails, waitMs, tripped }
    },

    /** The right password wipes the record. `hadTripped` says someone got in after guessing. */
    pass(key) {
      const entry = seen.get(key)
      seen.delete(key)
      return { hadTripped: Boolean(entry?.tripped) }
    },

    get size() {
      return seen.size
    },
  }
}
