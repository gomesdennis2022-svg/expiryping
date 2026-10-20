// Hourly job: checks every domain that is due, sends alerts, and on the 1st of the month sends reports.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY, MAIL_FROM, APP_URL, DRY_RUN (optional)
import {
  alertDecision, buildAlertEmail, buildReportEmail, isDue, pool, rdapDue, registrableDomain,
} from './lib.js';
import { lookupRdap, lookupTls } from './net.js';

// Trim keys so a stray space or newline pasted into a secret doesn't break request headers.
const env = Object.fromEntries(Object.entries(process.env).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));
const DRY_RUN = env.DRY_RUN === '1';
const APP_URL = env.APP_URL || 'https://expiryping.com/app.html';
const MAIL_FROM = env.MAIL_FROM || 'ExpiryPing <alerts@expiryping.com>';

// If a secret was pasted with extra text around it, pick out the part that looks like the key.
function pickKey(name, value, looksRight) {
  if (!value || !/\s/.test(value)) return value;
  const parts = value.split(/\s+/).filter(Boolean);
  const hit = parts.find(looksRight);
  const shapes = parts.map((p) => `${p.length} chars${looksRight(p) ? ' (looks like the key)' : ''}`).join(', ');
  console.log(`::warning::${name} has ${parts.length} parts separated by spaces or line breaks: ${shapes}. ${hit ? 'Using the one that looks like the key; re-paste just that part to clear this warning.' : ''}`);
  if (!hit) throw new Error(`${name} doesn't contain a recognisable key. Re-paste just the key into the repo secret.`);
  return hit;
}
const jwtRole = (t) => {
  try { return JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()).role; } catch { return null; }
};
env.SUPABASE_SERVICE_ROLE_KEY = pickKey('SUPABASE_SERVICE_ROLE_KEY', env.SUPABASE_SERVICE_ROLE_KEY,
  (p) => p.startsWith('sb_secret_') || (p.startsWith('eyJ') && jwtRole(p) === 'service_role'));
env.RESEND_API_KEY = pickKey('RESEND_API_KEY', env.RESEND_API_KEY, (p) => p.startsWith('re_'));
if (env.SUPABASE_SERVICE_ROLE_KEY?.startsWith('eyJ') && jwtRole(env.SUPABASE_SERVICE_ROLE_KEY) !== 'service_role') {
  throw new Error(`SUPABASE_SERVICE_ROLE_KEY is the "${jwtRole(env.SUPABASE_SERVICE_ROLE_KEY)}" key. Use the service_role (secret) key instead.`);
}
for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
  if (!env[k]) throw new Error(`Missing ${k}`);
}
if (!DRY_RUN && !env.RESEND_API_KEY) throw new Error('Missing RESEND_API_KEY (or set DRY_RUN=1)');

async function db(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'content-type': 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${method} ${path.split('?')[0]} failed: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function fetchAll(table, select) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const page = await db(`${table}?select=${select}&order=id`, { headers: { range: `${from}-${from + 999}` } });
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendEmail({ to, subject, text, html, fromName }) {
  if (DRY_RUN) {
    console.log(`[dry run] email to ${to}: ${subject}`);
    return;
  }
  const from = fromName ? `${fromName.replace(/[<>"]/g, '')} <${MAIL_FROM.match(/<(.+)>/)?.[1] || MAIL_FROM}>` : MAIL_FROM;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, text, html }),
  });
  if (!res.ok) console.error(`Email to ${to} failed: ${res.status} ${await res.text()}`);
  await sleep(600); // Resend allows about 2 requests per second
}

async function checkDomain(d, now) {
  const patch = { checked_at: now.toISOString() };
  const ssl = await lookupTls(d.hostname);
  patch.ssl_expires_at = ssl.expiresAt;
  patch.ssl_issuer = ssl.issuer;
  patch.ssl_error = ssl.error;
  if (rdapDue(d, now)) {
    const rdap = await lookupRdap(registrableDomain(d.hostname));
    patch.rdap_checked_at = now.toISOString();
    patch.rdap_error = rdap.error;
    // Keep the last known date if a lookup fails transiently.
    if (rdap.expiresAt || !d.domain_expires_at) patch.domain_expires_at = rdap.expiresAt;
    if (rdap.registrar) patch.registrar = rdap.registrar;
  }
  return { ...d, ...patch, patch };
}

