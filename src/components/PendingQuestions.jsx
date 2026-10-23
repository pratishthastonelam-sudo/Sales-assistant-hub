import { useState } from 'react'
import { supabase, PENDING_FUNCTION_URL } from '../lib/supabase.js'

// Questions the bot couldn't answer. An admin's answer is saved to the
// knowledge base, so the bot answers the same question itself next time.
export default function PendingQuestions({ questions, onReload }) {
  const [tab, setTab] = useState('open')
  const open = questions.filter((q) => q.status === 'open' || q.status === 'forwarded')
  const answered = questions.filter((q) => q.status === 'answered')
  const shown = tab === 'open' ? open : answered

  return (
    <div className="flex-1 overflow-y-auto bg-gray-50 px-4 py-6 scrollbar-thin">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-lg font-semibold text-gray-900">Unanswered questions</h1>
        <p className="mt-1 text-sm text-gray-500">
          Questions the assistant couldn't answer. Your answer is saved to the knowledge base, so the
          assistant can answer the same question itself next time.
        </p>

        <div className="mt-4 flex gap-2">
          {[['open', `Waiting (${open.length})`], ['answered', `Answered (${answered.length})`]].map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`rounded-full px-4 py-1.5 text-sm font-medium transition ${
                tab === key ? 'bg-brand-600 text-white' : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="mt-4 space-y-3">
          {shown.length === 0 && (
            <p className="rounded-xl border border-dashed border-gray-200 bg-white py-10 text-center text-sm text-gray-400">
              {tab === 'open' ? 'Nothing waiting. 🎉' : 'No answers yet.'}
            </p>
          )}
          {shown.map((q) => <QuestionCard key={q.id} q={q} onSaved={onReload} />)}
        </div>
      </div>
    </div>
  )
}

function QuestionCard({ q, onSaved }) {
  const [answer, setAnswer] = useState(q.answer ?? '')
  const [editing, setEditing] = useState(q.status !== 'answered')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const post = async (body) => {
    setBusy(true)
    setError('')
    try {
      const { data } = await supabase.auth.getSession()
      const resp = await fetch(PENDING_FUNCTION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session?.access_token}` },
        body: JSON.stringify({ ...body, id: q.id }),
      })
      if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error || `Error ${resp.status}`)
      setEditing(false)
      await onSaved()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const when = new Date(q.created_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <p className="text-[15px] font-medium text-gray-900">{q.question}</p>
      <p className="mt-1 text-xs text-gray-400">
        #{q.id} · {q.asked_by} · {q.channel === 'whatsapp' ? 'WhatsApp' : 'web app'} · {when}
      </p>

      {editing ? (
        <div className="mt-3">
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            rows={3}
            placeholder="Type the answer the sales team should get…"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100"
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              disabled={busy || !answer.trim()}
              onClick={() => post({ action: 'answer', answer })}
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-700 disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save answer'}
            </button>
            {q.status === 'answered' ? (
              <button onClick={() => setEditing(false)} className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700">
                Cancel
              </button>
            ) : (
              <button
                disabled={busy}
                onClick={() => post({ action: 'dismiss' })}
                title="Remove this question without answering"
                className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700"
              >
                Dismiss
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="mt-3 rounded-lg bg-brand-50 px-3 py-2 text-sm text-gray-800">
          <p className="whitespace-pre-wrap">{q.answer}</p>
          <button onClick={() => setEditing(true)} className="mt-1 text-xs font-medium text-brand-700 hover:underline">
            Edit answer
          </button>
        </div>
      )}
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  )
}
