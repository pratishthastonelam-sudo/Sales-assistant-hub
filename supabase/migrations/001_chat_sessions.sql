-- ═══════════════════════════════════════════════════════════════
--  Sales Assistant Hub — Database Migration
--  Run in Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════

-- ── chat_sessions table ───────────────────────────────────────
-- Stores conversation history for the web UI.

CREATE TABLE IF NOT EXISTS public.chat_sessions (
    id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    session_id  UUID,                          -- groups messages within a conversation
    role        TEXT NOT NULL DEFAULT 'user',  -- 'user' | 'assistant'
    content     TEXT NOT NULL,                  -- the message text
    media       JSONB DEFAULT '[]'::jsonb,     -- array of image objects {name, url, thumbnail, web_view_link}
    documents   JSONB DEFAULT '[]'::jsonb,     -- array of doc objects {name, mime_type, url, web_view_link}
    title       TEXT,                           -- session title (first message, truncated)
    created_at  TIMESTAMPTZ DEFAULT now(),
    updated_at  TIMESTAMPTZ DEFAULT now()
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_id    ON public.chat_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_session_id ON public.chat_sessions(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_created_at  ON public.chat_sessions(created_at DESC);

-- ── chat_logs table ───────────────────────────────────────────
-- Lightweight analytics log (written by the Edge Function).

CREATE TABLE IF NOT EXISTS public.chat_logs (
    id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    query         TEXT NOT NULL,
    matched_count INTEGER DEFAULT 0,
    confident     BOOLEAN DEFAULT FALSE,
    used_llm      BOOLEAN DEFAULT FALSE,
    created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_logs_created_at ON public.chat_logs(created_at DESC);

-- ── Row Level Security (RLS) ──────────────────────────────────
-- Users can only see their own chat sessions.

ALTER TABLE public.chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_logs    ENABLE ROW LEVEL SECURITY;

-- Policy: users can read their own sessions
DROP POLICY IF EXISTS "Users can read own chat sessions" ON public.chat_sessions;
CREATE POLICY "Users can read own chat sessions"
    ON public.chat_sessions
    FOR SELECT
    USING (auth.uid() = user_id);

-- Policy: users can insert their own sessions
DROP POLICY IF EXISTS "Users can insert own chat sessions" ON public.chat_sessions;
CREATE POLICY "Users can insert own chat sessions"
    ON public.chat_sessions
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- Policy: users can update their own sessions
DROP POLICY IF EXISTS "Users can update own chat sessions" ON public.chat_sessions;
CREATE POLICY "Users can update own chat sessions"
    ON public.chat_sessions
    FOR UPDATE
    USING (auth.uid() = user_id);

-- Policy: users can delete their own sessions
DROP POLICY IF EXISTS "Users can delete own chat sessions" ON public.chat_sessions;
CREATE POLICY "Users can delete own chat sessions"
    ON public.chat_sessions
    FOR DELETE
    USING (auth.uid() = user_id);

-- Policy: chat_logs are insert-only via service role (Edge Function)
-- No direct user access — logs are internal analytics.
DROP POLICY IF EXISTS "Service role can manage chat_logs" ON public.chat_logs;
CREATE POLICY "Service role can manage chat_logs"
    ON public.chat_logs
    FOR ALL
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');

-- ── Auto-update updated_at trigger ────────────────────────────

CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_chat_sessions_updated_at ON public.chat_sessions;
CREATE TRIGGER trg_chat_sessions_updated_at
    BEFORE UPDATE ON public.chat_sessions
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_updated_at();
