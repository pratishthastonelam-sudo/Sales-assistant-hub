/**
 * ═══════════════════════════════════════════════════════════════
 *  pending_questions — Supabase Edge Function
 * ═══════════════════════════════════════════════════════════════
 *
 *  Questions the bot couldn't answer (kb_pending_questions) reach a person
 *  and the person's answer reaches the knowledge base:
 *
 *  - POST ?action=notify (X-Notify-Secret) → called by the database trigger
 *        in 006_pending_alerts.sql for every new question; emails ALERT_EMAIL_TO
 *  - GET  (signed-in admin)                → open questions + recent answers
 *  - POST { action: 'answer', id, answer } → saves the answer to kb_items as an
 *        'expert_answer', so the bot answers that question itself next time
 *  - POST { action: 'dismiss', id }        → drops a question that needs no answer
 *
 *  Admins are the emails in ADMIN_EMAILS (comma-separated).
 *  Secrets: PENDING_NOTIFY_SECRET, RESEND_API_KEY, ALERT_EMAIL_TO, ADMIN_EMAILS;
 *  optional ALERT_EMAIL_FROM, WEB_APP_URL.
 * ═══════════════════════════════════════════════════════════════
 */

// Values pasted into secrets sometimes keep wrapping <> or quotes
const env = (name: string, fallback = '') =>
  (Deno.env.get(name) ?? fallback).trim().replace(/^[<"' ]+|[>"' ]+$/g, '')
const list = (name: string, fallback = '') =>
  env(name, fallback).split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)

const SUPABASE_URL = env('SUPABASE_URL').replace(/\/$/, '')
const SUPABASE_SERVICE_ROLE = env('SUPABASE_SERVICE_ROLE_KEY')
const GEMINI_API_KEY = env('GEMINI_API_KEY')
const NOTIFY_SECRET = env('PENDING_NOTIFY_SECRET')
const RESEND_API_KEY = env('RESEND_API_KEY')
const ALERT_EMAILS = list('ALERT_EMAIL_TO', 'pratishtha.gupta@stonelam.com')
const ADMIN_EMAILS = list('ADMIN_EMAILS', 'pratishtha.gupta@stonelam.com')
// Not through env(): its <> trimming would break the "Name <address>" form
const ALERT_EMAIL_FROM = (Deno.env.get('ALERT_EMAIL_FROM') ?? '').trim() || 'Stonelam Sales Bot <onboarding@resend.dev>'
const WEB_APP_URL = env('WEB_APP_URL', 'https://sales-assistant-hub-1svt.vercel.app').replace(/\/$/, '')

const EMBED_MODEL = 'gemini-embedding-001'
const EMBED_DIM = 768

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, X-Notify-Secret',
}

const DB_HEADERS = {
  'Content-Type': 'application/json',
  apikey: SUPABASE_SERVICE_ROLE,
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } })

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

// ── Who asked ────────────────────────────────────────────

const UUID = /^[0-9a-f-]{36}$/i

async function userEmails(ids: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  await Promise.all([...new Set(ids.filter((id) => UUID.test(id)))].map(async (id) => {
    try {
      const resp = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, { headers: DB_HEADERS, signal: AbortSignal.timeout(5000) })
      if (resp.ok) out[id] = (await resp.json()).email
    } catch (e) {
      console.error('[Users] lookup failed:', (e as Error).message)
    }
  }))
  return out
}

const askerLabel = (askedBy: string | null, emails: Record<string, string>) =>
  (askedBy && emails[askedBy]) || (askedBy && /^[0-9]{11,15}$/.test(askedBy) ? `+${askedBy}` : 'a web app user')

// ── Email alert ──────────────────────────────────────────

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

let lastEmailError = ''

async function sendEmail(subject: string, html: string): Promise<boolean> {
  if (!RESEND_API_KEY || ALERT_EMAILS.length === 0) {
    lastEmailError = 'RESEND_API_KEY or ALERT_EMAIL_TO not set'
    console.error('[Notify] email skipped:', lastEmailError)
    return false
  }
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: ALERT_EMAIL_FROM, to: ALERT_EMAILS, subject, html }),
      signal: AbortSignal.timeout(10 * 1000),
    })
    if (!resp.ok) throw new Error(`${resp.status} ${await resp.text()}`)
    return true
  } catch (e) {
    lastEmailError = (e as Error).message
    console.error('[Notify] email failed:', lastEmailError)
    return false
  }
}