async function runChecks(now) {
  const domains = await fetchAll('domains', '*');
  const due = domains.filter((d) => isDue(d, now));
  console.log(`${domains.length} domains, ${due.length} due for a check`);

  const checked = await pool(due, 20, (d) => checkDomain(d, now));
  const alertsByUser = new Map();

  for (const d of checked) {
    const patch = d.patch;
    if (!d.muted) {
      const decisions = [
        { kind: 'ssl', ...alertDecision({ kind: 'ssl', expiresAt: d.ssl_expires_at, error: d.ssl_error, lastKey: d.last_alert_ssl, now }), expiresAt: d.ssl_expires_at, error: d.ssl_error },
        { kind: 'domain', ...alertDecision({ kind: 'domain', expiresAt: d.domain_expires_at, error: null, lastKey: d.last_alert_domain, now }), expiresAt: d.domain_expires_at },
      ];
      for (const a of decisions) {
        if (!a.send) continue;
        if (!alertsByUser.has(d.user_id)) alertsByUser.set(d.user_id, []);
        alertsByUser.get(d.user_id).push({ ...a, hostname: d.hostname, registrar: d.registrar });
        patch[a.kind === 'ssl' ? 'last_alert_ssl' : 'last_alert_domain'] = a.key;
      }
      // Clear the error marker once the problem is fixed, so a repeat error alerts again.
      if (!d.ssl_error && d.last_alert_ssl === 'ssl:error') patch.last_alert_ssl = null;
    }
    if (!DRY_RUN) await db(`domains?id=eq.${d.id}`, { method: 'PATCH', body: patch, headers: { prefer: 'return=minimal' } });
    console.log(`${d.hostname}: ssl ${d.ssl_expires_at?.slice(0, 10) ?? '-'}${d.ssl_error ? ` (${d.ssl_error})` : ''}, domain ${d.domain_expires_at?.slice(0, 10) ?? '-'}`);
  }

  if (!alertsByUser.size) return;
  const ids = [...alertsByUser.keys()].join(',');
  const profiles = await db(`profiles?select=id,email&id=in.(${ids})`);
  for (const p of profiles) {
    const email = buildAlertEmail(alertsByUser.get(p.id), APP_URL);
    await sendEmail({ to: p.email, ...email });
  }
  console.log(`Sent alerts to ${profiles.length} users`);
}

// On the 1st (from 09:00 UTC), once per month: paid plans send each client a report of their sites;
// every user gets their own summary.
async function runReports(now) {
  if (now.getUTCDate() !== 1 || now.getUTCHours() < 9) return;
  const monthKey = now.toISOString().slice(0, 7);
  const month = now.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const profiles = (await fetchAll('profiles', 'id,email,plan,brand_name,last_report_month')).filter((p) => p.last_report_month !== monthKey);
  if (!profiles.length) return;
  const domains = await fetchAll('domains', 'user_id,hostname,client_name,client_email,domain_expires_at,ssl_expires_at,ssl_error');

  for (const p of profiles) {
    const mine = domains.filter((d) => d.user_id === p.id);
    if (mine.length) {
      // Mark first so a crash mid-send never emails a client twice.
      if (!DRY_RUN) await db(`profiles?id=eq.${p.id}`, { method: 'PATCH', body: { last_report_month: monthKey }, headers: { prefer: 'return=minimal' } });
      const brand = p.plan === 'agency' ? p.brand_name : null;
      await sendEmail({ to: p.email, ...buildReportEmail({ brand, clientName: null, domains: mine, month, now }) });
      if (p.plan !== 'free') {
        const byClient = new Map();
        for (const d of mine.filter((x) => x.client_email)) {
          const k = d.client_email.toLowerCase();
          if (!byClient.has(k)) byClient.set(k, { name: d.client_name, list: [] });
          byClient.get(k).list.push(d);
        }
        for (const [to, c] of byClient) {
          await sendEmail({ to, fromName: brand, ...buildReportEmail({ brand, clientName: c.name, domains: c.list, month, now }) });
        }
      }
    }
  }
  console.log(`Monthly reports done for ${profiles.length} users`);
}

const now = new Date();
await runChecks(now);
await runReports(now);
