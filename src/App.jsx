import { useState } from 'react'
import { useAuth } from './context/AuthContext.jsx'
import LoginScreen from './components/LoginScreen.jsx'
import ChatLayout from './components/ChatLayout.jsx'
import ResetPasswordScreen from './components/ResetPasswordScreen.jsx'

export default function App() {
  const { session, loading, isPasswordRecovery } = useAuth()

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-50">
        <div className="flex flex-col items-center gap-3">
          <div className="h-10 w-10 animate-spin rounded-full border-4 border-brand-200 border-t-brand-600" />
          <p className="text-sm text-gray-500">Loading Sales Assistant Hub…</p>
        </div>
      </div>
    )
  }

  if (isPasswordRecovery) {
    return <ResetPasswordScreen />
  }

  if (!session) {
    return <LoginScreen />
  }

  return <ChatLayout />
}