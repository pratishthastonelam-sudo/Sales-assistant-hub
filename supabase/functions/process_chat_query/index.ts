/**
 * ═══════════════════════════════════════════════════════════════
 *  process_chat_query — Supabase Edge Function
 * ═══════════════════════════════════════════════════════════════
 *
 *  This function is intentionally dual-purpose:
 *
 *  1. WEB UI: Receives POST { message, user_id, session_id }
 *     → Returns { response, media_urls, video_urls, documents }
 *
 *  2. WHATSAPP WEBHOOK (ready for Meta Business API):
 *     - GET  → Verification challenge (Meta webhook setup)
 *     - POST → WhatsApp message payload
 *       → Returns WhatsApp-formatted text response with media URLs
 *
 *  The search pipeline (knowledge base in Supabase, see 002_knowledge_base.sql,
 *  plus the Google Drive "Sales Kit" index, see 003_drive_index.sql):
 *    a) Embed the question with Gemini (gemini-embedding-001 @ 768)
 *    b) match_kb hybrid search (vector + full-text) — once for text
 *       knowledge (facts, Q&As, projects, expert answers, text of Drive
 *       PDFs/decks), once for media
 *    c) match_drive keyword search over Drive file names and folder paths
 *       (the drive_sync function keeps that index up to date)
 *    d) Gemini writes the answer from that context only and picks which
 *       photos/videos/Drive files fit; KB photos are served via signed URLs
 *       (bucket kb-media), Drive files through the get-image proxy
 *    e) Questions the knowledge base cannot answer go to kb_pending_questions
 *       for an expert to answer later
 *
 *  Deploy:
 *    supabase functions deploy process_chat_query
 *    supabase secrets set GEMINI_API_KEY=...
 *    supabase secrets set GOOGLE_DRIVE_FOLDER_ID=...
 *    supabase secrets set GOOGLE_SERVICE_ACCOUNT_JSON='...'
 *    supabase secrets set WHATSAPP_VERIFY_TOKEN=...
 *    (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically)
 * ═══════════════════════════════════════════════════════════════
 */


// ── Environment ──────────────────────────────────────────

