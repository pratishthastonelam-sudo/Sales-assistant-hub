/**
 * ═══════════════════════════════════════════════════════════════
 *  whatsapp_webhook — Supabase Edge Function
 * ═══════════════════════════════════════════════════════════════
 *
 *  The WhatsApp side of the Sales Assistant (Meta WhatsApp Cloud API).
 *  Kept separate from process_chat_query so the web app is untouched:
 *  answers come from process_chat_query over HTTP, exactly as the web app
 *  gets them, and this function turns them into WhatsApp messages.
 *
 *  - GET              → Meta webhook verification (hub.challenge)
 *  - POST (from Meta) → signed with the app secret (X-Hub-Signature-256);
 *                       we answer 200 at once and work in the background
 *  - POST ?action=setup|status (service-role key) → one-off setup: subscribe
 *                       the webhook, register the number, create templates
 *
 *  Who may talk to the bot is the wa_contacts table (005_whatsapp.sql):
 *    sales  — asks questions, gets text + photos, videos and documents back
 *    expert — also receives questions the bot can't answer; a swipe-reply
 *             (or "#12 answer") saves the answer to the knowledge base and
 *             sends it to whoever asked
 *    admin  — also manages the list from WhatsApp: "add 98… Name", "team"…
 *
 *  Outside WhatsApp's 24-hour window only approved templates can be sent,
 *  so expert pings and late answers fall back to the templates below.
 *
 *  Secrets: WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_APP_SECRET,
 *  WHATSAPP_VERIFY_TOKEN; optional WHATSAPP_PIN (number registration),
 *  WHATSAPP_GRAPH_URL (tests only). GEMINI_API_KEY for voice notes and
 *  embedding expert answers.
 * ═══════════════════════════════════════════════════════════════
 */

// ── Environment ──────────────────────────────────────────

// Values pasted into secrets sometimes keep wrapping <> or quotes
const env = (name: string, fallback = '') =>
  (Deno.env.get(name) ?? fallback).trim().replace(/^[<"' ]+|[>"' ]+$/g, '')

const SUPABASE_URL = env('SUPABASE_URL').replace(/\/$/, '')
const SUPABASE_SERVICE_ROLE = env('SUPABASE_SERVICE_ROLE_KEY')
const GEMINI_API_KEY = env('GEMINI_API_KEY')
const WA_TOKEN = env('WHATSAPP_TOKEN')
const WA_PHONE_ID = env('WHATSAPP_PHONE_NUMBER_ID')
const WA_APP_SECRET = env('WHATSAPP_APP_SECRET')
const WA_VERIFY_TOKEN = env('WHATSAPP_VERIFY_TOKEN')
const WA_PIN = env('WHATSAPP_PIN')
const GRAPH = env('WHATSAPP_GRAPH_URL', 'https://graph.facebook.com/v24.0').replace(/\/$/, '')
const SELF_URL = `${SUPABASE_URL}/functions/v1/whatsapp_webhook`

const VOICE_MODELS = [env('GEMINI_MODEL', 'gemini-flash-lite-latest'), 'gemini-2.5-flash-lite']
const EMBED_MODEL = 'gemini-embedding-001'
const EMBED_DIM = 768

const MAX_IMAGES = 6
const MAX_VIDEOS = 3
const MAX_DOCS = 4
const WINDOW_MS = 23.5 * 60 * 60 * 1000 // a little under WhatsApp's 24h, for clock drift
const DEFAULT_COUNTRY = '91'
const WEB_APP_URL = env('WEB_APP_URL', 'https://sales-assistant-hub-1svt.vercel.app')

// Templates for messages outside the 24h window (created by ?action=setup, approved by Meta)
const TEMPLATES = {
  question: {
    name: 'sales_bot_expert_question',
    text: 'New question for the product team from {{1}}:\n\n"{{2}}"\n\n' +
      'Please swipe-reply to this message with the answer. It will be saved for the whole sales team. (Ref {{3}})',
    example: ['Rahul', 'Is Oxide Moro available in 6mm?', '#12'],
  },
  answer: {
    name: 'sales_bot_expert_answer',
    text: 'The product team has answered your question "{{1}}":\n\n{{2}}\n\nThis answer is now saved in the sales assistant.',
    example: ['Is Oxide Moro available in 6mm?', 'Yes, Oxide Moro comes in 3mm, 6mm and 12mm.'],
  },
}

const DB_HEADERS = {
  'Content-Type': 'application/json',
  apikey: SUPABASE_SERVICE_ROLE,
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { 'Content-Type': 'application/json' } })

// ── Database (PostgREST) ─────────────────────────────────

async function db(path: string, init: RequestInit = {}, prefer = 'return=representation'): Promise<any> {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { ...DB_HEADERS, Prefer: prefer, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(10 * 1000),
  })
  const text = await resp.text()
  if (!resp.ok) throw new Error(`db ${path.split('?')[0]} ${resp.status}: ${text}`)
  return text ? JSON.parse(text) : null
}

