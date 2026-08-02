create table public.water_log (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  logged_on date not null,
  cups int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, logged_on)
);

alter table public.water_log enable row level security;

create policy "water_log_select_own" on public.water_log
  for select to authenticated using (user_id = auth.uid());

create policy "water_log_insert_own" on public.water_log
  for insert to authenticated with check (user_id = auth.uid());

create policy "water_log_update_own" on public.water_log
  for update to authenticated using (user_id = auth.uid());
