import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)
  const [isPasswordRecovery, setIsPasswordRecovery] = useState(false)

  useEffect(() => {
    // Get initial session
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })

    // Listen for auth changes
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, newSession) => {
      // Supabase fires this specific event when the user arrives via a
      // "reset password" email link — show the reset screen instead of
      // treating them as a normal signed-in session.
      if (event === 'PASSWORD_RECOVERY') {
        setIsPasswordRecovery(true)
      }
      setSession(newSession)
      setLoading(false)
    })

    return () => subscription.unsubscribe()
  }, [])

  const signIn = (email, password) =>
    supabase.auth.signInWithPassword({ email, password })

  const signUp = (email, password) =>
    supabase.auth.signUp({ email, password })

  const signOut = () => supabase.auth.signOut()

  // Sends a "reset your password" email with a link back to this app
  const resetPasswordForEmail = (email) =>
    supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin,
    })

  // Resends the "confirm your email" link for a user who signed up
  // but hasn't clicked the original confirmation email yet
  const resendConfirmationEmail = (email) =>
    supabase.auth.resend({ type: 'signup', email })

  // Called on the reset-password screen once the user picks a new password
  const updatePassword = async (newPassword) => {
    const result = await supabase.auth.updateUser({ password: newPassword })
    if (!result.error) {
      setIsPasswordRecovery(false)
    }
    return result
  }

  const cancelPasswordRecovery = () => setIsPasswordRecovery(false)

  const value = {
    session,
    user: session?.user ?? null,
    loading,
    isPasswordRecovery,
    signIn,
    signUp,
    signOut,
    resetPasswordForEmail,
    resendConfirmationEmail,
    updatePassword,
    cancelPasswordRecovery,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}