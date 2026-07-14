import { useState } from 'react'
import { useAuth } from '../context/AuthContext.jsx'

export default function LoginScreen() {
  const { signIn, signUp, resetPasswordForEmail, resendConfirmationEmail } = useAuth()
  const [mode, setMode] = useState('signin') // 'signin' | 'signup' | 'forgot'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [busy, setBusy] = useState(false)

  const resetMessages = () => {
    setError('')
    setInfo('')
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    resetMessages()
    setBusy(true)

    if (mode === 'forgot') {
      const { error: resetError } = await resetPasswordForEmail(email)
      setBusy(false)
      if (resetError) {
        setError(resetError.message)
      } else {
        setInfo('Check your email for a password reset link.')
      }
      return
    }

    const { error: authError } =
      mode === 'signin'
        ? await signIn(email, password)
        : await signUp(email, password)

    setBusy(false)

    if (authError) {
      // Supabase returns this specific message when the account exists
      // but hasn't clicked the confirmation email yet
      if (authError.message?.toLowerCase().includes('email not confirmed')) {
        setError('Your email is not confirmed yet.')
      } else {
        setError(authError.message)
      }
    } else if (mode === 'signup') {
      setInfo('Account created! Check your email to confirm before signing in.')
    }
  }

  const handleResendConfirmation = async () => {
    if (!email) {
      setError('Enter your email above first, then click resend.')
      return
    }
    resetMessages()
    setBusy(true)
    const { error: resendError } = await resendConfirmationEmail(email)
    setBusy(false)
    if (resendError) {
      setError(resendError.message)
    } else {
      setInfo('Confirmation email resent. Check your inbox.')
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand-50 via-gray-50 to-brand-100 px-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-600 shadow-lg shadow-brand-600/30">
            <svg className="h-9 w-9 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-4l-4 4v-4z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Sales Assistant Hub</h1>
          <p className="mt-1 text-sm text-gray-500">
            AI-powered knowledge base with voice search
          </p>
        </div>

        {/* Card */}
        <div className="rounded-2xl bg-white p-8 shadow-xl shadow-gray-200/60 ring-1 ring-gray-100">
          {mode !== 'forgot' && (
            <div className="mb-6 flex rounded-lg bg-gray-100 p-1">
              <button
                onClick={() => { setMode('signin'); resetMessages() }}
                className={`flex-1 rounded-md py-2 text-sm font-medium transition ${
                  mode === 'signin' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                Sign In
              </button>
              <button
                onClick={() => { setMode('signup'); resetMessages() }}
                className={`flex-1 rounded-md py-2 text-sm font-medium transition ${
                  mode === 'signup' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                Sign Up
              </button>
            </div>
          )}

          {mode === 'forgot' && (
            <div className="mb-4">
              <h2 className="text-lg font-semibold text-gray-900">Reset your password</h2>
              <p className="mt-1 text-sm text-gray-500">
                Enter your email and we'll send you a reset link.
              </p>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Email
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
              />
            </div>

            {mode !== 'forgot' && (
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="block text-sm font-medium text-gray-700">
                    Password
                  </label>
                  {mode === 'signin' && (
                    <button
                      type="button"
                      onClick={() => { setMode('forgot'); resetMessages() }}
                      className="text-xs font-medium text-brand-600 hover:text-brand-700"
                    >
                      Forgot password?
                    </button>
                  )}
                </div>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    required
                    minLength={6}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full rounded-lg border border-gray-300 px-4 py-2.5 pr-10 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((s) => !s)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                  </button>
                </div>
              </div>
            )}

            {error && (
              <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600 ring-1 ring-red-100">
                {error}
                {error.includes('not confirmed') && (
                  <button
                    type="button"
                    onClick={handleResendConfirmation}
                    className="ml-1 font-medium underline hover:text-red-700"
                  >
                    Resend confirmation email
                  </button>
                )}
              </div>
            )}

            {info && (
              <div className="rounded-lg bg-green-50 px-4 py-3 text-sm text-green-700 ring-1 ring-green-100">
                {info}
              </div>
            )}

            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-lg bg-brand-600 py-2.5 text-sm font-semibold text-white shadow-md shadow-brand-600/30 transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy
                ? 'Please wait…'
                : mode === 'signin'
                ? 'Sign In'
                : mode === 'signup'
                ? 'Create Account'
                : 'Send reset link'}
            </button>

            {mode === 'forgot' && (
              <button
                type="button"
                onClick={() => { setMode('signin'); resetMessages() }}
                className="w-full text-center text-sm text-gray-400 hover:text-gray-600"
              >
                Back to sign in
              </button>
            )}
          </form>
        </div>

        <p className="mt-6 text-center text-xs text-gray-400">
          Team members authenticate via Supabase Auth
        </p>
      </div>
    </div>
  )
}

function EyeIcon() {
  return (
    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
    </svg>
  )
}

function EyeOffIcon() {
  return (
    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.542-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.542 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
    </svg>
  )
}