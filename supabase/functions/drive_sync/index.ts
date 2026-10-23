/**
 * drive_sync: copies the file list of the Google Drive "Sales Kit" folder into the
 * drive_files table, so the chatbot can search it instantly instead of walking Drive.
 *
 * One call lists Drive pages for up to ~100s and saves where it stopped; call again
 * until it returns done=true. pg_cron calls it every 2 hours (job drive_sync_nightly).
 *
 * Once a listing is complete, the same call reads the text of new or changed documents
 * (PDF via Gemini, which also reads scanned pages; PPTX/DOCX/XLSX by unzipping; Google
 * Docs/Slides/Sheets via export) into kb_items as kind 'document', and embeds any chunks
 * still missing a vector. Other formats stay searchable by file name and folder only.
 */
import { unzipSync, strFromU8 } from 'npm:fflate@0.8.2'
import { getAccessToken } from '../process_chat_query/googleDrive.ts'

const env = (n: string) => (Deno.env.get(n) ?? '').trim().replace(/^[<"' ]+|[>"' ]+$/g, '')
const DRIVE_API = 'https://www.googleapis.com/drive/v3'
const FOLDER_ID = env('GOOGLE_DRIVE_FOLDER_ID')
const SA_JSON = (Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON') ?? '').trim().replace(/^[<'"]+|[>'"]+$/g, '')
const SUPABASE_URL = env('SUPABASE_URL').replace(/\/$/, '')
const SERVICE_ROLE = env('SUPABASE_SERVICE_ROLE_KEY')
const GEMINI_API_KEY = env('GEMINI_API_KEY')
const TIME_BUDGET = 100 * 1000
const DOC_START_BEFORE = 60 * 1000 // don't start reading a document after this point in the call
const MAX_ATTEMPTS = 3
const MAX_ZIP_BYTES = 80 * 1024 * 1024
const READ_MODELS = ['gemini-flash-lite-latest', 'gemini-flash-latest']
const EMBED_MODEL = 'gemini-embedding-001'

const DB_HEADERS = {
  'Content-Type': 'application/json',
  apikey: SERVICE_ROLE,
  Authorization: `Bearer ${SERVICE_ROLE}`,
}

async function db(path: string, init: RequestInit = {}) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...DB_HEADERS, ...(init.headers ?? {}) } })
  if (!resp.ok) throw new Error(`DB ${path} ${resp.status}: ${await resp.text()}`)
  const text = await resp.text()
  return text ? JSON.parse(text) : null
}

async function saveState(state: any) {
  await db('drive_sync_state', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ id: 1, ...state }),
  })
}

// ── Document text ────────────────────────────────────────

const OOXML: Record<string, { pattern: RegExp; tag: RegExp }> = {
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': { pattern: /^ppt\/slides\/slide\d+\.xml$/, tag: /<a:t>([^<]*)<\/a:t>/g },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { pattern: /^word\/document\.xml$/, tag: /<w:t[^>]*>([^<]*)<\/w:t>/g },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { pattern: /^xl\/sharedStrings\.xml$/, tag: /<t[^>]*>([^<]*)<\/t>/g },
}
const GOOGLE_EXPORT: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.presentation': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
}
const READABLE = ['application/pdf', ...Object.keys(OOXML), ...Object.keys(GOOGLE_EXPORT)]

const READ_PROMPT = "This is a Stonelam (porcelain slab brand) sales document. Transcribe ALL readable text, page by page, " +
  "starting each page with '=== Page N ==='. For pages that are mostly photos, add one line describing the photo " +
  '(building type, application such as facade/kitchen/flooring, shade names if shown). Render tables as plain lines. ' +
  'Leave out prices, phone numbers and email addresses.'

const decodeXml = (t: string) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

async function driveFetch(token: string, path: string) {
  const resp = await fetch(`${DRIVE_API}/files/${path}`, { headers: { Authorization: `Bearer ${token}` } })
  if (!resp.ok) throw new Error(`Drive ${resp.status}: ${(await resp.text()).slice(0, 200)}`)
  return resp
}

