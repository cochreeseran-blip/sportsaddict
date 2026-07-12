// Test 8 from the admin-dashboard build spec: the email send path refuses
// to send when a required compliance element (the unsubscribe link) is
// missing from the actual rendered HTML. checkComplianceRequirements is
// the exact gate sendAdminEmail runs before ever calling Resend (see
// lib/adminEmail.js sendAdminEmail), so exercising it directly against
// rendered output — including output with the unsubscribe block stripped
// out — proves the refusal without needing a live Resend key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderComplianceFooter, checkComplianceRequirements } from '../lib/emailCompliance.js';

process.env.ADMIN_POSTAL_ADDRESS = '123 Test St, Testville, TS 00000';

test('8a. A fully rendered email (with compliance footer) passes the check', () => {
  const html = `<html><body><p>hello</p>${renderComplianceFooter('https://slatefinder.lol/unsubscribe-marketing?token=abc')}</body></html>`;
  const result = checkComplianceRequirements(html);
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
});

test('8b. Removing the unsubscribe link from the rendered output is refused', () => {
  const footer = renderComplianceFooter('https://slatefinder.lol/unsubscribe-marketing?token=abc');
  // Strip just the unsubscribe <p> line, leaving the rest of the footer
  // (postal address, disclaimers) intact -- proves the check is actually
  // looking for the unsubscribe element specifically, not just "some
  // footer was rendered".
  const footerWithoutUnsubscribe = footer.replace(/<p[^>]*><a[^>]*>Unsubscribe from this list<\/a><\/p>/i, '');
  assert.ok(!/unsubscribe/i.test(footerWithoutUnsubscribe), 'test fixture sanity check: unsubscribe text must actually be gone');

  const html = `<html><body><p>hello</p>${footerWithoutUnsubscribe}</body></html>`;
  const result = checkComplianceRequirements(html);
  assert.equal(result.ok, false);
  assert.ok(result.missing.includes('unsubscribe link'));
});

test('8c. Removing the postal address is refused', () => {
  const html = `<html><body><p>hello</p><a href="https://x/unsubscribe-marketing?token=abc">Unsubscribe from this list</a><p>Research signals only. Not betting advice.</p><p>21+. Gambling problem? Call 1-800-GAMBLER.</p></body></html>`;
  const result = checkComplianceRequirements(html);
  assert.equal(result.ok, false);
  assert.ok(result.missing.some((m) => m.includes('postal address')));
});

test('8d. Removing the gambling disclaimer is refused', () => {
  const html = `<html><body><a href="https://x/unsubscribe-marketing?token=abc">Unsubscribe from this list</a><p>123 Test St, Testville, TS 00000</p><p>Research signals only. Not betting advice.</p></body></html>`;
  const result = checkComplianceRequirements(html);
  assert.equal(result.ok, false);
  assert.ok(result.missing.includes('"21+. Gambling problem? Call 1-800-GAMBLER."'));
});
