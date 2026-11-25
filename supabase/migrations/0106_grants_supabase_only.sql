-- Supabase-only: grants again for functions added in 0105. Add a new grants migration after any migration that adds RPCs.
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
grant execute on all functions in schema app to authenticated;
grant execute on function public.public_availability(text, date, int, text) to anon;
revoke execute on function public.create_public_reservation(text, jsonb) from authenticated;
revoke execute on function public.realert_unconfirmed() from authenticated;
-- internal helpers are never called directly by the app
revoke execute on function app.patch_fn(text, text, text) from authenticated;
revoke execute on function app.wrap_rpc(text, text, text) from authenticated;
