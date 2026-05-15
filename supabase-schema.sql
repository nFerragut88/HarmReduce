-- HarmReduce — one-time schema setup.
-- Paste into Supabase → SQL Editor → Run.

-- ---------- profiles ----------
create table if not exists public.profiles (
  user_id uuid references auth.users on delete cascade primary key,
  handle text unique not null,
  created_at timestamptz default now()
);
create index if not exists profiles_handle_idx on public.profiles(handle);

-- ---------- friendships ----------
do $$ begin
  create type public.friendship_status as enum ('pending', 'accepted', 'blocked');
exception when duplicate_object then null;
end $$;

create table if not exists public.friendships (
  id uuid default gen_random_uuid() primary key,
  from_user uuid references auth.users on delete cascade not null,
  to_user uuid references auth.users on delete cascade not null,
  status public.friendship_status default 'pending' not null,
  created_at timestamptz default now(),
  unique(from_user, to_user),
  check (from_user <> to_user)
);
create index if not exists fs_from_idx on public.friendships(from_user);
create index if not exists fs_to_idx on public.friendships(to_user);

-- ---------- cloud-synced inventory ----------
create table if not exists public.cloud_inventory (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users on delete cascade not null,
  substance text not null,
  form text,
  amount text,
  unit text,
  notes text,
  created_at timestamptz default now()
);
create index if not exists inv_user_idx on public.cloud_inventory(user_id);

-- ---------- messages ----------
create table if not exists public.messages (
  id uuid default gen_random_uuid() primary key,
  from_user uuid references auth.users on delete cascade not null,
  to_user uuid references auth.users on delete cascade not null,
  body text not null,
  created_at timestamptz default now()
);
create index if not exists msg_pair_idx on public.messages(to_user, from_user, created_at);

-- ---------- helper: friendship check ----------
create or replace function public.are_friends(a uuid, b uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and ((f.from_user = a and f.to_user = b) or (f.from_user = b and f.to_user = a))
  );
$$;

-- ---------- RLS ----------
alter table public.profiles enable row level security;
alter table public.friendships enable row level security;
alter table public.cloud_inventory enable row level security;
alter table public.messages enable row level security;

-- profiles: anyone signed in can read (so handles are searchable); owner manages own.
drop policy if exists profiles_select_all on public.profiles;
drop policy if exists profiles_insert_self on public.profiles;
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_select_all on public.profiles for select using (auth.role() = 'authenticated');
create policy profiles_insert_self on public.profiles for insert with check (user_id = auth.uid());
create policy profiles_update_self on public.profiles for update using (user_id = auth.uid());

-- friendships: each party can see / modify their rows.
drop policy if exists fs_select_party on public.friendships;
drop policy if exists fs_insert_self on public.friendships;
drop policy if exists fs_update_party on public.friendships;
drop policy if exists fs_delete_party on public.friendships;
create policy fs_select_party on public.friendships for select using (from_user = auth.uid() or to_user = auth.uid());
create policy fs_insert_self on public.friendships for insert with check (from_user = auth.uid());
create policy fs_update_party on public.friendships for update using (from_user = auth.uid() or to_user = auth.uid());
create policy fs_delete_party on public.friendships for delete using (from_user = auth.uid() or to_user = auth.uid());

-- ---------- cloud-synced dose / note entries ----------
create table if not exists public.cloud_entries (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users on delete cascade not null,
  at timestamptz not null default now(),
  type text not null default 'dose',
  substance text,
  dose text,
  unit text,
  roa text,
  body text,
  setting text,
  mindset text,
  deduction_note text,
  created_at timestamptz default now()
);
create index if not exists ce_user_at_idx on public.cloud_entries(user_id, at desc);

alter table public.cloud_entries enable row level security;

drop policy if exists ce_select_self_or_friend on public.cloud_entries;
drop policy if exists ce_insert_own on public.cloud_entries;
drop policy if exists ce_update_own on public.cloud_entries;
drop policy if exists ce_delete_own on public.cloud_entries;
create policy ce_select_self_or_friend on public.cloud_entries for select
  using (user_id = auth.uid() or public.are_friends(auth.uid(), user_id));
