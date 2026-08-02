alter table public.profiles enable row level security;
alter table public.attendance enable row level security;
alter table public.posts enable row level security;

-- profiles: 로그인 사용자는 모든 프로필의 이름을 읽을 수 있음(게시판 작성자 표시용), 본인 것만 수정 가능
create policy "profiles_select_authenticated" on public.profiles
  for select to authenticated using (true);

create policy "profiles_update_own" on public.profiles
  for update to authenticated using (id = auth.uid());

-- attendance: 본인 기록만 조회/등록/수정/삭제 가능
create policy "attendance_select_own" on public.attendance
  for select to authenticated using (user_id = auth.uid());

create policy "attendance_insert_own" on public.attendance
  for insert to authenticated with check (user_id = auth.uid());

create policy "attendance_update_own" on public.attendance
  for update to authenticated using (user_id = auth.uid());

create policy "attendance_delete_own" on public.attendance
  for delete to authenticated using (user_id = auth.uid());

-- posts: 로그인 사용자는 전체 게시글 조회 가능, 본인 글만 작성/수정/삭제 가능
create policy "posts_select_authenticated" on public.posts
  for select to authenticated using (true);

create policy "posts_insert_own" on public.posts
  for insert to authenticated with check (user_id = auth.uid());

create policy "posts_update_own" on public.posts
  for update to authenticated using (user_id = auth.uid());

create policy "posts_delete_own" on public.posts
  for delete to authenticated using (user_id = auth.uid());
