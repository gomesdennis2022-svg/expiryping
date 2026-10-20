// Pure helpers for the checker. Everything here is unit-tested; network code lives in net.js.

export const THRESHOLDS = [30, 14, 7, 3, 1];

export const PLAN_LIMITS = { free: 5, freelancer: 75, lifetime: 75, agency: 500 };

const DAY_MS = 24 * 60 * 60 * 1000;

// Common two-part public suffixes. Anything else is treated as a one-part TLD.
const TWO_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'ac.uk',
  'com.au', 'net.au', 'org.au', 'co.nz', 'org.nz', 'net.nz',
  'com.br', 'net.br', 'org.br', 'com.mx', 'com.ar', 'com.co',
  'co.za', 'co.in', 'net.in', 'org.in', 'co.jp', 'ne.jp', 'or.jp',
  'com.sg', 'com.my', 'com.hk', 'com.tw', 'com.cn', 'com.tr', 'com.pt',
  'co.il', 'co.kr', 'com.ph', 'com.pk', 'com.ng', 'com.eg', 'co.id',
]);

export function normalizeHostname(input) {
  let h = String(input || '').trim().toLowerCase();
  h = h.replace(/^[a-z]+:\/\//, '').split(/[/?#:\s]/)[0].replace(/\.$/, '');
  if (h.startsWith('www.')) h = h.slice(4);
  return /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(h) ? h : null;
}

// The registered domain whose expiry RDAP knows about: shop.greenfern.co -> greenfern.co.
export function registrableDomain(hostname) {
  const parts = hostname.split('.');
  if (parts.length <= 2) return hostname;
  const lastTwo = parts.slice(-2).join('.');
  return TWO_PART_SUFFIXES.has(lastTwo) ? parts.slice(-3).join('.') : lastTwo;
}

export function parseRdap(json) {
  const events = Array.isArray(json?.events) ? json.events : [];
  const exp = events.find((e) => e.eventAction === 'expiration');
  const registrarEntity = (json?.entities || []).find((e) => (e.roles || []).includes('registrar'));
  let registrar = null;
  const vcard = registrarEntity?.vcardArray?.[1];
  if (Array.isArray(vcard)) {
    const fn = vcard.find((f) => f[0] === 'fn');
    if (fn) registrar = fn[3];
  }
  return { expiresAt: exp?.eventDate ? new Date(exp.eventDate).toISOString() : null, registrar };
}

export function daysLeft(iso, now = new Date()) {
  return Math.floor((new Date(iso).getTime() - now.getTime()) / DAY_MS);
}

// Which alert bucket a date falls in: 'expired', one of THRESHOLDS, or null when far away.
export function bucketFor(days) {
  if (days < 0) return 'expired';
  const hit = [...THRESHOLDS].reverse().find((t) => days <= t);
  return hit === undefined ? null : String(hit);
}

// Decide whether to alert. The key changes when the bucket or the expiry date changes, so each
// threshold alerts once, and a renewal (new expiry date) resets the sequence.
export function alertDecision({ kind, expiresAt, error, lastKey, now = new Date() }) {
  if (error) {
    const key = `${kind}:error`;
    return { key, send: key !== lastKey, reason: 'error', days: null };
  }
  if (!expiresAt) return { key: null, send: false };
  const days = daysLeft(expiresAt, now);
  const bucket = bucketFor(days);
  if (!bucket) return { key: null, send: false };
  const key = `${kind}:${expiresAt.slice(0, 10)}:${bucket}`;
  return { key, send: key !== lastKey, reason: bucket === 'expired' ? 'expired' : 'soon', days };
}

// Does this domain need checking this run?
export function isDue(domain, now = new Date()) {
  if (!domain.checked_at) return true;
  return now.getTime() - new Date(domain.checked_at).getTime() >= 20 * 60 * 60 * 1000;
}

// Registration dates change rarely: re-query RDAP weekly, or daily inside the 30-day window.
export function rdapDue(domain, now = new Date()) {
  if (!domain.rdap_checked_at) return true;
  const age = now.getTime() - new Date(domain.rdap_checked_at).getTime();
  const near = domain.domain_expires_at && daysLeft(domain.domain_expires_at, now) <= 31;
  return age >= (near ? 20 * 60 * 60 * 1000 : 7 * DAY_MS);
}

export function status(domain, now = new Date()) {
  if (domain.ssl_error) return 'crit';
  const ds = [domain.ssl_expires_at, domain.domain_expires_at].filter(Boolean).map((d) => daysLeft(d, now));
  if (!ds.length) return 'unknown';
  const min = Math.min(...ds);
  if (min <= 7) return 'crit';
  if (min <= 30) return 'warn';
  return 'ok';
}

export function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function alertLine(a) {
  const what = a.kind === 'ssl' ? 'SSL certificate' : 'Domain registration';
  if (a.reason === 'error') return `${what} for ${a.hostname} has a problem: ${a.error}`;
  if (a.reason === 'expired') return `${what} for ${a.hostname} expired on ${fmtDate(a.expiresAt)}`;
  return `${what} for ${a.hostname} expires in ${a.days} day${a.days === 1 ? '' : 's'} (${fmtDate(a.expiresAt)})`;
}

function alertHint(a) {
  if (a.kind === 'ssl') return 'Visitors see a security warning once it lapses. Check your host\'s SSL panel or run "certbot renew --dry-run" on the server.';
  return 'Check auto-renew and the card on file at the registrar' + (a.registrar ? ` (${a.registrar})` : '') + '.';
}

export function buildAlertEmail(alerts, appUrl) {
  const worst = alerts.find((a) => a.reason !== 'soon') || alerts[0];
  const subject = alerts.length === 1 ? alertLine(alerts[0]) : `${alerts.length} renewals need attention, starting with ${worst.hostname}`;
  const text = alerts.map((a) => `- ${alertLine(a)}\n  ${alertHint(a)}`).join('\n\n') +
    `\n\nSee all your domains: ${appUrl}\nYou get alerts at 30, 14, 7, 3 and 1 days. Mute a domain from the dashboard.`;
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#14211f">` +
    alerts.map((a) => `<p><b>${esc(alertLine(a))}</b><br><span style="color:#5a6b68">${esc(alertHint(a))}</span></p>`).join('') +
    `<p><a href="${esc(appUrl)}">Open your dashboard</a></p>` +
    `<p style="color:#5a6b68;font-size:13px">You get alerts at 30, 14, 7, 3 and 1 days. Mute a domain from the dashboard.</p></div>`;
  return { subject, text, html };
}

export function buildReportEmail({ brand, clientName, domains, month, now = new Date() }) {
  const rows = domains.map((d) => {
    const s = status(d, now);
    const label = { ok: 'All clear', warn: 'Renewal soon', crit: 'Needs attention', unknown: 'Not checked yet' }[s];
    return { host: d.hostname, label, domain: d.domain_expires_at ? fmtDate(d.domain_expires_at) : 'n/a', ssl: d.ssl_expires_at ? fmtDate(d.ssl_expires_at) : 'n/a' };
  });
  const from = brand || 'ExpiryPing';
  const subject = `${month} website report${clientName ? ` for ${clientName}` : ''}`;
  const text = `${subject}\n\n` + rows.map((r) => `${r.host}: ${r.label}. Domain renews ${r.domain}, SSL valid until ${r.ssl}.`).join('\n') +
    `\n\nMonitored daily by ${from}.`;
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;color:#14211f"><h2 style="margin:0 0 12px">${esc(subject)}</h2>` +
    `<table cellpadding="8" style="border-collapse:collapse;font-size:14px"><tr style="text-align:left;color:#5a6b68"><th>Site</th><th>Status</th><th>Domain renews</th><th>SSL valid until</th></tr>` +
    rows.map((r) => `<tr style="border-top:1px solid #d9e2e0"><td>${esc(r.host)}</td><td>${esc(r.label)}</td><td>${esc(r.domain)}</td><td>${esc(r.ssl)}</td></tr>`).join('') +
    `</table><p style="color:#5a6b68;font-size:13px">Monitored daily by ${esc(from)}.</p></div>`;
  return { subject, text, html };
}

export async function pool(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}