interface Contact {
  phone: string
  name: string | null
  role: 'sales' | 'expert' | 'admin'
  active: boolean
  last_inbound_at: string | null
}

async function getContact(phone: string): Promise<Contact | null> {
  const rows = await db(`wa_contacts?phone=eq.${phone}&select=*`, {}, '')
  return rows?.[0] ?? null
}

async function logMessage(row: Record<string, unknown>) {
  try {
    await db('wa_messages', { method: 'POST', body: JSON.stringify(row) }, 'return=minimal,resolution=ignore-duplicates')
  } catch (e) {
    console.error('[WA] log failed:', (e as Error).message)
  }
}

const inWindow = (c: Contact | null) =>
  Boolean(c?.last_inbound_at && Date.now() - new Date(c.last_inbound_at).getTime() < WINDOW_MS)

// "+91 98123 45678", "098123 45678", "9812345678" → 919812345678
function normalisePhone(raw: string): string | null {
  let d = raw.replace(/\D/g, '')
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1)
  if (d.length === 10) d = DEFAULT_COUNTRY + d
  return /^[0-9]{11,15}$/.test(d) ? d : null
}

const pretty = (phone: string) => `+${phone}`
const displayName = (c: Contact | null, phone: string) => c?.name || pretty(phone)

// ── WhatsApp Cloud API ───────────────────────────────────

class WaError extends Error {
  constructor(message: string, public code?: number) {
    super(message)
  }
}