// Returns the document as pages of text
async function readDocument(token: string, f: any): Promise<string[]> {
  if (GOOGLE_EXPORT[f.mime_type]) {
    const resp = await driveFetch(token, `${f.id}/export?mimeType=${encodeURIComponent(GOOGLE_EXPORT[f.mime_type])}`)
    return [await resp.text()]
  }
  if (OOXML[f.mime_type]) {
    if ((f.size ?? 0) > MAX_ZIP_BYTES) return []
    const { pattern, tag } = OOXML[f.mime_type]
    const bytes = new Uint8Array(await (await driveFetch(token, `${f.id}?alt=media&supportsAllDrives=true`)).arrayBuffer())
    const files = unzipSync(bytes, { filter: (entry) => pattern.test(entry.name) })
    return Object.keys(files)
      .sort((a, b) => Number(a.match(/\d+/)?.[0] ?? 0) - Number(b.match(/\d+/)?.[0] ?? 0))
      .map((name) => [...strFromU8(files[name]).matchAll(tag)].map((m) => decodeXml(m[1])).join(' '))
  }
  // PDF: stream it from Drive into the Gemini File API, then have Gemini transcribe it
  const media = await driveFetch(token, `${f.id}?alt=media&supportsAllDrives=true`)
  const size = media.headers.get('Content-Length') ?? String(f.size ?? '')
  const start = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': size,
      'X-Goog-Upload-Header-Content-Type': 'application/pdf',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: f.id } }),
  })
  const uploadUrl = start.headers.get('X-Goog-Upload-URL')
  if (!uploadUrl) throw new Error(`Gemini upload start ${start.status}: ${(await start.text()).slice(0, 200)}`)
  const up = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize', 'Content-Length': size },
    body: media.body,
  })
  if (!up.ok) throw new Error(`Gemini upload ${up.status}: ${(await up.text()).slice(0, 200)}`)
  let file = (await up.json()).file
  try {
    while (file.state === 'PROCESSING') {
      await new Promise((r) => setTimeout(r, 3000))
      file = await (await fetch(`https://generativelanguage.googleapis.com/v1beta/${file.name}?key=${GEMINI_API_KEY}`)).json()
    }
    for (const model of READ_MODELS) {
      const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ file_data: { mime_type: 'application/pdf', file_uri: file.uri } }, { text: READ_PROMPT }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 32000 },
        }),
      })
      if (!resp.ok) {
        console.error(`[drive_sync] ${model} read failed`, resp.status, (await resp.text()).slice(0, 200))
        continue
      }
      const data = await resp.json()
      const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ?? ''
      return text.split(/=== ?Page \d+ ?===/).filter((p: string) => p.trim())
    }
    throw new Error('Gemini could not read the PDF')
  } finally {
    await fetch(`https://generativelanguage.googleapis.com/v1beta/${file.name}?key=${GEMINI_API_KEY}`, { method: 'DELETE' }).catch(() => {})
  }
}

// Same rules as scripts/load_drive_docs.py: no prices, phone numbers or emails in the knowledge base
const PRICE = /(₹|rs\.?|inr|mrp)\s*[:\-]?\s*[\d,]+(\.\d+)?(\s*\/-)?|[\d,]+(\.\d+)?\s*(\/-|rs\b|inr\b)/gi
const clean = (t: string) => t.replace(/\x00/g, '').replace(PRICE, '').replace(/\+?\d[\d \-]{8,}\d/g, '')
  .replace(/\S+@\S+\.\w+/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()

function chunkPages(pages: string[]) {
  const chunks: { from: number; to: number; text: string }[] = []
  let cur = ''
  let start = 1
  pages.forEach((raw, idx) => {
    const i = idx + 1
    const p = clean(raw)
    if (!p) return
    if (cur && cur.length + p.length > 2200) {
      chunks.push({ from: start, to: i - 1, text: cur })
      cur = ''
      start = i
    }
    cur += (cur ? '\n' : '') + p
    while (cur.length > 3000) {
      chunks.push({ from: start, to: i, text: cur.slice(0, 2500) })
      cur = cur.slice(2300)
    }
  })
  if (cur.trim()) chunks.push({ from: start, to: Math.max(start, pages.length), text: cur })
  return chunks
}

async function embedMissing(limit: number) {
  if (!GEMINI_API_KEY) return 0
  const rows = await db(`kb_items?kind=eq.document&embedding=is.null&select=id,title,body&limit=${limit}`)
  let done = 0
  for (let i = 0; i < rows.length; i += 20) {
    const batch = rows.slice(i, i + 20)
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:batchEmbedContents?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: batch.map((r: any) => ({
          model: `models/${EMBED_MODEL}`,
          content: { parts: [{ text: `${r.title}\n${r.body.slice(0, 6000)}` }] },
          taskType: 'RETRIEVAL_DOCUMENT',
          outputDimensionality: 768,
        })),
      }),
    })
    if (!resp.ok) {
      // Usually the free-tier daily quota; full-text search still finds these chunks meanwhile
      console.error('[drive_sync] embed stopped', resp.status, (await resp.text()).slice(0, 200))
      break
    }
    const { embeddings } = await resp.json()
    for (let j = 0; j < batch.length; j++) {
      await db(`kb_items?id=eq.${batch[j].id}`, {
        method: 'PATCH',
        body: JSON.stringify({ embedding: `[${embeddings[j].values.join(',')}]` }),
      })
      done++
    }
  }
  return done
}

