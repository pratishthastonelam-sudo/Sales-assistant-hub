import { useState, useRef, useEffect } from 'react'
import {
  stopSpeaking,
  isSpeechSynthesisSupported,
} from '../lib/voice.js'

export default function ChatInput({
  input,
  setInput,
  onSend,
  isListening,
  onVoiceToggle,
  interimText,
  voiceSupported,
  disabled,
}) {
  const textareaRef = useRef(null)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const synthesisSupported = isSpeechSynthesisSupported()

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = Math.min(el.scrollHeight, 120) + 'px'
    }
  }, [input])

  // Track speech state
  useEffect(() => {
    if (!synthesisSupported) return
    const synth = window.speechSynthesis
    const update = () => setIsSpeaking(synth.speaking)
    synth.addEventListener('speak', update)
    synth.addEventListener('end', update)
    synth.addEventListener('cancel', update)
    return () => {
      synth.removeEventListener('speak', update)
      synth.removeEventListener('end', update)
      synth.removeEventListener('cancel', update)
    }
  }, [synthesisSupported])

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onSend()
    }
  }

  const handleStopSpeaking = () => {
    stopSpeaking()
    setIsSpeaking(false)
  }

  return (
    <div className="border-t border-gray-200 bg-white px-4 py-3">
      <div className="mx-auto max-w-3xl">
        {/* Voice listening indicator */}
        {isListening && (
          <div className="mb-2 flex items-center gap-2 px-2 text-sm text-brand-600 animate-fade-in">
            <span className="voice-pulse flex h-3 w-3">
              <span className="h-3 w-3 rounded-full bg-brand-500" />
            </span>
            Listening… {interimText && <span className="text-gray-400">"{interimText}"</span>}
          </div>
        )}

        {/* Speaking indicator with stop button */}
        {isSpeaking && (
          <div className="mb-2 flex items-center justify-between rounded-lg bg-brand-50 px-3 py-1.5 animate-fade-in">
            <span className="flex items-center gap-2 text-xs text-brand-600">
              <svg className="h-4 w-4 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072M17.95 6.05a8 8 0 010 11.9 M11 5L6 9H2v6h4l5 5V5z" />
              </svg>
              Speaking…
            </span>
            <button
              onClick={handleStopSpeaking}
              className="flex items-center gap-1 text-xs text-brand-700 hover:text-brand-800"
            >
              <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 24 24">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
              Stop
            </button>
          </div>
        )}

        {/* Input bar */}
        <div className="flex items-end gap-2">
          {/* Text input */}
          <div className="relative flex-1">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={disabled}
              rows={1}
              placeholder={
                isListening
                  ? 'Listening…'
                  : 'Ask about products, catalogs, or documents…'
              }
              className="w-full resize-none rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3 pr-4 text-sm outline-none transition focus:border-brand-400 focus:bg-white focus:ring-2 focus:ring-brand-500/10 disabled:opacity-60"
            />
          </div>

          {/* Microphone button */}
          {voiceSupported && (
            <button
              onClick={onVoiceToggle}
              disabled={disabled}
              title={isListening ? 'Stop listening' : 'Voice input'}
              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl transition ${
                isListening
                  ? 'voice-pulse bg-brand-600 text-white'
                  : 'bg-gray-100 text-gray-500 hover:bg-gray-200 hover:text-gray-700'
              } disabled:cursor-not-allowed disabled:opacity-50`}
            >
              {isListening ? (
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9" />
                </svg>
              ) : (
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-14 0M12 18v3m0-18a3 3 0 00-3 3v6a3 3 0 006 0V6a3 3 0 00-3-3z" />
                </svg>
              )}
            </button>
          )}

          {/* Send button */}
          <button
            onClick={onSend}
            disabled={disabled || (!input.trim() && !isListening)}
            title="Send message"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-brand-600 text-white shadow-md shadow-brand-600/30 transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 10l7-7m0 0l7 7m-7-7v18" />
            </svg>
          </button>
        </div>

        {/* Helper text */}
        <p className="mt-2 flex items-center justify-center gap-3 text-xs text-gray-400">
          <span>Press Enter to send • Shift+Enter for new line</span>
          {voiceSupported && <span>• Tap mic to speak</span>}
        </p>
      </div>
    </div>
  )
}