async function graph(path: string, body?: unknown, token = WA_TOKEN, method = body ? 'POST' : 'GET'): Promise<any> {
  const resp = await fetch(`${GRAPH}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20 * 1000),
  })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok) throw new WaError(`graph ${path} ${resp.status}: ${JSON.stringify(data?.error ?? data)}`, data?.error?.code)
  return data
}

interface SendOpts {
  pendingId?: number
  fallback?: string // text to send if this media message later fails to deliver
  logBody?: string
}

async function send(to: string, payload: Record<string, unknown>, opts: SendOpts = {}): Promise<string | null> {
  const data = await graph(`${WA_PHONE_ID}/messages`, { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...payload })
  const id = data?.messages?.[0]?.id ?? null
  if (id) {
    const type = String(payload.type)
    const content: any = payload[type]
    await logMessage({
      id, direction: 'out', phone: to, kind: type, status: 'sent',
      body: opts.logBody ?? content?.body ?? content?.link ?? content?.name ?? null,
      pending_id: opts.pendingId ?? null, fallback: opts.fallback ?? null,
    })
  }
  return id
}

// WhatsApp uses *bold* and _italic_; Gemini sometimes writes markdown **bold**
const waFormat = (s: string) => s.replace(/\*\*(.+?)\*\*/g, '*$1*').replace(/^#+\s*/gm, '').slice(0, 4000)

const sendText = (to: string, text: string, opts: SendOpts = {}) =>
  send(to, { type: 'text', text: { body: waFormat(text), preview_url: false } }, opts)

// Template parameters may not contain newlines, tabs or more than 4 spaces in a row
const param = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return { type: 'text', text: flat.length > max ? flat.slice(0, max - 1) + '…' : flat }
}

const sendTemplate = (to: string, name: string, params: { type: string; text: string }[], opts: SendOpts = {}) =>
  send(to, {
    type: 'template',
    template: { name, language: { code: 'en' }, components: [{ type: 'body', parameters: params }] },
  }, { ...opts, logBody: opts.logBody ?? `[${name}] ${params.map((p) => p.text).join(' | ')}` })

async function markRead(messageId: string) {
  try {
    await graph(`${WA_PHONE_ID}/messages`, {
      messaging_product: 'whatsapp', status: 'read', message_id: messageId, typing_indicator: { type: 'text' },
    })
  } catch (e) {
    console.error('[WA] mark read failed:', (e as Error).message)
  }
}

// ── Voice notes (Gemini transcription) ───────────────────

async function transcribe(mediaId: string): Promise<string | null> {
  if (!GEMINI_API_KEY) return null
  try {
    const meta = await graph(mediaId)
    const audio = await fetch(meta.url, { headers: { Authorization: `Bearer ${WA_TOKEN}` }, signal: AbortSignal.timeout(20 * 1000) })
    if (!audio.ok) throw new Error(`media download ${audio.status}`)
    const bytes = new Uint8Array(await audio.arrayBuffer())
    let bin = ''
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    const mime = (meta.mime_type || 'audio/ogg').split(';')[0]

    for (const model of VOICE_MODELS) {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(30 * 1000),
          body: JSON.stringify({
            contents: [{
              role: 'user',
              parts: [
                { text: 'This is a voice note from a Stonelam salesperson (porcelain slabs and facades). It may be in English, Hindi or Hinglish. Write what they are asking as one clear English sentence. Keep shade, product and project names as spoken. Reply with that sentence only.' },
                { inline_data: { mime_type: mime, data: btoa(bin) } },
              ],
            }],
            generationConfig: { temperature: 0 },
          }),
        },
      )
      if (!resp.ok) {
        console.error(`[Voice ${model}]`, resp.status, await resp.text())
        continue
      }
      const data = await resp.json()
      const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('').trim()
      if (text) return text
    }
  } catch (e) {
    console.error('[Voice] failed:', (e as Error).message)
  }
  return null
}

async function embed(text: string): Promise<number[] | null> {
  if (!GEMINI_API_KEY) return null
  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10 * 1000),
        body: JSON.stringify({
          model: `models/${EMBED_MODEL}`,
          content: { parts: [{ text }] },
          taskType: 'RETRIEVAL_DOCUMENT',
          outputDimensionality: EMBED_DIM,
        }),
      },
    )
    if (!resp.ok) throw new Error(`${resp.status} ${await resp.text()}`)
    return (await resp.json())?.embedding?.values ?? null
  } catch (e) {
    console.error('[Embed] failed:', (e as Error).message)
    return null // full-text search still finds the answer
  }
}

// ── Answering a salesperson ──────────────────────────────

async function askBot(question: string, phone: string): Promise<any> {
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/process_chat_query`, {
    method: 'POST',
    headers: DB_HEADERS,
    body: JSON.stringify({ message: question, user_id: phone }),
    signal: AbortSignal.timeout(90 * 1000),
  })
  if (!resp.ok) throw new Error(`process_chat_query ${resp.status}: ${await resp.text()}`)
  return await resp.json()
}

const GOOGLE_NATIVE = /^application\/vnd\.google-apps\./