async function syncDocuments(token: string, started: number) {
  const pruned = await db('rpc/drive_prune_documents', { method: 'POST', body: '{}' })
  // New or changed documents, smallest first, skipping ones that failed too often
  const pending: any[] = (await db('rpc/drive_pending_documents', {
    method: 'POST',
    body: JSON.stringify({ max_attempts: MAX_ATTEMPTS, lim: 20 }),
  })) ?? []
  const read: string[] = []
  for (const f of pending) {
    if (Date.now() - started > DOC_START_BEFORE) break
    if (!READABLE.includes(f.mime_type)) {
      // e.g. .zip, .eps, .psd: searchable by name/folder only
      await db(`drive_files?id=eq.${f.id}`, { method: 'PATCH', body: JSON.stringify({ text_modified: f.modified_at, text_chars: 0 }) })
      continue
    }
    try {
      const chunks = chunkPages(await readDocument(token, f))
      const where = (f.path ? f.path + '/' : '') + f.name
      const rows = chunks.map((c, n) => ({
        source_id: `drive:${f.id}:${c.from}-${c.to}#${n + 1}`,
        kind: 'document',
        title: c.to > c.from ? `${f.name} (p.${c.from}-${c.to})` : `${f.name} (p.${c.from})`,
        body: `Document: ${where}\n${c.text}`,
        source: 'drive',
        meta: { drive: { id: f.id, name: f.name, path: f.path, mime_type: f.mime_type }, pages: [c.from, c.to] },
        embedding: null,
      }))
      await db(`kb_items?kind=eq.document&source_id=like.${encodeURIComponent(`drive:${f.id}:*`)}`, { method: 'DELETE' })
      if (rows.length) await db('kb_items', { method: 'POST', body: JSON.stringify(rows) })
      await db(`drive_files?id=eq.${f.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ text_modified: f.modified_at, text_attempts: 0, text_chars: rows.reduce((n, r) => n + r.body.length, 0) }),
      })
      read.push(f.name)
    } catch (e) {
      console.error('[drive_sync] could not read', f.name, e)
      const [row] = await db(`drive_files?id=eq.${f.id}&select=text_attempts`)
      await db(`drive_files?id=eq.${f.id}`, { method: 'PATCH', body: JSON.stringify({ text_attempts: (row?.text_attempts ?? 0) + 1 }) })
    }
  }
  const embedded = Date.now() - started < TIME_BUDGET ? await embedMissing(200) : 0
  return { pruned, read, embedded }
}

Deno.serve(async () => {
  const started = Date.now()
  try {
    const token = await getAccessToken(JSON.parse(SA_JSON))
    let [state] = (await db('drive_sync_state?id=eq.1')) ?? []
    if (!state || state.done) {
      state = { run_id: crypto.randomUUID(), page_token: null, done: false, files_seen: 0, started_at: new Date().toISOString(), finished_at: null }
      await saveState(state)
    }

    const fields = 'nextPageToken,files(id,name,mimeType,parents,size,modifiedTime,webViewLink,description,videoMediaMetadata(durationMillis),imageMediaMetadata(width,height))'
    let pageToken: string | null = state.page_token
    let pages = 0

    do {
      // Everything the service account can see, flat. The folder tree is rebuilt in SQL afterwards,
      // which is far faster than asking Drive folder by folder.
      const params = new URLSearchParams({
        q: 'trashed = false',
        fields,
        pageSize: '1000',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
        corpora: 'allDrives',
      })
      if (pageToken) params.set('pageToken', pageToken)
      const resp = await fetch(`${DRIVE_API}/files?${params}`, { headers: { Authorization: `Bearer ${token}` } })
      if (!resp.ok) throw new Error(`Drive list ${resp.status}: ${await resp.text()}`)
      const data = await resp.json()

      const rows = (data.files ?? []).map((f: any) => ({
        id: f.id,
        name: f.name,
        mime_type: f.mimeType,
        parent_id: f.parents?.[0] ?? null,
        size: f.size ? Number(f.size) : null,
        modified_at: f.modifiedTime ?? null,
        web_view_link: f.webViewLink ?? null,
        description: f.description ?? null,
        duration_ms: f.videoMediaMetadata?.durationMillis ? Number(f.videoMediaMetadata.durationMillis) : null,
        width: f.imageMediaMetadata?.width ?? null,
        height: f.imageMediaMetadata?.height ?? null,
        sync_run: state.run_id,
        synced_at: new Date().toISOString(),
      }))
      if (rows.length) {
        await db('drive_files', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify(rows) })
      }

      pageToken = data.nextPageToken ?? null
      pages++
      state.files_seen += rows.length
      state.page_token = pageToken
      await saveState({ run_id: state.run_id, page_token: pageToken, files_seen: state.files_seen, done: false })
    } while (pageToken && Date.now() - started < TIME_BUDGET)

    if (pageToken) {
      return Response.json({ done: false, pages, files_seen: state.files_seen })
    }

    const inFolder = await db('rpc/drive_finish_sync', { method: 'POST', body: JSON.stringify({ root_id: FOLDER_ID, run: state.run_id }) })
    await saveState({ run_id: state.run_id, page_token: null, done: true, files_seen: state.files_seen, finished_at: new Date().toISOString() })
    const docs = await syncDocuments(token, started)
    return Response.json({ done: true, pages, files_seen: state.files_seen, in_sales_kit: inFolder, documents: docs })
  } catch (e) {
    console.error('[drive_sync]', e)
    return Response.json({ error: String(e) }, { status: 500 })
  }
})
