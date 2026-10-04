REVOKE ALL ON FUNCTION public.profile_on_signup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.profile_on_signup() TO service_role;