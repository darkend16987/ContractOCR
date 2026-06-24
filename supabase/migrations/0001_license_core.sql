-- Nabu PDF — license management core schema.
--
-- Source of truth for the online-activation hybrid (ROADMAP Phase L.3):
--   licenses   — one row per issued key (seat cap, expiry, assignment, status)
--   activations — one row per (license, machine); enforces seat limit + remote deactivate
--   audit_log  — every admin/system mutation
--   admins     — superadmin email allowlist (gates the admin dashboard via RLS)
--
-- Writes happen ONLY through Edge Functions using the service-role key (which
-- bypasses RLS). The admin web app reads with the signed-in user's JWT, gated by
-- is_admin(). Browsers never hold the signing key — issuing happens server-side.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.licenses (
  id           uuid primary key default gen_random_uuid(),
  key_id       text not null unique,                 -- human id, e.g. NB-0001
  key          text not null unique,                 -- full NABU1.<payload>.<sig>
  name         text not null default '',
  email        text not null default '',
  plan         text not null default 'pro',
  max_seats    int  not null default 1 check (max_seats >= 1),
  assigned_to  text not null default '',             -- who you handed it to
  status       text not null default 'active' check (status in ('active','revoked','suspended')),
  issued_at    timestamptz not null default now(),
  expires_at   timestamptz,                           -- null = perpetual
  note         text not null default '',
  created_by   text not null default ''               -- admin email
);

create table if not exists public.activations (
  id           uuid primary key default gen_random_uuid(),
  license_id   uuid not null references public.licenses(id) on delete cascade,
  hwid         text not null,
  machine_name text not null default '',
  app_version  text not null default '',
  status       text not null default 'active' check (status in ('active','deactivated')),
  activated_at timestamptz not null default now(),
  last_seen    timestamptz not null default now(),
  token_exp    timestamptz,
  unique (license_id, hwid)
);

create table if not exists public.audit_log (
  id            bigint generated always as identity primary key,
  at            timestamptz not null default now(),
  actor         text not null default 'system',       -- admin email or 'system'
  action        text not null,
  license_id    uuid,
  activation_id uuid,
  detail        jsonb not null default '{}'::jsonb
);

create table if not exists public.admins (
  email    text primary key,
  added_at timestamptz not null default now()
);

create index if not exists activations_license_idx on public.activations(license_id);
create index if not exists activations_hwid_idx     on public.activations(hwid);
create index if not exists audit_license_idx         on public.audit_log(license_id);

-- ---------------------------------------------------------------------------
-- Seat usage view — active activations per license vs the cap.
-- ---------------------------------------------------------------------------

-- security_invoker so the view runs with the QUERYING user's RLS (not the
-- owner's) — without this the view would bypass is_admin() and leak every row.
create or replace view public.license_overview
with (security_invoker = true) as
select
  l.*,
  coalesce(a.active_seats, 0) as active_seats,
  (l.max_seats - coalesce(a.active_seats, 0)) as free_seats
from public.licenses l
left join (
  select license_id, count(*)::int as active_seats
  from public.activations
  where status = 'active'
  group by license_id
) a on a.license_id = l.id;

-- ---------------------------------------------------------------------------
-- Admin gate. SECURITY DEFINER so the policy check can read `admins` even with
-- RLS on. Matches the signed-in user's email against the allowlist.
-- ---------------------------------------------------------------------------

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.admins a
    where a.email = (auth.jwt() ->> 'email')
  );
$$;

-- ---------------------------------------------------------------------------
-- RLS: read-only for admins; all writes go through service-role Edge Functions.
-- ---------------------------------------------------------------------------

alter table public.licenses   enable row level security;
alter table public.activations enable row level security;
alter table public.audit_log  enable row level security;
alter table public.admins     enable row level security;

drop policy if exists licenses_admin_read   on public.licenses;
drop policy if exists activations_admin_read on public.activations;
drop policy if exists audit_admin_read       on public.audit_log;
drop policy if exists admins_admin_read       on public.admins;

create policy licenses_admin_read   on public.licenses   for select to authenticated using (public.is_admin());
create policy activations_admin_read on public.activations for select to authenticated using (public.is_admin());
create policy audit_admin_read       on public.audit_log  for select to authenticated using (public.is_admin());
create policy admins_admin_read      on public.admins     for select to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------------
-- Seed the first superadmin. Sign in to the admin app with this email (magic
-- link) to get access. Add more later via the dashboard or:
--   insert into public.admins(email) values ('someone@x.com');
-- ---------------------------------------------------------------------------

insert into public.admins(email) values ('hoangnam.mng@gmail.com')
on conflict (email) do nothing;
