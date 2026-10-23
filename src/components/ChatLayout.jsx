import { useState, useCallback, useEffect } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import Sidebar from './Sidebar.jsx'
import ChatWindow from './ChatWindow.jsx'
import PendingQuestions from './PendingQuestions.jsx'
import { supabase, PENDING_FUNCTION_URL } from '../lib/supabase.js'

export default function ChatLayout() {
  const { user, signOut } = useAuth()
  const [sessions, setSessions] = useState([])
  const [activeSessionId, setActiveSessionId] = useState(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  // 'pending' shows unanswered questions; the alert email links to ?view=pending
  const [view, setView] = useState(() => new URLSearchParams(window.location.search).get('view') === 'pending' ? 'pending' : 'chat')
  // null until we know; the list only loads for admins (the function returns 403 for everyone else)
  const [pending, setPending] = useState(null)

  const loadPending = useCallback(async () => {
    try {
      const { data } = await supabase.auth.getSession()
      const resp = await fetch(PENDING_FUNCTION_URL, { headers: { Authorization: `Bearer ${data.session?.access_token}` } })
      setPending(resp.ok ? (await resp.json()).questions : false)
    } catch {
      setPending(false)
    }
  }, [])

  useEffect(() => {
    loadPending()
  }, [loadPending])

  const showView = useCallback((v) => {
    setView(v)
    const url = new URL(window.location.href)
    if (v === 'pending') url.searchParams.set('view', 'pending')
    else url.searchParams.delete('view')
    window.history.replaceState(null, '', url)
    if (v === 'pending') loadPending()
  }, [loadPending])

  const handleNewSession = useCallback(() => {
    setActiveSessionId(null)
    showView('chat')
  }, [showView])

  const handleSelectSession = useCallback((id) => {
    setActiveSessionId(id)
    showView('chat')
  }, [showView])

  const handleSessionCreated = useCallback((id) => {
    if (id && !sessions.find((s) => s.id === id)) {
      setSessions((prev) => [
        { id, title: 'New Chat', created_at: new Date().toISOString() },
        ...prev,
      ])
    }
  }, [sessions])

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50">
      {/* Sidebar */}
      <Sidebar
        open={sidebarOpen}
        onToggle={() => setSidebarOpen((v) => !v)}
        sessions={sessions}
        activeSessionId={activeSessionId}
        onNewSession={handleNewSession}
        onSelectSession={handleSelectSession}
        userEmail={user?.email}
        onSignOut={signOut}
        pendingCount={pending ? pending.filter((q) => q.status === 'open' || q.status === 'forwarded').length : null}
        pendingActive={view === 'pending'}
        onShowPending={() => showView('pending')}
      />

      {/* Main chat area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Top bar */}
        <header className="flex items-center justify-between border-b border-gray-200 bg-white px-6 py-3">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSidebarOpen((v) => !v)}
              className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 lg:hidden"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <div>
              <h2 className="text-sm font-semibold text-gray-900">
                {view === 'pending' ? 'Unanswered questions' : activeSessionId ? 'Chat Session' : 'New Chat'}
              </h2>
              <p className="text-xs text-gray-400">Sales Assistant Hub</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden text-xs text-gray-400 sm:block">
              {user?.email}
            </span>
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-100 text-sm font-medium text-brand-700">
              {user?.email?.charAt(0).toUpperCase() || 'U'}
            </div>
          </div>
        </header>

        {view === 'pending' && pending ? (
          <PendingQuestions questions={pending} onReload={loadPending} />
        ) : (
          <ChatWindow
            sessionId={activeSessionId}
            onSessionCreated={handleSessionCreated}
            sessions={sessions}
            setSessions={setSessions}
          />
        )}
      </div>
    </div>
  )
}
