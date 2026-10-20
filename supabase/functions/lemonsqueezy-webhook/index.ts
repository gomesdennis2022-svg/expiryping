// Lemon Squeezy webhook: sets a user's plan when they pay, change plan, or their subscription ends.
// Secrets: LEMONSQUEEZY_WEBHOOK_SECRET, LS_VARIANT_PLANS (JSON like {"123":"freelancer","456":"agency","789":"lifetime"}).
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.

const LIMITS: Record<string, number> = { free: 5, freelancer: 75, lifetime: 75, agency: 500 };
const ACTIVE = new Set(['active', 'on_trial', 'past_due', 'cancelled']); // cancelled stays active until the period ends

const enc = new TextEncoder();

async function validSignature(body: string, signature: string, secret: string) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (hex.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

async function db(path: string, init: RequestInit = {}) {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json', prefer: 'return=representation' },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const secret = Deno.env.get('LEMONSQUEEZY_WEBHOOK_SECRET');
  if (!secret) return new Response('Webhook secret not configured', { status: 500 });

  const body = await req.text();
  if (!(await validSignature(body, req.headers.get('x-signature') ?? '', secret))) {
    return new Response('Invalid signature', { status: 401 });
  }

  const event = JSON.parse(body);
  const name: string = event.meta?.event_name ?? '';
  const attrs = event.data?.attributes ?? {};
  const variantPlans: Record<string, string> = JSON.parse(Deno.env.get('LS_VARIANT_PLANS') ?? '{}');

  let plan: string | null = null;
  const patch: Record<string, unknown> = { ls_customer_id: attrs.customer_id ? String(attrs.customer_id) : undefined };

  if (name === 'order_created') {
    const variant = String(attrs.first_order_item?.variant_id ?? '');
    // Only the one-off lifetime product is handled here; subscriptions arrive as subscription_* events.
    if (variantPlans[variant] === 'lifetime' && attrs.status === 'paid') plan = 'lifetime';
  } else if (name.startsWith('subscription_')) {
    const variant = String(attrs.variant_id ?? '');
    patch.ls_subscription_id = String(event.data?.id ?? '');
    plan = ACTIVE.has(attrs.status) ? variantPlans[variant] ?? null : 'free';
  }
  if (!plan) return new Response('Ignored', { status: 200 });

  const userId = event.meta?.custom_data?.user_id;
  const email = String(attrs.user_email ?? '').toLowerCase();
  const filter = userId ? `id=eq.${encodeURIComponent(userId)}` : `email=eq.${encodeURIComponent(email)}`;

  // Never downgrade a lifetime buyer when an unrelated subscription ends.
  const [current] = await db(`profiles?select=plan&${filter}`);
  if (!current) return new Response('No matching user', { status: 200 });
  if (current.plan === 'lifetime' && plan === 'free') return new Response('Kept lifetime', { status: 200 });

  await db(`profiles?${filter}`, { method: 'PATCH', body: JSON.stringify({ ...patch, plan, domain_limit: LIMITS[plan] }) });
  return new Response(`Plan set to ${plan}`, { status: 200 });
});