// Values pasted into secrets sometimes keep wrapping <> or quotes
const env = (name: string, fallback = '') =>
  (Deno.env.get(name) ?? fallback).trim().replace(/^[<"' ]+|[>"' ]+$/g, '')

const GEMINI_API_KEY = env('GEMINI_API_KEY')
const WHATSAPP_VERIFY_TOKEN = env('WHATSAPP_VERIFY_TOKEN', 'sales_assistant_verify')
const SUPABASE_URL = env('SUPABASE_URL').replace(/\/$/, '')
const SUPABASE_SERVICE_ROLE = env('SUPABASE_SERVICE_ROLE_KEY')

// The "-latest" alias follows Google's current Flash-Lite, so it doesn't get retired
// under us like gemini-1.5-flash did. Lite answers in ~2s; full Flash took 30-140s in tests.
const CHAT_MODELS = [env('GEMINI_MODEL', 'gemini-flash-lite-latest'), 'gemini-2.5-flash-lite']
const LLM_TIMEOUT = 20 * 1000
const EMBED_MODEL = 'gemini-embedding-001'
const EMBED_DIM = 768
const MEDIA_BUCKET = 'kb-media'
const SIGNED_URL_TTL = 7 * 24 * 60 * 60 // 7 days, so links in saved chats keep working a while

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
}

const DB_HEADERS = {
  'Content-Type': 'application/json',
  apikey: SUPABASE_SERVICE_ROLE,
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
}

// ── Drive index search ───────────────────────────────────

interface DriveHit {
  id: string
  name: string
  mime_type: string
  kind: 'image' | 'video' | 'document' | 'folder'
  path: string | null
  web_view_link: string | null
  size: number | null
  duration_ms: number | null
  score: number
}

// Chat filler and "what kind of file" words. Kind words steer which file types rank first;
// none of them should count as a search term, or "photos" would match every photo folder.
const FILLER = new Set(('a an the of for in on at to and or with me us my our you your i we can could would please pls ' +
  'kindly share send show give get need want find any some all have has is are do does there this that these those ' +
  'from about related regarding latest new hi hello hey sir mam maam').split(' '))
const KIND_WORDS: Record<string, DriveHit['kind']> = {
  photo: 'image', photos: 'image', pic: 'image', pics: 'image', picture: 'image', pictures: 'image', image: 'image',
  images: 'image', img: 'image', render: 'image', renders: 'image',
  video: 'video', videos: 'video', reel: 'video', reels: 'video', film: 'video', clip: 'video', clips: 'video',
  pdf: 'document', pdfs: 'document', doc: 'document', docs: 'document', document: 'document', documents: 'document',
  brochure: 'document', brochures: 'document', catalogue: 'document', catalogues: 'document', catalog: 'document',
  catalogs: 'document', deck: 'document', ppt: 'document', presentation: 'document', certificate: 'document',
  certificates: 'document', sheet: 'document', datasheet: 'document', report: 'document', manual: 'document',
  guide: 'document', sop: 'document', file: 'document', files: 'document',
}
// Kind words that are also real file/folder names (Catalogues, Certifications, Technical Sheet...) stay searchable
const KIND_WORDS_SEARCHABLE = new Set(['brochure', 'brochures', 'catalogue', 'catalogues', 'catalog', 'catalogs',
  'certificate', 'certificates', 'sheet', 'report', 'manual', 'guide', 'sop', 'deck', 'presentation', 'render', 'renders'])

function parseDriveQuery(message: string) {
  const words = message.toLowerCase().replace(/[^a-z0-9+\s]/g, ' ').split(/\s+/).filter(Boolean)
  const kinds = new Set<DriveHit['kind']>()
  const terms: string[] = []
  for (const w of words) {
    if (KIND_WORDS[w]) kinds.add(KIND_WORDS[w])
    if (FILLER.has(w) || (KIND_WORDS[w] && !KIND_WORDS_SEARCHABLE.has(w))) continue
    terms.push(w)
  }
  return { terms: terms.join(' '), kinds: [...kinds] }
}

async function searchDrive(message: string): Promise<DriveHit[]> {
  const { terms, kinds } = parseDriveQuery(message)
  if (!terms) return []
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_drive`, {
      method: 'POST',
      headers: DB_HEADERS,
      body: JSON.stringify({ query_text: terms, kinds: null, match_count: 60 }),
      signal: AbortSignal.timeout(8 * 1000),
    })
    if (!resp.ok) throw new Error(`match_drive ${resp.status}: ${await resp.text()}`)
    const hits: DriveHit[] = await resp.json()
    // The same photo often sits in several folders; keep the best-scoring copy.
    const seen = new Set<string>()
    const unique = hits.filter((h) => {
      const key = `${h.kind}:${h.name.toLowerCase()}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    // Asked for photos/videos/documents: those types first, others after
    if (kinds.length > 0) {
      unique.sort((a, b) => Number(kinds.includes(b.kind)) - Number(kinds.includes(a.kind)) || b.score - a.score)
    }
    return unique.slice(0, 30)
  } catch (e) {
    console.error('[Drive] Search skipped:', (e as Error).message)
    return []
  }
}

function driveLine(f: DriveHit, i: number): string {
  const where = f.path ? `${f.path}/` : ''
  const extra = f.kind === 'video' && f.duration_ms ? ` (${Math.round(f.duration_ms / 1000)}s)` : ''
  return `[${i}] ${f.kind} | ${where}${f.name}${extra}`
}

function proxyUrl(fileId: string, params = '') {
  return `${SUPABASE_URL}/functions/v1/get-image?fileId=${fileId}${params}`
}

