-- ═══════════════════════════════════════════════════════════════
--  Sales Assistant Hub — WhatsApp bot (function whatsapp_webhook)
--  wa_contacts: who may use the bot (sales), who answers unknown
--  questions (expert) and who manages the team list (admin).
--  wa_messages: every message in and out, so Meta's retries are
--  ignored and an expert's swipe-reply finds its question.
--  Idempotent: safe to run more than once.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.wa_contacts (
    phone            TEXT PRIMARY KEY CHECK (phone ~ '^[0-9]{8,15}$'),  -- country code + number, digits only: 919812345678
    name             TEXT,
    role             TEXT NOT NULL DEFAULT 'sales' CHECK (role IN ('sales', 'expert', 'admin')),
    active           BOOLEAN NOT NULL DEFAULT true,
    last_inbound_at  TIMESTAMPTZ,                -- free-form replies are allowed for 24h after this
    created_at       TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.wa_messages (
    id          TEXT PRIMARY KEY,                -- WhatsApp message id (wamid.…)
    direction   TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    phone       TEXT NOT NULL,
    kind        TEXT,                            -- text, image, video, document, audio, template…
    body        TEXT,
    pending_id  BIGINT REFERENCES public.kb_pending_questions(id) ON DELETE SET NULL,
    fallback    TEXT,                            -- sent instead if this media message fails to deliver
    status      TEXT,                            -- sent / delivered / read / failed
    created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wa_messages_phone   ON public.wa_messages (phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_messages_pending ON public.wa_messages (pending_id) WHERE pending_id IS NOT NULL;

-- Only the edge function (service role) touches these
ALTER TABLE public.wa_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wa_messages ENABLE ROW LEVEL SECURITY;
