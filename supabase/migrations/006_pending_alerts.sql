-- ═══════════════════════════════════════════════════════════════
--  Sales Assistant Hub — alert on unanswered questions
--  Every new row in kb_pending_questions (web app or WhatsApp) calls
--  pending_questions?action=notify, which emails ALERT_EMAIL_TO
--  (and, once the WhatsApp bot is live, can alert experts there too).
--  Needs two Vault secrets (set once, not stored in this file):
--    select vault.create_secret('https://<ref>.supabase.co', 'project_url');
--    select vault.create_secret('<same as PENDING_NOTIFY_SECRET>', 'pending_notify_secret');
--  Without them the trigger does nothing.
--  Idempotent: safe to run more than once.
-- ═══════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION public.notify_pending_question()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    base   TEXT;
    secret TEXT;
BEGIN
    SELECT decrypted_secret INTO base   FROM vault.decrypted_secrets WHERE name = 'project_url';
    SELECT decrypted_secret INTO secret FROM vault.decrypted_secrets WHERE name = 'pending_notify_secret';
    IF base IS NULL OR secret IS NULL THEN
        RETURN NEW;
    END IF;
    -- pg_net is asynchronous: the insert never waits on, or fails because of, the alert
    PERFORM net.http_post(
        url     := base || '/functions/v1/pending_questions?action=notify',
        body    := jsonb_build_object('id', NEW.id),
        headers := jsonb_build_object('Content-Type', 'application/json', 'X-Notify-Secret', secret)
    );
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_pending_question ON public.kb_pending_questions;
CREATE TRIGGER trg_notify_pending_question
    AFTER INSERT ON public.kb_pending_questions
    FOR EACH ROW EXECUTE FUNCTION public.notify_pending_question();
