-- ═══════════════════════════════════════════════════════════════
--  Sales Assistant Hub — Knowledge base (hybrid search)
--  pgvector (semantic) + Postgres full-text (keywords), merged with
--  reciprocal rank fusion. Typos are still handled by Fuse in the
--  edge function before the query reaches here.
--  Idempotent: safe to run more than once.
-- ═══════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

-- array_to_string is only STABLE; generated columns need IMMUTABLE
CREATE OR REPLACE FUNCTION public.kb_join(arr TEXT[])
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$ SELECT array_to_string(arr, ' ') $$;

-- ── kb_items ──────────────────────────────────────────────────
-- One row per searchable thing: a curated fact, a WhatsApp Q&A,
-- a notable project, or a photo/video.

CREATE TABLE IF NOT EXISTS public.kb_items (
    id            BIGSERIAL PRIMARY KEY,
    source_id     TEXT UNIQUE NOT NULL,           -- stable key for upserts, e.g. 'media:wa_media/IMG-…jpg'
    kind          TEXT NOT NULL CHECK (kind IN ('fact', 'qa', 'project', 'media', 'expert_answer')),
    title         TEXT,
    body          TEXT NOT NULL,                  -- text that is embedded and full-text indexed
    shades        TEXT[] DEFAULT '{}',
    applications  TEXT[] DEFAULT '{}',
    sectors       TEXT[] DEFAULT '{}',
    thickness     TEXT[] DEFAULT '{}',
    media_path    TEXT,                           -- object path in storage bucket 'kb-media'
    media_type    TEXT,                           -- 'image' | 'video'
    meta          JSONB DEFAULT '{}'::jsonb,      -- AI caption fields, dates, source request, etc.
    source        TEXT DEFAULT 'whatsapp',
    item_date     DATE,
    embedding     extensions.vector(768),
    fts           TSVECTOR GENERATED ALWAYS AS (
                    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
                    setweight(to_tsvector('english', public.kb_join(shades)), 'A') ||
                    setweight(to_tsvector('english', body), 'B')
                  ) STORED,
    created_at    TIMESTAMPTZ DEFAULT now(),
    updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kb_items_fts       ON public.kb_items USING gin (fts);
CREATE INDEX IF NOT EXISTS idx_kb_items_shades    ON public.kb_items USING gin (shades);
CREATE INDEX IF NOT EXISTS idx_kb_items_kind      ON public.kb_items (kind);
CREATE INDEX IF NOT EXISTS idx_kb_items_embedding ON public.kb_items
    USING hnsw (embedding extensions.vector_cosine_ops);

-- ── kb_pending_questions ──────────────────────────────────────
-- Questions the bot could not answer; forwarded to an expert.
-- The expert's reply is stored here and copied into kb_items.

CREATE TABLE IF NOT EXISTS public.kb_pending_questions (
    id             BIGSERIAL PRIMARY KEY,
    asked_by       TEXT,                          -- WhatsApp number or auth user id
    channel        TEXT DEFAULT 'whatsapp',
    question       TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'forwarded', 'answered', 'dismissed')),
    expert         TEXT,
    answer         TEXT,
    kb_item_id     BIGINT REFERENCES public.kb_items(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ DEFAULT now(),
    answered_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_kb_pending_status ON public.kb_pending_questions (status);

-- ── RLS ───────────────────────────────────────────────────────
-- Edge functions use the service role (bypasses RLS).
-- Signed-in web users may read the knowledge base.

ALTER TABLE public.kb_items             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kb_pending_questions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Signed-in users can read kb" ON public.kb_items;
CREATE POLICY "Signed-in users can read kb"
    ON public.kb_items FOR SELECT TO authenticated USING (true);

-- ── match_kb: hybrid search ───────────────────────────────────
-- query_text drives full-text; query_embedding drives vector search.
-- Either may be null. Results fused with RRF (k = 50).

CREATE OR REPLACE FUNCTION public.match_kb(
    query_text       TEXT,
    query_embedding  extensions.vector(768) DEFAULT NULL,
    match_count      INT DEFAULT 10,
    kinds            TEXT[] DEFAULT NULL,
    shade_filter     TEXT[] DEFAULT NULL,
    rrf_k            INT DEFAULT 50
)
RETURNS TABLE (
    id BIGINT, kind TEXT, title TEXT, body TEXT, shades TEXT[], applications TEXT[],
    media_path TEXT, media_type TEXT, meta JSONB, score DOUBLE PRECISION
)
LANGUAGE sql STABLE
SET search_path = public, extensions
AS $$
WITH filtered AS (
    SELECT k.* FROM kb_items k
    WHERE (kinds IS NULL OR k.kind = ANY (kinds))
      AND (shade_filter IS NULL OR k.shades && shade_filter)
),
ft AS (
    SELECT f.id, row_number() OVER (ORDER BY ts_rank_cd(f.fts, q) DESC) AS r
    FROM filtered f, websearch_to_tsquery('english', coalesce(query_text, '')) q
    WHERE query_text IS NOT NULL AND f.fts @@ q
    ORDER BY ts_rank_cd(f.fts, q) DESC
    LIMIT match_count * 4
),
vec AS (
    SELECT f.id, row_number() OVER (ORDER BY f.embedding <=> query_embedding) AS r
    FROM filtered f
    WHERE query_embedding IS NOT NULL AND f.embedding IS NOT NULL
    ORDER BY f.embedding <=> query_embedding
    LIMIT match_count * 4
),
fused AS (
    SELECT coalesce(ft.id, vec.id) AS id,
           coalesce(1.0 / (rrf_k + ft.r), 0) + coalesce(1.0 / (rrf_k + vec.r), 0) AS score
    FROM ft FULL OUTER JOIN vec ON ft.id = vec.id
)
SELECT k.id, k.kind, k.title, k.body, k.shades, k.applications,
       k.media_path, k.media_type, k.meta, fused.score
FROM fused JOIN kb_items k ON k.id = fused.id
ORDER BY fused.score DESC
LIMIT match_count;
$$;

-- ── Storage bucket for photos/videos (private; served via signed URLs) ──
INSERT INTO storage.buckets (id, name, public)
VALUES ('kb-media', 'kb-media', false)
ON CONFLICT (id) DO NOTHING;
