-- Only allow sign-ups from approved company email domains.
-- Add or remove domains in public.allowed_signup_domains; no redeploy needed.

CREATE TABLE IF NOT EXISTS public.allowed_signup_domains (
  domain text PRIMARY KEY
);

ALTER TABLE public.allowed_signup_domains ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.enforce_signup_domain()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.email IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.allowed_signup_domains
    WHERE domain = lower(split_part(NEW.email, '@', 2))
  ) THEN
    RAISE EXCEPTION 'Please sign up with your company email address.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_signup_domain ON auth.users;
CREATE TRIGGER enforce_signup_domain
  BEFORE INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.enforce_signup_domain();
