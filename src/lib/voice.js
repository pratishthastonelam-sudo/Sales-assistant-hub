/**
 * Voice module — zero-cost Web Speech API wrapper.
 *
 * Uses the native browser SpeechRecognition for voice input and
 * SpeechSynthesis for text-to-speech output. No third-party APIs,
 * no credits, entirely client-side.
 *
 * Browser support:
 *   - Chrome / Edge: full support (webkitSpeechRecognition)
 *   - Safari: SpeechSynthesis works; SpeechRecognition is partial
 *   - Firefox: SpeechSynthesis works; SpeechRecognition not yet supported
 */

// ── Speech Recognition (input) ────────────────────────

export function createSpeechRecognition(lang = 'en-US') {
  const SpeechRecognitionImpl =
    window.SpeechRecognition || window.webkitSpeechRecognition

  if (!SpeechRecognitionImpl) {
    return {
      supported: false,
      recognition: null,
    }
  }

  const recognition = new SpeechRecognitionImpl()
  recognition.lang = lang
  recognition.continuous = false
  recognition.interimResults = true
  recognition.maxAlternatives = 1

  return {
    supported: true,
    recognition,
  }
}

/**
 * Start listening and resolve with the final transcript.
 * Returns a controller with `stop()` for manual cancellation.
 */
export function listen(lang = 'en-US') {
  const { supported, recognition } = createSpeechRecognition(lang)

  if (!supported || !recognition) {
    return Promise.reject(new Error('SpeechRecognition not supported in this browser.'))
  }

  return new Promise((resolve, reject) => {
    let finalTranscript = ''

    recognition.onresult = (event) => {
      let interim = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript
        if (event.results[i].isFinal) {
          finalTranscript += transcript
        } else {
          interim += transcript
        }
      }
      // Call optional onInterim callback if attached
      if (recognition._onInterim && interim) {
        recognition._onInterim(interim)
      }
    }

    recognition.onerror = (event) => {
      if (event.error === 'no-speech') {
        resolve('')
      } else {
        reject(new Error(`Speech recognition error: ${event.error}`))
      }
    }

    recognition.onend = () => {
      resolve(finalTranscript.trim())
    }

    recognition.start()
  })
}

// ── Speech Synthesis (output) ────────────────────────

let cachedVoices = []

export function loadVoices() {
  return new Promise((resolve) => {
    const synth = window.speechSynthesis
    if (!synth) {
      resolve([])
      return
    }

    const existing = synth.getVoices()
    if (existing.length > 0) {
      cachedVoices = existing
      resolve(existing)
      return
    }

    // Voices load asynchronously in some browsers
    synth.onvoiceschanged = () => {
      cachedVoices = synth.getVoices()
      resolve(cachedVoices)
    }

    // Fallback timeout
    setTimeout(() => {
      if (cachedVoices.length === 0) {
        cachedVoices = synth.getVoices()
      }
      resolve(cachedVoices)
    }, 1000)
  })
}

export function speak(text, options = {}) {
  const synth = window.speechSynthesis
  if (!synth || !text) return

  // Cancel any ongoing speech
  synth.cancel()

  const utterance = new SpeechSynthesisUtterance(text)
  utterance.rate = options.rate ?? 1.0
  utterance.pitch = options.pitch ?? 1.0
  utterance.volume = options.volume ?? 1.0
  utterance.lang = options.lang ?? 'en-US'

  // Prefer a natural-sounding English voice if available
  if (cachedVoices.length === 0) {
    cachedVoices = synth.getVoices()
  }
  const preferredVoice =
    cachedVoices.find(
      (v) =>
        v.lang.startsWith('en') &&
        (v.name.includes('Google US') ||
          v.name.includes('Samantha') ||
          v.name.includes('Natural'))
    ) || cachedVoices.find((v) => v.lang.startsWith('en'))

  if (preferredVoice) {
    utterance.voice = preferredVoice
  }

  synth.speak(utterance)
  return utterance
}

export function stopSpeaking() {
  const synth = window.speechSynthesis
  if (synth) synth.cancel()
}

export function isSpeechSynthesisSupported() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

export function isSpeechRecognitionSupported() {
  return (
    typeof window !== 'undefined' &&
    ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window)
  )
}
