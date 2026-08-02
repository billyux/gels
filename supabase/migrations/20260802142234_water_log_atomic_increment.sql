create function public.increment_water(p_date date)
returns int
language plpgsql
security invoker
set search_path = public
as $$
declare
  new_cups int;
begin
  insert into public.water_log (user_id, logged_on, cups)
  values (auth.uid(), p_date, 1)
  on conflict (user_id, logged_on)
  do update set cups = water_log.cups + 1, updated_at = now()
  returning cups into new_cups;

  return new_cups;
end;
$$;

revoke execute on function public.increment_water(date) from public;
grant execute on function public.increment_water(date) to authenticated;