async function answerQuestion(question: string, phone: string, contact: Contact) {
  const startedAt = new Date(Date.now() - 5000).toISOString()
  let result: any
  try {
    result = await askBot(question, phone)
  } catch (e) {
    console.error('[WA] bot failed:', (e as Error).message)
    await sendText(phone, "Sorry, I couldn't look that up just now. Please try again in a minute.")
    return
  }

  await sendText(phone, result.response || "I couldn't find anything on that yet.")

  // Photos, videos and files, each as its own WhatsApp message; links only when a file can't be attached
  const links: string[] = []
  const images: any[] = result.media_urls ?? []
  for (const m of images.slice(0, MAX_IMAGES)) {
    const fallback = m.web_view_link ? `🖼️ ${m.name}\n${m.web_view_link}` : `🖼️ ${m.name}\n${m.url}`
    await sendMedia(phone, { type: 'image', image: { link: m.url } }, fallback, m.name)
  }
  if (images.length > MAX_IMAGES) links.push(`+${images.length - MAX_IMAGES} more photos in the web app: ${WEB_APP_URL}`)

  const videos: any[] = result.video_urls ?? []
  for (const v of videos.slice(0, MAX_VIDEOS)) {
    await sendMedia(phone, { type: 'video', video: { link: v.url, caption: v.name } }, `▶️ ${v.name}\n${v.url}`, v.name)
  }
  for (const v of videos.slice(MAX_VIDEOS)) links.push(`▶️ ${v.name}\n${v.url}`)

  const docs: any[] = result.documents ?? []
  let attached = 0
  for (const d of docs) {
    const link = d.web_view_link || d.url
    if (d.type === 'folder' || GOOGLE_NATIVE.test(d.mime_type ?? '') || attached >= MAX_DOCS) {
      links.push(`${d.type === 'folder' ? '📁' : '📄'} ${d.name}\n${link}`)
      continue
    }
    attached++
    await sendMedia(phone, { type: 'document', document: { link: d.url, filename: d.name } }, `📄 ${d.name}\n${link}`, d.name)
  }
  if (links.length) await sendText(phone, links.join('\n\n'))

  // process_chat_query saves questions it couldn't answer; pass those to the experts
  const pending = await db(
    `kb_pending_questions?asked_by=eq.${phone}&status=eq.open&created_at=gte.${encodeURIComponent(startedAt)}` +
      `&question=eq.${encodeURIComponent(question)}&order=id.desc&limit=1`, {}, '',
  )
  if (pending?.[0]) await forwardToExperts(pending[0].id, question, phone, contact)
}

async function sendMedia(to: string, payload: Record<string, unknown>, fallback: string, name: string) {
  try {
    await send(to, payload, { fallback, logBody: name })
  } catch (e) {
    // Rejected straight away (bad link, too big…): send the link instead
    console.error('[WA] media send failed:', (e as Error).message)
    await sendText(to, fallback)
  }
}

// ── Expert loop ──────────────────────────────────────────

async function forwardToExperts(pendingId: number, question: string, askerPhone: string, asker: Contact | null) {
  const experts: Contact[] = await db('wa_contacts?role=eq.expert&active=eq.true&select=*', {}, '')
  await db(`kb_pending_questions?id=eq.${pendingId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      channel: 'whatsapp',
      status: experts.length ? 'forwarded' : 'open',
      expert: experts.map((e) => e.phone).join(',') || null,
    }),
  }, 'return=minimal')

  const who = displayName(asker, askerPhone)
  for (const ex of experts) {
    if (ex.phone === askerPhone) continue
    try {
      if (inWindow(ex)) {
        await sendText(ex.phone,
          `❓ *Question #${pendingId}* from ${who}:\n\n"${question}"\n\n` +
            `Swipe-reply to this message with the answer and I'll save it for the whole team. ` +
            `Or send *#${pendingId} your answer*, or *skip ${pendingId}* if it shouldn't be answered.`,
          { pendingId })
      } else {
        await sendTemplate(ex.phone, TEMPLATES.question.name,
          [param(who, 60), param(question, 400), param(`#${pendingId}`, 12)], { pendingId })
      }
    } catch (e) {
      console.error(`[WA] forward to ${ex.phone} failed:`, (e as Error).message)
    }
  }
}

