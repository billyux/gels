alter table public.posts add column image_url text;

insert into storage.buckets (id, name, public)
values ('post-images', 'post-images', true)
on conflict (id) do nothing;

create policy "post_images_public_read" on storage.objects
  for select to public using (bucket_id = 'post-images');

create policy "post_images_authenticated_insert" on storage.objects
  for insert to authenticated with check (bucket_id = 'post-images' and owner = auth.uid());

create policy "post_images_owner_delete" on storage.objects
  for delete to authenticated using (bucket_id = 'post-images' and owner = auth.uid());
