create table public.activity_samples (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  sampled_at timestamptz not null default now(),
  activity_level real not null,
  posture text,
  created_at timestamptz not null default now()
);

create index activity_samples_user_time_idx on public.activity_samples (user_id, sampled_at);

alter table public.activity_samples enable row level security;

create policy "activity_samples_select_own" on public.activity_samples
  for select to authenticated using (user_id = auth.uid());

create policy "activity_samples_insert_own" on public.activity_samples
  for insert to authenticated with check (user_id = auth.uid());