async function saveExpertAnswer(pendingId: number, answer: string, expertPhone: string, expert: Contact) {
  const rows = await db(`kb_pending_questions?id=eq.${pendingId}&select=*`, {}, '')
  const q = rows?.[0]
  if (!q) {
    await sendText(expertPhone, `I can't find question #${pendingId}.`)
    return
  }
  const updating = q.status === 'answered'

  // Into the knowledge base, so the bot answers this itself next time
  const body = `Q: ${q.question}\nA: ${answer}`
  const vector = await embed(body)
  const item = await db('kb_items?on_conflict=source_id', {
    method: 'POST',
    body: JSON.stringify({
      source_id: `expert:${pendingId}`,
      kind: 'expert_answer',
      title: q.question,
      body,
      source: 'whatsapp_expert',
      item_date: new Date().toISOString().slice(0, 10),
      meta: { pending_id: pendingId, expert: expertPhone, expert_name: expert.name },
      embedding: vector ? `[${vector.join(',')}]` : null,
      updated_at: new Date().toISOString(),
    }),
  }, 'return=representation,resolution=merge-duplicates')

  await db(`kb_pending_questions?id=eq.${pendingId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      status: 'answered', answer, expert: expertPhone,
      answered_at: new Date().toISOString(), kb_item_id: item?.[0]?.id ?? null,
    }),
  }, 'return=minimal')

  // Back to whoever asked, if they asked on WhatsApp
  let told = ''
  const askerPhone = q.asked_by && /^[0-9]{11,15}$/.test(q.asked_by) ? q.asked_by : null
  if (askerPhone && askerPhone !== expertPhone) {
    const asker = await getContact(askerPhone)
    try {
      if (inWindow(asker)) {
        await sendText(askerPhone,
          `💡 ${updating ? 'Updated answer' : 'Answer'} from the product team to your question "${q.question}":\n\n${answer}`,
          { pendingId })
      } else {
        await sendTemplate(askerPhone, TEMPLATES.answer.name, [param(q.question, 200), param(answer, 700)], { pendingId })
      }
      told = ` and sent to ${displayName(asker, askerPhone)}`
    } catch (e) {
      console.error('[WA] answer to asker failed:', (e as Error).message)
      told = ` (couldn't reach ${displayName(asker, askerPhone)} on WhatsApp)`
    }
  }
  await sendText(expertPhone, `✅ ${updating ? 'Updated' : 'Saved'} answer to #${pendingId}${told}. Thank you!`)
}

async function listPending(phone: string) {
  const rows = await db('kb_pending_questions?status=in.(open,forwarded)&select=id,question,asked_by&order=id.asc&limit=15', {}, '')
  if (!rows?.length) {
    await sendText(phone, '🎉 No open questions.')
    return
  }
  const lines = rows.map((r: any) => `*#${r.id}* ${r.question}`)
  await sendText(phone, `Open questions:\n\n${lines.join('\n')}\n\nSend *#12 your answer* to answer, or *skip 12* to drop one.`)
}

async function dismiss(pendingId: number, phone: string) {
  await db(`kb_pending_questions?id=eq.${pendingId}`, { method: 'PATCH', body: JSON.stringify({ status: 'dismissed' }) }, 'return=minimal')
  await sendText(phone, `Skipped #${pendingId}.`)
}

// ── Team management (admins) ─────────────────────────────

async function teamCommand(text: string, phone: string): Promise<boolean> {
  const add = text.match(/^add\s+(?:(sales|expert|admin)\s+)?(\+?[\d][\d\s-]{8,}\d)\s*(.*)$/i)
  if (add) {
    const target = normalisePhone(add[2])
    if (!target) {
      await sendText(phone, `"${add[2]}" doesn't look like a phone number. Try: add 98123 45678 Rahul Sharma`)
      return true
    }
    const role = (add[1] ?? 'sales').toLowerCase()
    await db('wa_contacts?on_conflict=phone', {
      method: 'POST',
      body: JSON.stringify({ phone: target, name: add[3].trim() || null, role, active: true }),
    }, 'return=minimal,resolution=merge-duplicates')
    await sendText(phone, `✅ Added ${add[3].trim() || pretty(target)} (${pretty(target)}) as ${role}. They can message this number now.`)
    return true
  }
  const remove = text.match(/^remove\s+(\+?[\d][\d\s-]{8,}\d)\s*$/i)
  if (remove) {
    const target = normalisePhone(remove[1])
    if (!target) return false
    await db(`wa_contacts?phone=eq.${target}`, { method: 'PATCH', body: JSON.stringify({ active: false }) }, 'return=minimal')
    await sendText(phone, `Removed ${pretty(target)}. They can no longer use the bot.`)
    return true
  }
  if (/^(team|list team|members)$/i.test(text)) {
    const rows: Contact[] = await db('wa_contacts?active=eq.true&select=*&order=role,name', {}, '')
    const lines = rows.map((r) => `${r.role === 'sales' ? '•' : r.role === 'expert' ? '🎓' : '🔑'} ${r.name ?? ''} ${pretty(r.phone)}`)
    await sendText(phone, `Team (${rows.length}):\n${lines.join('\n')}\n\n🎓 expert  🔑 admin`)
    return true
  }
  return false
}

