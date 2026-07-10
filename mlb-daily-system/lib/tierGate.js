// Content-tier boundary, structured now, enforced later. PAYWALL_ENABLED
// (env, default false/unset) is the single switch: while it's off, every
// authenticated request sees the full digest payload regardless of tier,
// exactly as today. When it's flipped on, member-only sections of the
// digest (the full moneyline field, hit/strikeout prop research) get
// replaced with a `gated: true` marker for anyone who isn't tier=member
// or role=admin. No Stripe, no checkout, no signup wall here — that's
// explicitly out of scope for this pass; this only decides what a given
// viewer's /api/digest response contains.
//
// FREE surface (kept, always): the published moneyline pick(s)
// (lockedMoneyline), the schedule/games, and the public record — none of
// those live inside `digest` in the first place, so nothing here needs to
// touch them.
export function paywallEnabled() {
  return String(process.env.PAYWALL_ENABLED || '').toLowerCase() === 'true';
}

export function canSeeMemberContent(user) {
  if (!paywallEnabled()) return true;
  return Boolean(user && (user.tier === 'member' || user.role === 'admin'));
}

// Mutates nothing; returns a new object with member-only fields swapped
// for a gated marker when the viewer can't see them.
export function applyTierGate(digest, user) {
  if (canSeeMemberContent(user)) return digest;
  const gatedList = () => ({ gated: true });
  return {
    ...digest,
    moneyline: { ...digest.moneyline, picks: [], otherGames: [], ...gatedList() },
    hitStreak: { ...digest.hitStreak, watchList: [], ...gatedList() },
    strikeouts: { ...digest.strikeouts, watchList: [], ...gatedList() },
  };
}
