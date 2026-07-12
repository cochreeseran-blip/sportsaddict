// Test 9 from the admin-dashboard build spec: with PAYWALL_ENABLED=false
// (the shipped default), a free-tier user reaches every research surface
// -- applyTierGate must be a complete no-op, not just "mostly" unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// PAYWALL_ENABLED must be unset/false BEFORE lib/tierGate.js is imported
// (paywallEnabled() reads process.env directly on each call, not at
// import time, but we set it here regardless so this file's intent is
// explicit and order-independent).
delete process.env.PAYWALL_ENABLED;

const { paywallEnabled, canSeeMemberContent, applyTierGate } = await import('../lib/tierGate.js');

const sampleDigest = {
  moneyline: { picks: [{ id: 1 }, { id: 2 }], otherGames: [{ id: 3 }] },
  hitStreak: { watchList: [{ id: 4 }, { id: 5 }] },
  strikeouts: { watchList: [{ id: 6 }] },
  schedule: [{ id: 7 }],
};

test('9a. PAYWALL_ENABLED is off by default', () => {
  assert.equal(paywallEnabled(), false);
});

test('9b. A free-tier (or anonymous) user can see member content while the paywall is off', () => {
  assert.equal(canSeeMemberContent({ tier: 'free', role: 'user' }), true);
  assert.equal(canSeeMemberContent(null), true);
});

test('9c. applyTierGate is a no-op for a free-tier user while the paywall is off', () => {
  const gated = applyTierGate(sampleDigest, { tier: 'free', role: 'user' });
  assert.deepEqual(gated, sampleDigest);
  assert.equal(gated.moneyline.gated, undefined);
  assert.equal(gated.hitStreak.gated, undefined);
  assert.equal(gated.strikeouts.gated, undefined);
  assert.equal(gated.moneyline.picks.length, 2);
  assert.equal(gated.hitStreak.watchList.length, 2);
});

test('9d. applyTierGate is also a no-op for a signed-out (null) viewer while the paywall is off', () => {
  const gated = applyTierGate(sampleDigest, null);
  assert.deepEqual(gated, sampleDigest);
});

test('9e. sanity: with the paywall flipped on, a free user WOULD be gated (proves the flag actually does something)', () => {
  process.env.PAYWALL_ENABLED = 'true';
  try {
    const gated = applyTierGate(sampleDigest, { tier: 'free', role: 'user' });
    assert.equal(gated.moneyline.gated, true);
    assert.equal(gated.moneyline.picks.length, 0);
  } finally {
    delete process.env.PAYWALL_ENABLED;
  }
});