function helpText(c: Contact): string {
  let t = `Hi ${c.name?.split(' ')[0] || 'there'}! I'm the Stonelam Sales Assistant. Ask me about shades, applications, ` +
    `projects or specs, or ask for photos, videos, brochures and certificates. Type, or send a voice note. ` +
    `Prices aren't shared here.`
  if (c.role === 'expert') {
    t += `\n\n*Expert:* questions I can't answer come to you. Swipe-reply with the answer and it's saved for everyone. ` +
      `Send *pending* to see open questions, *#12 your answer* to answer one, *skip 12* to drop one.`
  }
  if (c.role === 'admin') {
    t += `\n\n*Admin:* *add 98123 45678 Name* (sales), *add expert 98… Name*, *add admin 98… Name*, ` +
      `*remove 98123 45678*, *team* to see everyone, *pending* for open questions.`
  }
  return t
}

// ── Incoming message ─────────────────────────────────────

async function handleMessage(msg: any, profileName: string | undefined) {
  const phone = String(msg.from ?? '')
  if (!phone || !msg.id) return

  // Meta retries webhooks; a message id we've already seen is skipped
  const fresh = await db('wa_messages?on_conflict=id', {
    method: 'POST',
    body: JSON.stringify({ id: msg.id, direction: 'in', phone, kind: msg.type, body: msg.text?.body ?? null }),
  }, 'return=representation,resolution=ignore-duplicates')
  if (!fresh?.length) return

  const contact = await getContact(phone)
  if (!contact || !contact.active) {
    // Tell strangers once a day, then stay quiet
    const recent = await db(`wa_messages?phone=eq.${phone}&direction=eq.out&created_at=gte.${encodeURIComponent(new Date(Date.now() - WINDOW_MS).toISOString())}&select=id&limit=1`, {}, '')
    if (!recent?.length) {
      await sendText(phone, "This is Stonelam's internal sales assistant. Your number isn't registered yet. Please ask the marketing team to add you.")
    }
    console.log(`[WA] ignored unregistered ${phone} (${profileName ?? ''})`)
    return
  }

  await db(`wa_contacts?phone=eq.${phone}`, {
    method: 'PATCH',
    body: JSON.stringify({ last_inbound_at: new Date().toISOString(), ...(contact.name ? {} : { name: profileName ?? null }) }),
  }, 'return=minimal')
  contact.last_inbound_at = new Date().toISOString()
  if (!contact.name && profileName) contact.name = profileName
  await markRead(msg.id)

  // Text of the message, whatever kind it is
  let text = ''
  if (msg.type === 'text') text = msg.text?.body ?? ''
  else if (msg.type === 'button') text = msg.button?.text ?? ''
  else if (msg.type === 'interactive') text = msg.interactive?.button_reply?.title ?? msg.interactive?.list_reply?.title ?? ''
  else if (msg.type === 'audio') {
    const heard = await transcribe(msg.audio?.id)
    if (!heard) {
      await sendText(phone, "Sorry, I couldn't make out that voice note. Could you type the question?")
      return
    }
    await sendText(phone, `🎤 _${heard}_`)
    text = heard
  } else if (['image', 'video', 'document'].includes(msg.type) && msg[msg.type]?.caption) {
    text = msg[msg.type].caption
  } else if (msg.type !== 'reaction') {
    await sendText(phone, 'I can read text and voice notes. Please type or say what you need.')
    return
  }
  text = text.trim()
  if (!text) return

  const isExpert = contact.role === 'expert' || contact.role === 'admin'

  // Expert swipe-replied to a forwarded question
  if (isExpert && msg.context?.id) {
    const ref = await db(`wa_messages?id=eq.${encodeURIComponent(msg.context.id)}&select=pending_id`, {}, '')
    if (ref?.[0]?.pending_id) {
      await saveExpertAnswer(ref[0].pending_id, text, phone, contact)
      return
    }
  }
  if (isExpert) {
    const numbered = text.match(/^#\s*(\d+)\s*[:\-–]?\s+([\s\S]+)$/)
    if (numbered) return await saveExpertAnswer(Number(numbered[1]), numbered[2].trim(), phone, contact)
    const skip = text.match(/^(?:skip|dismiss)\s*#?\s*(\d+)$/i)
    if (skip) return await dismiss(Number(skip[1]), phone)
    if (/^(pending|open|questions)$/i.test(text)) return await listPending(phone)
  }
  if (contact.role === 'admin' && (await teamCommand(text, phone))) return
  if (/^(help|menu|start|hi|hello|hey)[.!]*$/i.test(text)) {
    await sendText(phone, helpText(contact))
    return
  }

  await answerQuestion(text, phone, contact)
}

// Delivery receipts. A media message WhatsApp couldn't fetch is replaced by its link.
async function handleStatus(st: any) {
  if (!st?.id) return
  try {
    const rows = await db(`wa_messages?id=eq.${encodeURIComponent(st.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: st.status }),
    })
    if (st.status === 'failed') {
      console.error('[WA] delivery failed:', st.recipient_id, JSON.stringify(st.errors ?? []))
      const fb = rows?.[0]?.fallback
      if (fb) await sendText(st.recipient_id, fb)
    }
  } catch (e) {
    console.error('[WA] status update failed:', (e as Error).message)
  }
}

async function handleWebhook(body: any) {
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {}
      if (value.metadata?.phone_number_id && WA_PHONE_ID && value.metadata.phone_number_id !== WA_PHONE_ID) continue
      const names = new Map<string, string>((value.contacts ?? []).map((c: any) => [c.wa_id, c.profile?.name]))
      for (const msg of value.messages ?? []) {
        try {
          await handleMessage(msg, names.get(msg.from))
        } catch (e) {
          console.error('[WA] message failed:', (e as Error).message)
        }
      }
      for (const st of value.statuses ?? []) await handleStatus(st)
    }
  }
}

// ── Signature check ──────────────────────────────────────

async function validSignature(raw: string, header: string | null): Promise<boolean> {
  if (!WA_APP_SECRET || !header?.startsWith('sha256=')) return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(WA_APP_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)))
  const expected = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('')
  const got = header.slice(7).toLowerCase()
  if (got.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}

// ── One-off setup / status (called by us with the service-role key) ──

async function setup(apply: boolean) {
  const report: Record<string, unknown> = {
    secrets: {
      WHATSAPP_TOKEN: Boolean(WA_TOKEN), WHATSAPP_PHONE_NUMBER_ID: Boolean(WA_PHONE_ID),
      WHATSAPP_APP_SECRET: Boolean(WA_APP_SECRET), WHATSAPP_VERIFY_TOKEN: Boolean(WA_VERIFY_TOKEN),
    },
  }
  if (!WA_TOKEN || !WA_PHONE_ID) return report

  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      report[name] = await fn()
    } catch (e) {
      report[name] = { error: (e as Error).message }
    }
  }

  // The token tells us which app and WhatsApp account it belongs to
  let appId = ''
  let wabaId = ''
  await step('token', async () => {
    const d = (await graph(`debug_token?input_token=${encodeURIComponent(WA_TOKEN)}`)).data
    appId = d.app_id
    wabaId = d.granular_scopes?.find((s: any) => s.scope === 'whatsapp_business_management')?.target_ids?.[0] ?? ''
    return { app_id: d.app_id, valid: d.is_valid, expires_at: d.expires_at || 'never', scopes: d.scopes, waba_id: wabaId }
  })
  await step('phone', () =>
    graph(`${WA_PHONE_ID}?fields=display_phone_number,verified_name,name_status,code_verification_status,quality_rating,platform_type,status,throughput`))
  if (!apply) {
    if (wabaId) {
      await step('templates', async () =>
        (await graph(`${wabaId}/message_templates?fields=name,status&limit=100`)).data
          ?.filter((t: any) => t.name.startsWith('sales_bot_')))
      await step('subscribed_apps', () => graph(`${wabaId}/subscribed_apps`))
    }
    return report
  }

  const phone: any = report.phone
  if (WA_PIN && phone?.platform_type !== 'CLOUD_API') {
    await step('register', () => graph(`${WA_PHONE_ID}/register`, { messaging_product: 'whatsapp', pin: WA_PIN }))
  }
  if (appId && WA_APP_SECRET && WA_VERIFY_TOKEN) {
    // App-level webhook: Meta calls GET on SELF_URL with the verify token before accepting it
    await step('app_webhook', () => graph(`${appId}/subscriptions`, {
      object: 'whatsapp_business_account', callback_url: SELF_URL, verify_token: WA_VERIFY_TOKEN,
      fields: 'messages', include_values: true,
    }, `${appId}|${WA_APP_SECRET}`))
  }
  if (wabaId) {
    await step('waba_subscribe', () => graph(`${wabaId}/subscribed_apps`, {}))
    await step('templates', async () => {
      const existing = new Set(((await graph(`${wabaId}/message_templates?fields=name&limit=100`)).data ?? []).map((t: any) => t.name))
      const out: Record<string, unknown> = {}
      for (const t of Object.values(TEMPLATES)) {
        if (existing.has(t.name)) {
          out[t.name] = 'exists'
          continue
        }
        try {
          out[t.name] = await graph(`${wabaId}/message_templates`, {
            name: t.name, language: 'en', category: 'UTILITY',
            components: [{ type: 'BODY', text: t.text, example: { body_text: [t.example] } }],
          })
        } catch (e) {
          out[t.name] = { error: (e as Error).message }
        }
      }
      return out
    })
  }
  return report
}

// ── HTTP Handler ─────────────────────────────────────────

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined

Deno.serve(async (req: Request) => {
  const url = new URL(req.url)

  // Meta webhook verification
  if (req.method === 'GET') {
    const ok = url.searchParams.get('hub.mode') === 'subscribe' && WA_VERIFY_TOKEN &&
      url.searchParams.get('hub.verify_token') === WA_VERIFY_TOKEN
    const challenge = url.searchParams.get('hub.challenge')
    if (ok && challenge) return new Response(challenge, { status: 200 })
    return new Response('Forbidden', { status: 403 })
  }
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  const action = url.searchParams.get('action')
  if (action) {
    if (req.headers.get('Authorization') !== `Bearer ${SUPABASE_SERVICE_ROLE}`) return new Response('Forbidden', { status: 403 })
    if (action === 'setup' || action === 'status') return json(await setup(action === 'setup'))
    return json({ error: 'unknown action' }, 400)
  }

  const raw = await req.text()
  if (!(await validSignature(raw, req.headers.get('X-Hub-Signature-256')))) {
    console.error('[WA] rejected: bad or missing signature')
    return new Response('Bad signature', { status: 401 })
  }
  let body: any
  try {
    body = JSON.parse(raw)
  } catch {
    return new Response('Bad JSON', { status: 400 })
  }
  if (body.object !== 'whatsapp_business_account') return new Response('ok')

  // Meta wants a fast 200; answering can take 10-30s, so it carries on in the background
  const work = handleWebhook(body).catch((e) => console.error('[WA] webhook failed:', e))
  if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(work)
  else await work
  return new Response('ok')
})
