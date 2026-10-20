import { daysLeft, fmtDate, normalizeHostname, status, PLAN_LIMITS } from './lib.js';

const cfg = window.EXPIRYPING;
const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let user;
let profile = null;

function show(signedIn) {
  $('login').hidden = signedIn;
  $('app').hidden = !signedIn;
  $('who').hidden = !signedIn;
  $('signout').hidden = !signedIn;
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-btn').disabled = true;
  const { error } = await sb.auth.signInWithOtp({
    email: $('email').value.trim(),
    options: { emailRedirectTo: location.href.split('#')[0] },
  });
  $('login-btn').disabled = false;
  const m = $('login-msg');
  m.hidden = false;
  m.className = `msg ${error ? 'err' : 'info'}`;
  m.textContent = error ? `Couldn't send the link: ${error.message}` : 'Check your inbox for the sign-in link. It works once and expires in an hour.';
});

$('signout').addEventListener('click', async () => {
  await sb.auth.signOut();
  location.reload();
});

function dateCell(iso, error) {
  if (error) return `<span class="muted" title="${esc(error)}">${iso ? esc(fmtDate(iso)) : 'unknown'}</span>`;
  if (!iso) return '<span class="muted">not checked yet</span>';
  const d = daysLeft(iso);
  const left = d < 0 ? `expired ${-d}d ago` : `${d} day${d === 1 ? '' : 's'}`;
  return `${esc(left)} <span class="muted">· ${esc(fmtDate(iso))}</span>`;
}

function statusPill(d) {
  const s = status(d);
  const label = d.ssl_error ? 'SSL problem' : { ok: 'OK', warn: 'Renew soon', crit: 'Urgent', unknown: 'Pending' }[s];
  return `<span class="pill ${s}" title="${esc(d.ssl_error || '')}">${label}</span>`;
}

async function load() {
  const [{ data: p }, { data: domains, error }] = await Promise.all([
    sb.from('profiles').select('*').single(),
    sb.from('domains').select('*').order('hostname'),
  ]);
  profile = p;
  if (error) {
    $('rows').innerHTML = `<tr><td colspan="6">Couldn't load domains: ${esc(error.message)}</td></tr>`;
    return;
  }
  const order = { crit: 0, warn: 1, unknown: 2, ok: 3 };
  domains.sort((a, b) => order[status(a)] - order[status(b)] || a.hostname.localeCompare(b.hostname));

  $('usage').textContent = `${domains.length} of ${profile.domain_limit} domains on the ${profile.plan} plan`;
  const counts = { crit: 0, warn: 0, ok: 0 };
  domains.forEach((d) => { const s = status(d); if (s in counts) counts[s]++; });
  $('summary').innerHTML = domains.length
    ? `<span class="pill crit">${counts.crit} urgent</span><span class="pill warn">${counts.warn} renew soon</span><span class="pill ok">${counts.ok} OK</span>`
    : '';
  $('empty').hidden = domains.length > 0;
  $('rows').innerHTML = domains.map((d) => `
    <tr data-id="${d.id}">
      <td><b>${esc(d.hostname)}</b>${d.muted ? ' <span class="muted">(muted)</span>' : ''}</td>
      <td>${statusPill(d)}</td>
      <td>${dateCell(d.ssl_expires_at, d.ssl_error)}</td>
      <td>${dateCell(d.domain_expires_at, d.rdap_error && !d.domain_expires_at ? d.rdap_error : null)}</td>
      <td>${esc(d.client_name || '')}</td>
      <td><div class="row" style="flex-wrap:nowrap;gap:6px">
        <button class="ghost small" data-act="mute" data-muted="${d.muted}">${d.muted ? 'Unmute' : 'Mute'}</button>
        <button class="ghost small" data-act="delete">Remove</button>
      </div></td>
    </tr>`).join('');

  renderUpgrade();
  $('brand-form').hidden = profile.plan !== 'agency';
  $('brand-input').value = profile.brand_name || '';
}

function checkoutLink(base) {
  const u = new URL(base);
  u.searchParams.set('checkout[custom][user_id]', user.id);
  u.searchParams.set('checkout[email]', user.email);
  return u.toString();
}

function renderUpgrade() {
  const c = cfg.checkout;
  const offers = [];
  if (profile.plan === 'free') {
    if (c.freelancer) offers.push([`Freelancer · $9/mo · ${PLAN_LIMITS.freelancer} domains`, c.freelancer]);
    if (c.lifetime) offers.push(['Lifetime · $79 once', c.lifetime]);
  }
  if (profile.plan !== 'agency' && c.agency) offers.push([`Agency · $29/mo · ${PLAN_LIMITS.agency} domains`, c.agency]);
  $('upgrade').innerHTML = offers.map(([label, href], i) =>
    `<a class="btn ${i ? 'ghost' : ''}" href="${esc(checkoutLink(href))}">${esc(label)}</a>`).join('');
}

$('rows').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('tr').dataset.id;
  btn.disabled = true;
  if (btn.dataset.act === 'delete') {
    if (btn.dataset.confirm !== '1') {
      btn.dataset.confirm = '1';
      btn.textContent = 'Confirm remove';
      btn.disabled = false;
      return;
    }
    await sb.from('domains').delete().eq('id', id);
  } else {
    await sb.from('domains').update({ muted: btn.dataset.muted !== 'true' }).eq('id', id);
  }
  load();
});

$('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const lines = $('add-input').value.split('\n').map((l) => l.trim()).filter(Boolean);
  const rows = [];
  const bad = [];
  for (const line of lines) {
    const [host, name, email] = line.split(',').map((s) => s.trim());
    const hostname = normalizeHostname(host);
    if (!hostname) { bad.push(host); continue; }
    if (!rows.some((r) => r.hostname === hostname)) rows.push({ hostname, client_name: name || null, client_email: email || null });
  }
  const msg = $('add-msg');
  if (!rows.length) { msg.textContent = bad.length ? `Not a domain: ${bad.join(', ')}` : 'Paste at least one domain.'; return; }
  $('add-btn').disabled = true;
  let added = 0;
  let stop = null;
  // One insert per row so a duplicate or the plan limit doesn't block the rest.
  for (const r of rows) {
    const { error } = await sb.from('domains').insert(r);
    if (!error) added++;
    else if (error.code === 'P0001') { stop = error.message; break; }
  }
  $('add-btn').disabled = false;
  msg.textContent = [`Added ${added}.`, stop, bad.length ? `Skipped (not a domain): ${bad.join(', ')}.` : '', added ? 'New domains are checked within the hour.' : '']
    .filter(Boolean).join(' ');
  if (added) $('add-input').value = '';
  load();
});

$('brand-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { error } = await sb.rpc('set_brand_name', { name: $('brand-input').value });
  $('brand-msg').textContent = error ? `Couldn't save: ${error.message}` : 'Saved.';
});

sb.auth.onAuthStateChange((_event, session) => {
  const next = session?.user ?? null;
  if (user !== undefined && next?.id === user?.id) return;
  user = next;
  show(!!user);
  if (user) {
    $('who').textContent = user.email;
    load();
  }
});