function driveViewUrl(f: DriveHit) {
  if (f.web_view_link) return f.web_view_link
  return f.kind === 'folder'
    ? `https://drive.google.com/drive/folders/${f.id}`
    : `https://drive.google.com/file/d/${f.id}/view`
}

// ── Gemini ───────────────────────────────────────────────

async function embedQuery(text: string): Promise<number[] | null> {
  if (!GEMINI_API_KEY) return null
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent?key=${GEMINI_API_KEY}`
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `models/${EMBED_MODEL}`,
        content: { parts: [{ text }] },
        taskType: 'RETRIEVAL_QUERY',
        outputDimensionality: EMBED_DIM,
      }),
      signal: AbortSignal.timeout(10 * 1000),
    })
    if (!resp.ok) {
      console.error('[Gemini embed] Error:', resp.status, await resp.text())
      return null // full-text search still works without the vector
    }
    const data = await resp.json()
    return data?.embedding?.values ?? null
  } catch (e) {
    console.error('[Gemini embed] Failed:', e)
    return null
  }
}

interface LlmAnswer {
  answer: string
  answered: boolean
  media_ids: number[]
  drive_ids?: number[]
}

const ANSWER_SCHEMA = {
  type: 'OBJECT',
  properties: {
    answer: { type: 'STRING' },
    answered: { type: 'BOOLEAN' },
    media_ids: { type: 'ARRAY', items: { type: 'INTEGER' } },
    drive_ids: { type: 'ARRAY', items: { type: 'INTEGER' } },
  },
  required: ['answer', 'answered', 'media_ids', 'drive_ids'],
}

async function callGemini(question: string, knowledge: string, media: string, drive: string): Promise<LlmAnswer | null> {
  if (!GEMINI_API_KEY) return null

  const systemPrompt = `You are the Stonelam Sales Assistant. Stonelam makes large porcelain slabs for facades, flooring, walls, kitchens and furniture. Sales team members ask you about shades, applications, projects, technical details and ask for photos, videos, brochures, catalogues, certificates and other files from the company Drive.

Rules:
- Answer ONLY from the knowledge and media lists below. Never invent shades, projects, sizes or specs.
- Never share prices, rates, phone numbers or email addresses, even if they appear in the knowledge. For price questions, say prices come from the regional sales head or the current price list, and set "answered" to true.
- Be short and practical: 1-4 sentences, plain language. Name shades and projects when relevant.
- Set "answered" to false if the knowledge does not actually answer the question; then say briefly that you don't have this yet and that you've passed it to the product team.
- In "media_ids", list ids of photos/videos from "Photos and videos" that genuinely match the request (best first, at most 8). Use an empty list if none fit or photos would not help.
- In "drive_ids", list ids from "Drive files" that genuinely match the request (best first, at most 8): the brochure, catalogue, certificate, sheet, deck, video or photos asked for, plus any document the answer came from. Folder paths tell you the shade, thickness, city or application (e.g. "Application/3mm/Oxide Moro/Exterior"). If a whole folder fits better than single files, include the folder. Use an empty list if nothing fits.
- If the files themselves answer the request (e.g. "send the kitchen brochure"), say briefly what you are sharing and set "answered" to true.

Knowledge:
${knowledge || '(nothing relevant found)'}

Photos and videos:
${media || '(none found)'}

Drive files:
${drive || '(none found)'}`

  for (const model of CHAT_MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(LLM_TIMEOUT),
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: question }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 1024,
            responseMimeType: 'application/json',
            responseSchema: ANSWER_SCHEMA,
          },
        }),
      })
      if (!resp.ok) {
        console.error(`[Gemini ${model}] Error:`, resp.status, await resp.text())
        continue
      }
      const data = await resp.json()
      const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('')
      const parsed = JSON.parse(text)
      if (typeof parsed?.answer === 'string') return parsed as LlmAnswer
    } catch (e) {
      console.error(`[Gemini ${model}] Failed:`, e)
    }
  }
  return null
}

// ── Knowledge base (Supabase) ────────────────────────────

interface KbItem {
  id: number
  kind: string
  title: string | null
  body: string
  shades: string[]
  applications: string[]
  media_path: string | null
  media_type: string | null
  meta: any
  score: number
}

async function matchKb(query: string, embedding: number[] | null, kinds: string[], count: number): Promise<KbItem[]> {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_kb`, {
    method: 'POST',
    headers: DB_HEADERS,
    body: JSON.stringify({
      query_text: query,
      query_embedding: embedding ? `[${embedding.join(',')}]` : null,
      match_count: count,
      kinds,
    }),
  })
  if (!resp.ok) throw new Error(`match_kb ${resp.status}: ${await resp.text()}`)
  return await resp.json()
}

