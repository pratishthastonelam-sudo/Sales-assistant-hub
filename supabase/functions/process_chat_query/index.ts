/**
 * ═══════════════════════════════════════════════════════════════
 *  process_chat_query — Supabase Edge Function
 * ═══════════════════════════════════════════════════════════════
 *
 *  This function is intentionally dual-purpose:
 *
 *  1. WEB UI: Receives POST { message, user_id, session_id }
 *     → Returns { response, media_urls, documents }
 *
 *  2. WHATSAPP WEBHOOK (ready for Meta Business API):
 *     - GET  → Verification challenge (Meta webhook setup)
 *     - POST → WhatsApp message payload
 *       → Returns WhatsApp-formatted text response with media URLs
 *
 *  The search pipeline:
 *    a) Fetch Google Drive files (cached)
 *    b) Fuse.js fuzzy search (typo correction — credit saver)
 *    c) If confident match → return files directly (NO LLM call)
 *    d) If ambiguous → call LLM with file context (saves credits)
 *
 *  Deploy:
 *    supabase functions deploy process_chat_query
 *    supabase secrets set GOOGLE_DRIVE_FOLDER_ID=...
 *    supabase secrets set GOOGLE_SERVICE_ACCOUNT_JSON='...'
 *    supabase secrets set GEMINI_API_KEY=...
 *    supabase secrets set WHATSAPP_VERIFY_TOKEN=...
 * ═══════════════════════════════════════════════════════════════
 */

import {
  listDriveFiles,
  categorizeFiles,
  getImageUrl,
  getFileViewUrl,
  getFileDownloadUrl,
} from './googleDrive.ts'
import {
  fuzzySearch,
  hasConfidentMatch,
  formatFileContext,
} from './fuseSearch.ts'

// ── Environment ──────────────────────────────────────────

const FOLDER_ID = Deno.env.get('GOOGLE_DRIVE_FOLDER_ID') ?? ''
const SA_JSON = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON') ?? ''
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') ?? ''
const WHATSAPP_VERIFY_TOKEN = Deno.env.get('WHATSAPP_VERIFY_TOKEN') ?? 'sales_assistant_verify'
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
}

// ── Drive file cache (in-memory, refreshes every 5 min) ──

let cachedFiles: any[] = []
let cacheTime = 0
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

async function getDriveFiles() {
  const now = Date.now()
  if (cachedFiles.length > 0 && now - cacheTime < CACHE_TTL) {
    return cachedFiles
  }

  if (!FOLDER_ID || !SA_JSON) {
    throw new Error('Google Drive not configured. Set GOOGLE_DRIVE_FOLDER_ID and GOOGLE_SERVICE_ACCOUNT_JSON secrets.')
  }

  const sa = JSON.parse(SA_JSON)
  cachedFiles = await listDriveFiles(FOLDER_ID, sa)
  cacheTime = now
  console.log(`[Drive] Fetched ${cachedFiles.length} files from folder ${FOLDER_ID}`)
  return cachedFiles
}

// ── LLM call (Gemini) ────────────────────────────────────

async function callGemini(prompt: string, fileContext: string): Promise<string> {
  if (!GEMINI_API_KEY) {
    // Fallback: return a simple summary if no LLM is configured
    return `I found relevant files for your query "${prompt}". Here are the results from the Drive:`
  }

  const systemPrompt = `You are a helpful Sales Assistant. A sales team member is looking for information.
Based on the user's query and the Google Drive files found, provide a concise, professional response.
Reference specific files by name when relevant. Keep it under 3 sentences.

Available files:
${fileContext}`

  const userPrompt = `User query: "${prompt}"`

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 300,
        },
      }),
    }
  )

  if (!resp.ok) {
    console.error('[Gemini] Error:', resp.status, await resp.text())
    return `I found relevant files for "${prompt}". Please check the results below.`
  }

  const data = await resp.json()
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text
  return text || `I found files matching "${prompt}". See results below.`
}

// ── Main processing logic ────────────────────────────────

interface ProcessResult {
  response: string
  media_urls: any[]
  documents: any[]
}

async function processQuery(message: string, _userId?: string): Promise<ProcessResult> {
  // Step 1: Fetch Drive files (cached)
  const allFiles = await getDriveFiles()

  // Step 2: Fuse.js fuzzy search (typo correction)
  const matchedFiles = fuzzySearch(message, allFiles, 20)
  const confident = hasConfidentMatch(message, allFiles)

  // Step 3: Categorize matches
  const { images, documents } = categorizeFiles(matchedFiles)

  // Step 4: Format media + document results
  const mediaResults = images.slice(0, 10).map((f: any) => ({
    name: f.name,
    url: getFileDownloadUrl(f),
    thumbnail: f.thumbnailLink || getImageUrl(f),
    web_view_link: getFileViewUrl(f),
  }))

  const docResults = documents.slice(0, 10).map((f: any) => ({
    name: f.name,
    mime_type: f.mimeType,
    url: getFileDownloadUrl(f),
    web_view_link: getFileViewUrl(f),
  }))

  // Step 5: Generate response text
  let responseText: string

  if (matchedFiles.length === 0) {
    // No matches found — no LLM call needed (credit saver)
    responseText = `I couldn't find any files matching "${message}" in the Drive. Could you try rephrasing or check if the file exists?`
  } else if (confident && matchedFiles.length <= 5) {
    // Confident match — skip LLM entirely (credit saver)
    const fileList = matchedFiles.map((f: any) => f.name).join(', ')
    responseText = `I found ${matchedFiles.length} file(s) matching your query: ${fileList}. Here are the results:`
  } else {
    // Ambiguous or many matches — use LLM with file context (but only with cached results, not a fresh search)
    const fileContext = formatFileContext(matchedFiles.slice(0, 15))
    responseText = await callGemini(message, fileContext)
  }

  // Step 6: Log to Supabase (non-blocking)
  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE) {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/chat_logs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        },
        body: JSON.stringify({
          query: message,
          matched_count: matchedFiles.length,
          confident: confident,
          used_llm: !confident && matchedFiles.length > 0,
        }),
      })
    } catch (e) {
      console.error('[Supabase] Failed to log query:', e)
    }
  }

  return {
    response: responseText,
    media_urls: mediaResults,
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
      text += `${i + 1}. ${d.name}\n${d.web_view_link}\n`
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
    const result = await processQuery(message, userId)

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
          documents: result.documents,
          meta: {
            matched_count: result.media_urls.length + result.documents.length,
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
        message: error.message,
      }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    )
  }
})
