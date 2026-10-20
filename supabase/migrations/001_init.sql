-- ExpiryPing schema: one profile per user, their domains, and the latest check result on each domain.

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  plan text not null default 'free' check (plan in ('free', 'freelancer', 'agency', 'lifetime')),
  domain_limit int not null default 5,
  brand_name text,
  ls_customer_id text,
  ls_subscription_id text,
  last_report_month text,
  created_at timestamptz not null default now()
);

create table public.domains (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  hostname text not null check (hostname ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'),
  client_name text,
  client_email text,
  muted boolean not null default false,
  -- latest results, written by the checker with the service key
  domain_expires_at timestamptz,
  registrar text,
  rdap_checked_at timestamptz,
  rdap_error text,
  ssl_expires_at timestamptz,
  ssl_issuer text,
  ssl_error text,
  checked_at timestamptz,
  last_alert_domain text,
  last_alert_ssl text,
  created_at timestamptz not null default now(),
  unique (user_id, hostname)
);

create index domains_checked_at_idx on public.domains (checked_at nulls first);

-- New sign-ups get a free profile.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email);
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Plan limits are enforced in the database so the browser cannot bypass them.
create function public.enforce_domain_limit() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  lim int;
  used int;
begin
  select domain_limit into lim from profiles where id = new.user_id;
  select count(*) into used from domains where user_id = new.user_id;
  if used >= coalesce(lim, 0) then
    raise exception 'Your plan allows % domains. Upgrade to add more.', lim using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger domains_limit before insert on public.domains
  for each row execute function public.enforce_domain_limit();

-- Users may only set their own brand name (Agency plan uses it in reports).
create function public.set_brand_name(name text) returns void
language sql security definer set search_path = public as $$
  update profiles set brand_name = nullif(trim(name), '') where id = auth.uid();
$$;

alter table public.profiles enable row level security;
alter table public.domains enable row level security;

create policy "read own profile" on public.profiles for select using (id = auth.uid());

create policy "read own domains" on public.domains for select using (user_id = auth.uid());
create policy "add own domains" on public.domains for insert with check (user_id = auth.uid());
create policy "edit own domains" on public.domains for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "remove own domains" on public.domains for delete using (user_id = auth.uid());

-- Signed-in users can only write the columns they own; check results come from the checker.
revoke insert, update on public.domains from anon, authenticated;
grant insert (hostname, client_name, client_email) on public.domains to authenticated;
grant update (client_name, client_email, muted) on public.domains to authenticated;
revoke all on public.profiles from anon;
revoke insert, update, delete on public.profiles from authenticated;
revoke all on function public.set_brand_name(text) from public, anon;
grant execute on function public.set_brand_name(text) to authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.enforce_domain_limit() from public, anon, authenticated;