async function signMedia(paths: string[]): Promise<Record<string, string>> {
  if (paths.length === 0) return {}
  const resp = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${MEDIA_BUCKET}`, {
    method: 'POST',
    headers: DB_HEADERS,
    body: JSON.stringify({ expiresIn: SIGNED_URL_TTL, paths }),
  })
  if (!resp.ok) {
    console.error('[Storage] Sign failed:', resp.status, await resp.text())
    return {}
  }
  const out: Record<string, string> = {}
  for (const r of await resp.json()) {
    const signed = r.signedURL || r.signedUrl
    if (r.path && signed) out[r.path] = `${SUPABASE_URL}/storage/v1${signed}`
  }
  return out
}

function mediaLine(m: KbItem): string {
  const ai = m.meta?.ai ?? {}
  const bits = [
    m.media_type,
    m.title,
    m.shades?.length ? `shades: ${m.shades.join(', ')}` : '',
    m.applications?.length ? `applications: ${m.applications.join(', ')}` : '',
    ai.building_type ? `building: ${ai.building_type}` : '',
  ].filter(Boolean)
  return `[${m.id}] ${bits.join(' | ')}`
}

async function logQuery(message: string, matched: number, answered: boolean, usedLlm: boolean) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/chat_logs`, {
      method: 'POST',
      headers: DB_HEADERS,
      body: JSON.stringify({ query: message, matched_count: matched, confident: answered, used_llm: usedLlm }),
    })
  } catch (e) {
    console.error('[Supabase] Failed to log query:', e)
  }
}

