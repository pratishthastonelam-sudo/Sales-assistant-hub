-- Index of the Google Drive "Sales Kit" folder, filled by the drive_sync edge function.
-- Searching this table replaces walking the whole 112GB Drive tree on every question.

create extension if not exists pg_trgm;

create table if not exists drive_files (
  id            text primary key,
  name          text not null,
  mime_type     text not null,
  parent_id     text,
  size          bigint,
  modified_at   timestamptz,
  web_view_link text,
  description   text,
  duration_ms   bigint,
  width         int,
  height        int,
  path          text,              -- folder path inside Sales Kit, e.g. "Image Repository/Calacatta"
  in_root       boolean not null default false,
  kind          text generated always as (
    case
      when mime_type = 'application/vnd.google-apps.folder' then 'folder'
      when mime_type like 'image/%' then 'image'
      when mime_type like 'video/%' then 'video'
      else 'document'
    end) stored,
  search_text   text generated always as (
    lower(regexp_replace(coalesce(name, '') || ' ' || coalesce(path, '') || ' ' || coalesce(description, ''),
                         '[_\-\.\(\)\[\]/&,+]+', ' ', 'g'))) stored,
  fts           tsvector generated always as (
    to_tsvector('english', lower(regexp_replace(
      coalesce(name, '') || ' ' || coalesce(name, '') || ' ' || coalesce(path, '') || ' ' || coalesce(description, ''),
      '[_\-\.\(\)\[\]/&,+]+', ' ', 'g')))) stored,
  sync_run      text,
  synced_at     timestamptz not null default now()
);

create index if not exists drive_files_fts_idx on drive_files using gin (fts);
create index if not exists drive_files_trgm_idx on drive_files using gin (search_text gin_trgm_ops);
create index if not exists drive_files_parent_idx on drive_files (parent_id);

alter table drive_files enable row level security; -- service role only

create table if not exists drive_sync_state (
  id          int primary key default 1,
  run_id      text,
  page_token  text,
  done        boolean default true,
  files_seen  int default 0,
  started_at  timestamptz,
  finished_at timestamptz
);
alter table drive_sync_state enable row level security;

-- After a full listing: work out folder paths from the root folder down, mark what lies inside it,
-- and drop rows the latest run didn't see (deleted/moved out of Drive).
create or replace function drive_finish_sync(root_id text, run text)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update drive_files set in_root = false, path = null where true;
  with recursive
  folders as (
    select f.id, f.name::text as path, 1 as depth
      from drive_files f where f.parent_id = root_id and f.mime_type = 'application/vnd.google-apps.folder'
    union all
    select c.id, folders.path || '/' || c.name, folders.depth + 1
      from drive_files c join folders on c.parent_id = folders.id
     where c.mime_type = 'application/vnd.google-apps.folder' and folders.depth < 20
  ),
  placed as (
    select f.id, '' as path from drive_files f where f.parent_id = root_id
    union all
    select f.id, folders.path from drive_files f join folders on f.parent_id = folders.id
  )
  update drive_files d set in_root = true, path = placed.path from placed where d.id = placed.id;
  delete from drive_files where sync_run is distinct from run;
  select count(*) into n from drive_files where in_root;
  return n;
end $$;

-- Keyword search over Drive names/folders with rarity weighting (rare words like a shade name
-- count far more than common ones like "photo"), plus trigram fallback for typos.
create or replace function match_drive(query_text text, kinds text[] default null, match_count int default 20)
returns table (id text, name text, mime_type text, kind text, path text, web_view_link text,
               size bigint, duration_ms bigint, score float)
language plpgsql stable security definer set search_path = public as $$
declare
  total float;
  terms text[];
  t text;
  weights jsonb := '{}';
  df float;
  q tsquery;
begin
  select count(*) into total from drive_files where in_root;
  if total = 0 then return; end if;
  select array_agg(distinct lex) into terms
    from unnest(tsvector_to_array(to_tsvector('english', lower(regexp_replace(query_text, '[_\-\.\(\)\[\]/&,+]+', ' ', 'g'))))) lex;
  if terms is null then return; end if;
  foreach t in array terms loop
    select count(*) into df from drive_files where in_root and fts @@ to_tsquery('english', quote_literal(t) || ':*');
    if df > 0 then
      weights := weights || jsonb_build_object(t, ln(1 + total / df));
    end if;
  end loop;
  if weights = '{}'::jsonb then
    -- nothing matched exactly: typo-tolerant fallback
    return query
      select d.id, d.name, d.mime_type, d.kind, d.path, d.web_view_link, d.size, d.duration_ms,
             word_similarity(lower(query_text), d.search_text)::float
        from drive_files d
       where d.in_root and (kinds is null or d.kind = any(kinds))
         and lower(query_text) <% d.search_text
       order by 9 desc limit match_count;
    return;
  end if;
  select string_agg(quote_literal(k) || ':*', ' | ')::tsquery into q from jsonb_object_keys(weights) k;
  return query
    select d.id, d.name, d.mime_type, d.kind, d.path, d.web_view_link, d.size, d.duration_ms,
           (select sum((weights ->> k)::float) from jsonb_object_keys(weights) k
             where d.fts @@ to_tsquery('english', quote_literal(k) || ':*'))
           -- small boosts: word in the file name itself, and shallower/shorter paths
           + 0.5 * ts_rank(to_tsvector('english', lower(regexp_replace(d.name, '[_\-\.\(\)\[\]/&,+]+', ' ', 'g'))), q)
           as score
      from drive_files d
     where d.in_root and d.fts @@ q and (kinds is null or d.kind = any(kinds))
     order by score desc, length(coalesce(d.path, '')) asc
     limit match_count;
end $$;

-- Text of Drive PDFs/decks is chunked into kb_items as kind 'document' (meta.drive = source file)
alter table kb_items drop constraint if exists kb_items_kind_check;
alter table kb_items add constraint kb_items_kind_check
  check (kind in ('fact', 'qa', 'project', 'media', 'expert_answer', 'document'));

-- Automatic text reading of new/changed Drive documents (drive_sync "docs" step)
alter table drive_files add column if not exists text_modified timestamptz;  -- modified_at of the version whose text is in kb_items
alter table drive_files add column if not exists text_attempts int not null default 0;
alter table drive_files add column if not exists text_chars int;

-- Remove knowledge chunks whose Drive file was deleted or moved out of the Sales Kit
create or replace function drive_prune_documents()
returns int language sql security definer set search_path = public as $$
  with gone as (
    delete from kb_items k
     where k.kind = 'document'
       and not exists (select 1 from drive_files d where d.in_root and d.id = k.meta->'drive'->>'id')
    returning 1)
  select count(*)::int from gone;
$$;

create or replace function drive_pending_documents(max_attempts int default 3, lim int default 20)
returns setof drive_files language sql stable security definer set search_path = public as $$
  select * from drive_files
   where in_root and kind = 'document' and text_attempts < max_attempts
     and (text_modified is null or text_modified < modified_at)
   order by size asc nulls first
   limit lim;
$$;