create policy ce_insert_own on public.cloud_entries for insert with check (user_id = auth.uid());
create policy ce_update_own on public.cloud_entries for update using (user_id = auth.uid());
create policy ce_delete_own on public.cloud_entries for delete using (user_id = auth.uid());

-- cloud_inventory: owner CRUD, friends can SELECT.
drop policy if exists inv_select_self_or_friend on public.cloud_inventory;
drop policy if exists inv_insert_own on public.cloud_inventory;
drop policy if exists inv_update_own on public.cloud_inventory;
drop policy if exists inv_delete_own on public.cloud_inventory;
create policy inv_select_self_or_friend on public.cloud_inventory for select
  using (user_id = auth.uid() or public.are_friends(auth.uid(), user_id));
create policy inv_insert_own on public.cloud_inventory for insert with check (user_id = auth.uid());
create policy inv_update_own on public.cloud_inventory for update using (user_id = auth.uid());
create policy inv_delete_own on public.cloud_inventory for delete using (user_id = auth.uid());

-- messages: friends only.
drop policy if exists msg_select_party on public.messages;
drop policy if exists msg_insert_friend on public.messages;
drop policy if exists msg_delete_sender on public.messages;
create policy msg_select_party on public.messages for select
  using ((from_user = auth.uid() or to_user = auth.uid()) and public.are_friends(from_user, to_user));
create policy msg_insert_friend on public.messages for insert
  with check (from_user = auth.uid() and public.are_friends(from_user, to_user));
create policy msg_delete_sender on public.messages for delete using (from_user = auth.uid());

-- ---------- bulletin posts (shared board) ----------
-- Protections: 30s cooldown + 10/day per user (BEFORE trigger),
-- 1000-char body + 100-char title limits (CHECK constraints),
-- rolling cap to 200 most recent posts (AFTER trigger).
create table if not exists public.bulletin_posts (
  id uuid default gen_random_uuid() primary key,
  author_id uuid references auth.users on delete cascade not null,
  author_handle text not null,
  title text,
  body text not null,
  created_at timestamptz default now(),
  constraint bulletin_body_len check (char_length(body) <= 1000),
  constraint bulletin_title_len check (title is null or char_length(title) <= 100)
);
create index if not exists bp_created_idx on public.bulletin_posts(created_at desc);

alter table public.bulletin_posts enable row level security;

drop policy if exists bp_select_all on public.bulletin_posts;
drop policy if exists bp_insert_self on public.bulletin_posts;
drop policy if exists bp_delete_self on public.bulletin_posts;
create policy bp_select_all on public.bulletin_posts for select using (auth.role() = 'authenticated');
create policy bp_insert_self on public.bulletin_posts for insert with check (author_id = auth.uid());
create policy bp_delete_self on public.bulletin_posts for delete using (author_id = auth.uid());

-- Per-user rate limits.
create or replace function public.enforce_bulletin_limits()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1 from public.bulletin_posts
    where author_id = new.author_id
      and created_at > now() - interval '30 seconds'
  ) then
    raise exception 'Cooldown: wait 30 seconds between posts.';
  end if;
  if (
    select count(*) from public.bulletin_posts
    where author_id = new.author_id
      and created_at > now() - interval '24 hours'
  ) >= 10 then
    raise exception 'Daily limit reached: max 10 posts per 24 hours.';
  end if;
  return new;
end;
$$;
drop trigger if exists bulletin_limits_trigger on public.bulletin_posts;
create trigger bulletin_limits_trigger before insert on public.bulletin_posts
for each row execute function public.enforce_bulletin_limits();

-- Rolling cap: keep only the 200 most recent posts.
create or replace function public.cap_bulletin_posts()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare excess int;
begin
  select count(*) - 200 into excess from public.bulletin_posts;
  if excess > 0 then
    delete from public.bulletin_posts
    where id in (
      select id from public.bulletin_posts
      order by created_at asc
      limit excess
    );
  end if;
  return new;
end;
$$;
drop trigger if exists bulletin_cap_trigger on public.bulletin_posts;
create trigger bulletin_cap_trigger after insert on public.bulletin_posts
for each row execute function public.cap_bulletin_posts();

-- ---------- realtime ----------
-- Live updates so chat / friend requests / bulletin posts don't need a manual refresh.
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.friendships;
alter publication supabase_realtime add table public.bulletin_posts;