async function savePendingQuestion(question: string, askedBy: string, channel: string) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/kb_pending_questions`, {
      method: 'POST',
      headers: DB_HEADERS,
      body: JSON.stringify({ question, asked_by: askedBy || null, channel }),
    })
  } catch (e) {
    console.error('[Supabase] Failed to save pending question:', e)
  }
}

// ── Main processing logic ────────────────────────────────

interface ProcessResult {
  response: string
  media_urls: any[]
  video_urls: any[]
  documents: any[]
}

async function processQuery(message: string, userId = '', channel = 'web'): Promise<ProcessResult> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    throw new Error('Knowledge base not configured: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing.')
  }

  // Step 1: Embed the question, then search text knowledge, media and the Drive index in parallel
  const embedding = await embedQuery(message)
  const [knowledge, media, driveHits] = await Promise.all([
    matchKb(message, embedding, ['fact', 'qa', 'project', 'expert_answer', 'document'], 10),
    matchKb(message, embedding, ['media'], 16),
    searchDrive(message),
  ])

  // Documents the knowledge came from are offered as Drive files too, so they can be attached
  const drive: DriveHit[] = [...driveHits]
  for (const k of knowledge) {
    const d = k.meta?.drive
    if (k.kind === 'document' && d?.id && !drive.some((f) => f.id === d.id)) {
      drive.push({ id: d.id, name: d.name, mime_type: d.mime_type, kind: 'document', path: d.path ?? null,
        web_view_link: d.web_view_link ?? null, size: null, duration_ms: null, score: 0 })
    }
  }

  // Step 2: Let Gemini answer from that context and pick matching media and files
  const knowledgeText = knowledge.map((k) =>
    k.kind === 'document'
      ? `- From document "${k.meta?.drive?.name ?? k.title}": ${k.body}`
      : `- ${k.title ? k.title + ': ' : ''}${k.body}`
  ).join('\n')
  const mediaText = media.map(mediaLine).join('\n')
  const driveText = drive.map((f, i) => driveLine(f, i + 1)).join('\n')
  const llm = await callGemini(message, knowledgeText, mediaText, driveText)

  let responseText: string
  let answered: boolean
  let picked: KbItem[]
  let pickedDrive: DriveHit[]

  if (llm) {
    responseText = llm.answer
    answered = llm.answered
    const byId = new Map(media.map((m) => [m.id, m]))
    picked = (llm.media_ids ?? []).map((id) => byId.get(id)).filter(Boolean) as KbItem[]
    pickedDrive = [...new Set(llm.drive_ids ?? [])].map((i) => drive[i - 1]).filter(Boolean)
  } else {
    // Gemini unavailable: fall back to the top search hits without a written answer
    picked = media.slice(0, 6)
    pickedDrive = driveHits.slice(0, 6)
    answered = knowledge.length > 0 || picked.length > 0 || pickedDrive.length > 0
    responseText = knowledge.length > 0
      ? `Here is what I found:\n${knowledge.slice(0, 3).map((k) => `• ${k.title ?? k.body.slice(0, 160)}`).join('\n')}`
      : picked.length > 0 || pickedDrive.length > 0
        ? 'Here are the closest files I found:'
        : `I couldn't find anything on "${message}" yet. I've passed the question to the product team.`
  }

  if (!answered && picked.length === 0 && pickedDrive.length === 0) {
    await savePendingQuestion(message, userId, channel)
  }

  // Step 3: Signed URLs for the chosen photos/videos (private bucket)
  const urls = await signMedia(picked.map((m) => m.media_path!).filter(Boolean))
  const withUrl = picked.filter((m) => m.media_path && urls[m.media_path])

  const mediaResults: any[] = withUrl.filter((m) => m.media_type !== 'video').map((m) => ({
    name: m.title ?? m.media_path,
    url: urls[m.media_path!],
    thumbnail: urls[m.media_path!],
  }))

  const videoResults: any[] = withUrl.filter((m) => m.media_type === 'video').map((m) => ({
    name: m.title ?? m.media_path,
    mime_type: 'video/mp4',
    url: urls[m.media_path!],
    thumbnail: null,
  }))

  // Step 4: Drive files Gemini picked. Previews go through the get-image proxy so they work
  // without a Google login; originals can be huge (25MB PNGs, 1GB videos), so photos use a
  // large thumbnail and the "Open in Drive" link leads to the full-resolution file.
  for (const f of pickedDrive) {
    if (f.kind === 'image') {
      mediaResults.push({ name: f.name, url: proxyUrl(f.id, '&thumb=1600'), thumbnail: proxyUrl(f.id, '&thumb=600'), web_view_link: driveViewUrl(f) })
    }
  }
  for (const f of pickedDrive) {
    if (f.kind === 'video') {
      videoResults.push({ name: f.name, mime_type: f.mime_type, url: proxyUrl(f.id), thumbnail: proxyUrl(f.id, '&thumb=800'), web_view_link: driveViewUrl(f) })
    }
  }
  const docResults = pickedDrive.filter((f) => f.kind === 'document' || f.kind === 'folder').map((f) => ({
    name: f.kind === 'folder' ? `Folder: ${f.path ? f.path + '/' : ''}${f.name}` : f.name,
    mime_type: f.mime_type,
    type: f.kind === 'folder' ? 'folder' : undefined,
    url: f.kind === 'folder' ? driveViewUrl(f) : proxyUrl(f.id),
    web_view_link: driveViewUrl(f),
  }))

  await logQuery(message, knowledge.length + media.length + docResults.length, answered, Boolean(llm))

  return {
    response: responseText,
    media_urls: mediaResults,
    video_urls: videoResults,
    documents: docResults,
  }
}

// ── WhatsApp webhook formatting ──────────────────────────

function formatWhatsAppResponse(result: ProcessResult): string {
  let text = result.response

  if (result.media_urls.length > 0) {
    text += '\n\n*Images:*\n'
    result.media_urls.forEach((m, i) => {
      text += `${i + 1}. ${m.name}\n`
    })
  }

  if (result.documents.length > 0) {
    text += '\n*Documents:*\n'
    result.documents.forEach((d, i) => {
      text += `${i + 1}. ${d.name}\n${d.url}\n`
    })
  }

  return text
}

// ── HTTP Handler ─────────────────────────────────────────

Deno.serve(async (req: Request) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }

  // ── WhatsApp Webhook Verification (GET) ──
  if (req.method === 'GET') {
    const url = new URL(req.url)
    const mode = url.searchParams.get('hub.mode')
    const token = url.searchParams.get('hub.verify_token')
    const challenge = url.searchParams.get('hub.challenge')

    if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN && challenge) {
      console.log('[WhatsApp] Webhook verified successfully')
      return new Response(challenge, { status: 200 })
    }

    return new Response('Forbidden', { status: 403 })
  }

  // ── POST: Process message ──
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  }

  try {
    const body = await req.json()
    console.log('[Request] Body:', JSON.stringify(body, null, 2))

    // ── Detect WhatsApp payload ──
    const isWhatsApp = body.object === 'whatsapp_business_account' ||
      body.entry?.[0]?.changes?.[0]?.value?.messages

    let message = ''
    let userId = ''
    let sessionId: string | undefined
    let waMessageId: string | undefined
    let waPhoneNumber: string | undefined

    if (isWhatsApp) {
      // ─── WhatsApp message ───
      const msg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]
      if (!msg) {
        // Status update or non-message event
        return new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        })
      }

      message = msg.text?.body || msg.button?.text || msg.interactive?.button_reply?.title || ''
      userId = msg.from || ''
      waMessageId = msg.id
      waPhoneNumber = body.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.wa_id

      if (!message) {
        return new Response(JSON.stringify({ status: 'ok', message: 'No text in message' }), {
          status: 200,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        })
      }
    } else {
      // ─── Web UI message ───
      message = body.message || ''
      userId = body.user_id || ''
      sessionId = body.session_id
    }

    if (!message) {
      return new Response(
        JSON.stringify({ error: 'Message is required' }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      )
    }

    // Process the query
    const result = await processQuery(message, userId, isWhatsApp ? 'whatsapp' : 'web')

    // ── Return response ──
    if (isWhatsApp) {
      // WhatsApp webhook: return 200 immediately with formatted text.
      // In production, you would use the WhatsApp Business API to send
      // the message back asynchronously. This structure is ready for that.
      const waResponse = formatWhatsAppResponse(result)

      // TODO: Send reply via WhatsApp Cloud API
      // await sendWhatsAppMessage(userId, waResponse, result.media_urls)
      // For now, return the formatted response in the webhook response:
      return new Response(
        JSON.stringify({
          status: 'ok',
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: userId,
          type: 'text',
          text: { body: waResponse },
          media_urls: result.media_urls.map((m) => m.thumbnail),
          document_urls: result.documents.map((d) => d.url),
        }),
        { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      )
    } else {
      // Web UI: return structured JSON
      return new Response(
        JSON.stringify({
          response: result.response,
          media_urls: result.media_urls,
          video_urls: result.video_urls,
          documents: result.documents,
          meta: {
            matched_count: result.media_urls.length + result.video_urls.length + result.documents.length,
            session_id: sessionId,
          },
        }),
        { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      )
    }
  } catch (error) {
    console.error('[Error]', error)
    return new Response(
      JSON.stringify({
        error: 'Internal server error',
        message: (error as Error).message,
      }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    )
  }
})