async function notify(id: number) {
  const q = (await db(`kb_pending_questions?id=eq.${id}&select=*`, {}, ''))?.[0]
  if (!q || q.status !== 'open') return { skipped: true }
  const emails = await userEmails([q.asked_by ?? ''])
  const who = askerLabel(q.asked_by, emails)
  const when = new Date(q.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })
  const link = `${WEB_APP_URL}/?view=pending`

  const emailed = await sendEmail(`Sales bot couldn't answer: ${q.question.slice(0, 80)}`,
    `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">` +
      `<p>The sales assistant couldn't answer this question:</p>` +
      `<p style="font-size:17px;border-left:3px solid #16a34a;margin:0;padding:6px 12px">${esc(q.question)}</p>` +
      `<p><b>Asked by:</b> ${esc(who)}<br><b>When:</b> ${when} IST<br><b>Ref:</b> #${id}</p>` +
      `<p><a href="${link}" style="display:inline-block;background:#16a34a;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Answer it in the Sales Assistant</a></p>` +
      `<p style="color:#666">Your answer is saved to the knowledge base, so the bot can answer this question itself next time.</p></div>`)

  if (emailed) {
    await db(`kb_pending_questions?id=eq.${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'forwarded', expert: ALERT_EMAILS.join(',') }),
    }, 'return=minimal')
  }
  return { emailed, error: emailed ? undefined : lastEmailError }
}

// ── Saving an answer ─────────────────────────────────────

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

async function saveAnswer(id: number, answer: string, by: string) {
  const q = (await db(`kb_pending_questions?id=eq.${id}&select=*`, {}, ''))?.[0]
  if (!q) throw new Error(`question #${id} not found`)
  const body = `Q: ${q.question}\nA: ${answer}`
  const vector = await embed(body)
  const item = await db('kb_items?on_conflict=source_id', {
    method: 'POST',
    body: JSON.stringify({
      source_id: `expert:${id}`,
      kind: 'expert_answer',
      title: q.question,
      body,
      source: 'expert',
      item_date: new Date().toISOString().slice(0, 10),
      meta: { pending_id: id, expert: by },
      embedding: vector ? `[${vector.join(',')}]` : null,
      updated_at: new Date().toISOString(),
    }),
  }, 'return=representation,resolution=merge-duplicates')
  await db(`kb_pending_questions?id=eq.${id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      status: 'answered', answer, expert: by, answered_at: new Date().toISOString(), kb_item_id: item?.[0]?.id ?? null,
    }),
  }, 'return=minimal')
}

// ── HTTP Handler ─────────────────────────────────────────

async function adminEmail(req: Request): Promise<string | null> {
  const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '')
  if (!token) return null
  const resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_SERVICE_ROLE, Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  })
  if (!resp.ok) return null
  const email = String((await resp.json()).email ?? '').toLowerCase()
  return ADMIN_EMAILS.includes(email) ? email : null
}

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  const url = new URL(req.url)

  try {
    if (url.searchParams.get('action') === 'notify') {
      if (!NOTIFY_SECRET || req.headers.get('X-Notify-Secret') !== NOTIFY_SECRET) return json({ error: 'forbidden' }, 403)
      const { id } = await req.json().catch(() => ({}))
      if (!id) return json({ error: 'id required' }, 400)
      // ?wait=1 answers with the outcome, for checking the email setup
      if (url.searchParams.get('wait')) return json(await notify(Number(id)))
      const work = notify(Number(id)).catch((e) => console.error('[Notify] failed:', e))
      if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(work)
      else await work
      return json({ ok: true })
    }

    const admin = await adminEmail(req)
    if (!admin) return json({ error: 'forbidden' }, 403)

    if (req.method === 'GET') {
      const rows = await db(
        'kb_pending_questions?select=id,question,asked_by,channel,status,answer,expert,created_at,answered_at' +
          '&status=neq.dismissed&order=created_at.desc&limit=200', {}, '')
      const emails = await userEmails(rows.map((r: any) => r.asked_by ?? ''))
      return json({
        admin,
        questions: rows.map((r: any) => ({ ...r, asked_by: askerLabel(r.asked_by, emails) })),
      })
    }

    if (req.method === 'POST') {
      const { action, id, answer } = await req.json()
      if (!id) return json({ error: 'id required' }, 400)
      if (action === 'answer') {
        if (!answer?.trim()) return json({ error: 'answer required' }, 400)
        await saveAnswer(Number(id), answer.trim(), admin)
        return json({ ok: true })
      }
      if (action === 'dismiss') {
        await db(`kb_pending_questions?id=eq.${Number(id)}`, { method: 'PATCH', body: JSON.stringify({ status: 'dismissed' }) }, 'return=minimal')
        return json({ ok: true })
      }
      return json({ error: 'unknown action' }, 400)
    }
    return json({ error: 'method not allowed' }, 405)
  } catch (e) {
    console.error('[pending_questions]', e)
    return json({ error: (e as Error).message }, 500)
  }
})
