import { useState, useEffect, useRef, useCallback } from 'react'
import { supabase, EDGE_FUNCTION_URL } from '../lib/supabase.js'
import { useAuth } from '../context/AuthContext.jsx'
import {
  listen,
  speak,
  stopSpeaking,
  isSpeechRecognitionSupported,
  isSpeechSynthesisSupported,
  loadVoices,
} from '../lib/voice.js'
import ChatMessage from './ChatMessage.jsx'
import ChatInput from './ChatInput.jsx'

export default function ChatWindow({
  sessionId,
  onSessionCreated,
  sessions,
  setSessions,
}) {
  const { session: authSession } = useAuth()
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [isListening, setIsListening] = useState(false)
  const [interimText, setInterimText] = useState('')
  const messagesEndRef = useRef(null)
  const voiceEnabledRef = useRef(false)
  const recognitionSupported = isSpeechRecognitionSupported()
  const synthesisSupported = isSpeechSynthesisSupported()

  // Load voices on mount
  useEffect(() => {
    if (synthesisSupported) loadVoices()
  }, [synthesisSupported])

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  // Load messages when session changes
  useEffect(() => {
    if (sessionId) {
      loadMessages(sessionId)
    } else {
      setMessages([])
    }
  }, [sessionId])

  const loadMessages = async (sid) => {
    const { data, error } = await supabase
      .from('chat_sessions')
      .select('*')
      .eq('id', sid)
      .order('created_at', { ascending: true })

    if (error) {
      console.error('Error loading messages:', error)
      return
    }

    if (data && data.length > 0) {
      const mapped = data.map((row) => ({
        role: row.role,
        content: row.content,
        media: row.media || [],
        videos: row.videos || [],
        documents: row.documents || [],
        created_at: row.created_at,
      }))
      setMessages(mapped)
    }
  }

  const handleSend = async (text, fromVoice = false) => {
    if (!text.trim() || loading) return

    // Enable voice response when voice input is used
    if (fromVoice) {
      voiceEnabledRef.current = true
    }

    const userMessage = { role: 'user', content: text.trim(), media: [], videos: [], documents: [] }
    setMessages((prev) => [...prev, userMessage])
    setInput('')
    setLoading(true)

    let currentSessionId = sessionId

    // Create a new session row if none exists
    if (!currentSessionId) {
      const { data: newSession, error } = await supabase
        .from('chat_sessions')
        .insert({
          user_id: authSession?.user?.id,
          role: 'user',
          content: text.trim(),
          title: text.trim().slice(0, 60),
        })
        .select()
        .single()

      if (!error && newSession) {
        currentSessionId = newSession.id
        onSessionCreated(currentSessionId)
        // Add to sidebar
        setSessions((prev) => [
          {
            id: currentSessionId,
            title: text.trim().slice(0, 60),
            created_at: new Date().toISOString(),
          },
          ...prev,
        ])
      }
    } else {
      // Log user message in existing session
      await supabase.from('chat_sessions').insert({
        user_id: authSession?.user?.id,
        session_id: currentSessionId,
        role: 'user',
        content: text.trim(),
      })
    }

    try {
      // Call the Edge Function
      const response = await fetch(EDGE_FUNCTION_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authSession?.access_token}`,
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({
          message: text.trim(),
          user_id: authSession?.user?.id,
          session_id: currentSessionId,
        }),
      })

      if (!response.ok) {
        throw new Error(`Edge function returned ${response.status}`)
      }

      const data = await response.json()

      const aiMessage = {
        role: 'assistant',
        content: data.response || data.text || 'No response received.',
        media: data.media_urls || data.media || [],
        videos: data.video_urls || data.videos || [],
        documents: data.documents || data.files || [],
      }

      setMessages((prev) => [...prev, aiMessage])

      // Auto-speak the AI response if voice was used
      if (fromVoice && synthesisSupported && aiMessage.content) {
        speak(aiMessage.content)
      }

      // Log assistant message
      await supabase.from('chat_sessions').insert({
        user_id: authSession?.user?.id,
        session_id: currentSessionId,
        role: 'assistant',
        content: aiMessage.content,
        media: aiMessage.media,
        videos: aiMessage.videos,
        documents: aiMessage.documents,
      })
    } catch (err) {
      console.error('Edge function error:', err)
      const errorMessage = {
        role: 'assistant',
        content:
          'Sorry, I encountered an error processing your request. Please try again.',
        media: [],
        videos: [],
        documents: [],
      }
      setMessages((prev) => [...prev, errorMessage])
    } finally {
      setLoading(false)
    }
  }

  const handleVoiceInput = async () => {
    if (!recognitionSupported) {
      alert(
        'Voice input is not supported in this browser. Please use Chrome or Edge.'
      )
      return
    }

    if (isListening) {
      // Will stop automatically; nothing to do
      return
    }

    setIsListening(true)
    setInterimText('')

    try {
      const transcript = await listen('en-US')
      setInterimText('')
      if (transcript) {
        await handleSend(transcript, true)
      }
    } catch (err) {
      console.error('Voice error:', err)
      alert(`Voice error: ${err.message}`)
    } finally {
      setIsListening(false)
    }
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Messages area */}
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        <div className="mx-auto max-w-3xl px-4 py-6">
          {messages.length === 0 && !loading && (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-50">
                <svg className="h-8 w-8 text-brand-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-gray-900">
                Ask me about your sales materials
              </h3>
              <p className="mt-2 max-w-sm text-sm text-gray-500">
                Search through brochures, catalogs, images, and documents.
                Type your question or tap the microphone to speak.
              </p>
              <div className="mt-6 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {[
                  'Show me Delhi marble collection',
                  'What luxury tiles do we have?',
                  'Find marble catalog PDF',
                  'Show granite slab images',
                ].map((suggestion) => (
                  <button
                    key={suggestion}
                    onClick={() => handleSend(suggestion)}
                    className="rounded-lg border border-gray-200 px-4 py-2 text-left text-sm text-gray-600 transition hover:border-brand-300 hover:bg-brand-50"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Messages */}
          {messages.map((msg, idx) => (
            <ChatMessage key={idx} message={msg} />
          ))}

          {/* Loading indicator */}
          {loading && (
            <div className="flex justify-start py-4 animate-fade-in">
              <div className="rounded-2xl rounded-bl-sm bg-white px-4 py-3 shadow-sm ring-1 ring-gray-100">
                <div className="flex items-center gap-1">
                  <span className="typing-dot"></span>
                  <span className="typing-dot"></span>
                  <span className="typing-dot"></span>
                </div>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input bar */}
      <ChatInput
        input={input}
        setInput={setInput}
        onSend={() => handleSend(input)}
        isListening={isListening}
        onVoiceToggle={handleVoiceInput}
        interimText={interimText}
        voiceSupported={recognitionSupported}
        disabled={loading}
      />
    </div>
  )
}