import test from 'node:test';
import assert from 'node:assert/strict';
import {
  alertDecision, bucketFor, buildAlertEmail, buildReportEmail, isDue, normalizeHostname, parseRdap,
  pool, rdapDue, registrableDomain, status,
} from './lib.js';

const now = new Date('2026-10-20T06:00:00Z');
const inDays = (n) => new Date(now.getTime() + n * 86400000 + 3600000).toISOString();

test('normalizeHostname cleans pasted input', () => {
  assert.equal(normalizeHostname('https://www.Example.com/path?x=1'), 'example.com');
  assert.equal(normalizeHostname('  shop.greenfern.co  '), 'shop.greenfern.co');
  assert.equal(normalizeHostname('example.com:8443'), 'example.com');
  assert.equal(normalizeHostname('not a domain'), null);
  assert.equal(normalizeHostname('localhost'), null);
});

test('registrableDomain strips subdomains and knows two-part suffixes', () => {
  assert.equal(registrableDomain('shop.greenfern.co'), 'greenfern.co');
  assert.equal(registrableDomain('a.b.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('example.com'), 'example.com');
});

test('parseRdap reads expiry and registrar', () => {
  const r = parseRdap({
    events: [{ eventAction: 'registration', eventDate: '2000-01-01T00:00:00Z' }, { eventAction: 'expiration', eventDate: '2027-03-01T04:00:00Z' }],
    entities: [{ roles: ['registrar'], vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', 'Namecheap, Inc.']]] }],
  });
  assert.deepEqual(r, { expiresAt: '2027-03-01T04:00:00.000Z', registrar: 'Namecheap, Inc.' });
  assert.deepEqual(parseRdap({}), { expiresAt: null, registrar: null });
});

test('bucketFor maps days to thresholds', () => {
  assert.equal(bucketFor(45), null);
  assert.equal(bucketFor(30), '30');
  assert.equal(bucketFor(12), '14');
  assert.equal(bucketFor(7), '7');
  assert.equal(bucketFor(2), '3');
  assert.equal(bucketFor(0), '1');
  assert.equal(bucketFor(-1), 'expired');
});

test('alertDecision alerts once per threshold and resets on renewal', () => {
  const exp = inDays(12);
  const first = alertDecision({ kind: 'ssl', expiresAt: exp, lastKey: null, now });
  assert.equal(first.send, true);
  assert.equal(first.days, 12);
  const again = alertDecision({ kind: 'ssl', expiresAt: exp, lastKey: first.key, now });
  assert.equal(again.send, false);
  const later = alertDecision({ kind: 'ssl', expiresAt: exp, lastKey: first.key, now: new Date(now.getTime() + 6 * 86400000) });
  assert.equal(later.send, true);
  const renewed = alertDecision({ kind: 'ssl', expiresAt: inDays(90), lastKey: first.key, now });
  assert.equal(renewed.send, false);
  assert.equal(alertDecision({ kind: 'domain', expiresAt: null, lastKey: null, now }).send, false);
});

test('alertDecision alerts once for an ongoing error', () => {
  const a = alertDecision({ kind: 'ssl', error: 'Certificate is self-signed', lastKey: null, now });
  assert.equal(a.send, true);
  assert.equal(alertDecision({ kind: 'ssl', error: 'x', lastKey: a.key, now }).send, false);
});

test('isDue and rdapDue schedule work', () => {
  assert.equal(isDue({ checked_at: null }, now), true);
  assert.equal(isDue({ checked_at: new Date(now - 3600000).toISOString() }, now), false);
  assert.equal(isDue({ checked_at: new Date(now - 21 * 3600000).toISOString() }, now), true);
  const twoDaysAgo = new Date(now - 2 * 86400000).toISOString();
  assert.equal(rdapDue({ rdap_checked_at: twoDaysAgo, domain_expires_at: inDays(200) }, now), false);
  assert.equal(rdapDue({ rdap_checked_at: twoDaysAgo, domain_expires_at: inDays(10) }, now), true);
});

test('status picks the worst signal', () => {
  assert.equal(status({ ssl_expires_at: inDays(60), domain_expires_at: inDays(200) }, now), 'ok');
  assert.equal(status({ ssl_expires_at: inDays(20), domain_expires_at: inDays(200) }, now), 'warn');
  assert.equal(status({ ssl_expires_at: inDays(2) }, now), 'crit');
  assert.equal(status({ ssl_error: 'bad' }, now), 'crit');
  assert.equal(status({}, now), 'unknown');
});

test('emails escape hostnames and read well', () => {
  const alert = buildAlertEmail([{ kind: 'ssl', reason: 'soon', days: 2, expiresAt: inDays(2), hostname: 'shop.greenfern.co' }], 'https://x/app');
  assert.match(alert.subject, /SSL certificate for shop.greenfern.co expires in 2 days/);
  const report = buildReportEmail({ brand: 'Marlow <Studio>', clientName: 'Bakery', domains: [{ hostname: 'a.com', ssl_expires_at: inDays(60), domain_expires_at: inDays(300) }], month: 'November 2026', now });
  assert.equal(report.subject, 'November 2026 website report for Bakery');
  assert.match(report.html, /Marlow &lt;Studio&gt;/);
  assert.match(report.text, /a.com: All clear/);
});

test('pool keeps order and limits concurrency', async () => {
  let running = 0, peak = 0;
  const out = await pool([1, 2, 3, 4, 5], 2, async (n) => {
    running++; peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10]);
  assert.equal(peak, 2);
});
