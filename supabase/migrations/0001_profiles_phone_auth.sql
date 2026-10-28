-- ============================================================================
-- Supabase phone-OTP auth schema
-- ----------------------------------------------------------------------------
-- Standalone from the KisanTractor app's own identity system. It adds a public
-- profile table tied to Supabase's managed auth.users, with Row Level Security
-- so a phone-authenticated user can read and update only their own row.
--
-- Apply it in the Supabase dashboard SQL editor, or with:
--   supabase db push      (Supabase CLI)
-- ============================================================================

-- Profiles keyed one-to-one to the Supabase auth user.
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  phone       text,
  full_name   text,
  role        text not null default 'FARMER' check (role in ('FARMER', 'OWNER')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.profiles is 'Per-user profile for Supabase phone-OTP authenticated accounts.';

-- Keep updated_at current on every change.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Create a profile automatically when a new auth user signs up, copying the
-- verified phone number from auth.users.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, phone)
  values (new.id, new.phone)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Row Level Security: a user sees and edits only their own profile.
alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
  on public.profiles for insert
  with check (auth.uid() = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);
