// CAN-SPAM / deliverability gate for every outbound email. The four
// required elements are checked against the RENDERED html, not against
// the template source, so a template edit that drops one of them is
// caught at send time no matter how it happened. The send paths
// (admin compose in server.js, daily digest in newsletter.js) call
// verifyEmailCompliance and hard-refuse on any failure; there is no
// bypass flag.

export const REQUIRED_DISCLAIMER = 'Research signals only. Not betting advice.';
export const REQUIRED_GAMBLING_LINE = '21+. Gambling problem? Call 1-800-GAMBLER.';

// Returns { ok: boolean, missing: string[] }. unsubscribePath is the
// substring the rendered unsubscribe href must contain (the route that
// flips consent off), postalAddress is the physical address that must be
// rendered into the footer.
export function verifyEmailCompliance(html, { unsubscribePath, postalAddress }) {
  const missing = [];
  const body = String(html || '');

  if (!unsubscribePath || !body.includes(unsubscribePath)) {
    missing.push('one-click unsubscribe link');
  }
  if (!postalAddress || !postalAddress.trim() || !body.includes(postalAddress.trim())) {
    missing.push('physical postal address');
  }
  if (!body.includes(REQUIRED_DISCLAIMER)) {
    missing.push(`disclaimer "${REQUIRED_DISCLAIMER}"`);
  }
  if (!body.includes(REQUIRED_GAMBLING_LINE)) {
    missing.push(`responsible-gambling line "${REQUIRED_GAMBLING_LINE}"`);
  }

  return { ok: missing.length === 0, missing };
}
