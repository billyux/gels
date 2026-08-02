alter table public.posts
  add constraint posts_user_id_profiles_fkey
  foreign key (user_id) references public.profiles(id) on delete cascade;
