# Sales Assistant Hub

An AI-powered sales assistant web application with WhatsApp-ready webhook, Google Drive fuzzy search, and zero-credit voice chat.

## Features

- **Chat Interface** — Clean, full-screen Tailwind CSS UI with left history sidebar
- **WhatsApp-Ready Webhook** — The Supabase Edge Function is structured to serve as a Meta/WhatsApp Business API webhook. Same endpoint handles web UI POSTs and WhatsApp payloads.
- **Google Drive Search** — Searches a specified 112 GB Drive folder via service account
- **Fuzzy Search (Credit Saver)** — Fuse.js corrects typos locally before any LLM call. "deli marbel" finds "Delhi marble" without spending API credits.
- **Voice Chat (Zero-Credit)** — Native Web Speech API for both input (SpeechRecognition) and output (SpeechSynthesis). No Whisper, no ElevenLabs, no paid APIs.
- **Rich Media** — Retrieved images display in a responsive carousel grid; PDFs/docs appear as clickable pill-shaped buttons with file-type icons
- **Supabase Auth** — Team login via email/password authentication
- **Chat History** — All conversations persisted in the `chat_sessions` table with RLS

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + Vite + Tailwind CSS |
| Backend | Supabase Edge Functions (Deno) |
| Database | Supabase Postgres |
| Auth | Supabase Auth (email/password) |
| Search | Fuse.js (fuzzy matching) |
| LLM | Google Gemini (free tier) |
| Voice | Web Speech API (browser-native) |
| Storage | Google Drive (service account) |

## Project Structure

```
sales-assistant-hub/
├── index.html
├── package.json
├── vite.config.js
├── tailwind.config.js
├── postcss.config.js
├── .env.example
├── .gitignore
├── public/
│   └── favicon.svg
├── src/
│   ├── main.jsx
│   ├── App.jsx
│   ├── index.css
│   ├── context/
│   │   └── AuthContext.jsx
│   ├── lib/
│   │   ├── supabase.js          # Supabase client + edge function URL
│   │   └── voice.js             # Web Speech API wrapper (recognition + synthesis)
│   └── components/
│       ├── ChatLayout.jsx       # Main layout orchestrator
│       ├── Sidebar.jsx          # History sidebar + user controls
│       ├── ChatWindow.jsx       # Message list + query dispatch logic
│       ├── ChatMessage.jsx      # Individual message bubble + document pills
│       ├── MediaCarousel.jsx    # Image carousel grid + lightbox
│       ├── ChatInput.jsx        # Text input + mic + send button
│       └── LoginScreen.jsx      # Auth screen
└── supabase/
    ├── config.toml
    ├── .env.example
    ├── migrations/
    │   └── 001_chat_sessions.sql  # Table + RLS policies
    └── functions/
        └── process_chat_query/
            ├── index.ts         # Main handler (webhook-ready)
            ├── googleDrive.ts   # Drive API auth + file listing
            ├── fuseSearch.ts    # Fuse.js fuzzy search (credit saver)
            └── deno.json
```

## Quick Start

### 1. Install Dependencies

```bash
cd sales-assistant-hub
npm install
```

### 2. Set Up Environment Variables

Copy `.env.example` to `.env` and fill in your Supabase credentials:

```bash
cp .env.example .env
```

```env
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
VITE_EDGE_FUNCTION_URL=https://your-project-ref.supabase.co/functions/v1/process_chat_query
```

### 3. Create Supabase Project

1. Go to [supabase.com](https://supabase.com) and create a new project
2. Note your Project URL and anon key from **Settings → API**
3. Run the SQL migration:
   - Go to **SQL Editor** in Supabase Dashboard
   - Paste the contents of `supabase/migrations/001_chat_sessions.sql`
   - Click **Run**

### 4. Deploy the Edge Function

```bash
# Install Supabase CLI
npm install -g supabase

# Login and link project
supabase login
supabase link --project-ref your-project-ref

# Set secrets
supabase secrets set GOOGLE_DRIVE_FOLDER_ID=your_112gb_folder_id
supabase secrets set GOOGLE_SERVICE_ACCOUNT_JSON='{"type":"service_account","project_id":"...","private_key":"...","client_email":"..."}'
supabase secrets set GEMINI_API_KEY=your_gemini_api_key
supabase secrets set WHATSAPP_VERIFY_TOKEN=sales_assistant_verify
supabase secrets set SUPABASE_URL=https://your-project-ref.supabase.co
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Deploy
supabase functions deploy process_chat_query
```

### 5. Set Up Google Drive Service Account

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project (or use existing)
3. Enable the **Google Drive API**
4. Create a **Service Account** (IAM & Admin → Service Accounts)
5. Create a **JSON key** and download it
6. Share your 112 GB Drive folder with the service account email
7. Note the **Folder ID** from the Drive folder URL

### 6. Set Up Google Gemini API Key (Optional — free tier)

1. Go to [Google AI Studio](https://aistudio.google.com)
2. Create an API key
3. Set it as the `GEMINI_API_KEY` secret

Without Gemini, the function still works — it returns matched files directly without LLM-generated text.

### 7. Run the Frontend

```bash
npm run dev
```

Open `http://localhost:5173`

### 8. Create Your First User

Sign up via the login screen. Supabase Auth handles email/password registration. You may need to disable email confirmation in Supabase → Authentication → Settings for development.

## Architecture

### Data Flow

```
┌─────────────┐     POST {message, user_id}      ┌──────────────────────┐
│  React UI   │ ──────────────────────────────────▶│  Edge Function       │
│  (Vite)     │◀──────────────────────────────────│  process_chat_query  │
└─────────────┘     JSON {response, media, docs}   └──────────┬───────────┘
                                                           │
                                    ┌──────────────────────┼──────────────────────┐
                                    ▼                      ▼                      ▼
                           ┌──────────────┐    ┌──────────────┐      ┌──────────────┐
                           │ Google Drive │    │   Fuse.js    │      │  Gemini LLM  │
                           │   API        │    │ Fuzzy Search │      │  (optional)  │
                           │              │    │ (Credit Saver)│     │              │
                           └──────────────┘    └──────────────┘      └──────────────┘
                                                     │
                                                     ▼
                                           ┌──────────────────┐
                                           │ Confident match? │
                                           └────────┬─────────┘
                                              YES ↙    ↘ NO
                                    Skip LLM call    Call LLM with
                                    (save credits)    file context
```

### WhatsApp Webhook Integration

The Edge Function is structured for WhatsApp from day one:

| HTTP Method | Purpose |
|---|---|
| `GET` | Meta webhook verification (`hub.mode`, `hub.verify_token`, `hub.challenge`) |
| `POST` | Message processing — detects WhatsApp payload structure and routes accordingly |

When a WhatsApp message arrives, the function:
1. Extracts the text from `body.entry[0].changes[0].value.messages[0].text.body`
2. Runs the same fuzzy search + LLM pipeline
3. Returns a WhatsApp-formatted text response with media URLs

To activate WhatsApp:
1. Set `WHATSAPP_VERIFY_TOKEN` as a secret
2. Add the function URL as your webhook in Meta Business Suite
3. Subscribe to the `messages` event
4. Uncomment the `sendWhatsAppMessage` call in `index.ts` to send replies via the Cloud API

### Credit-Saving Logic

The Fuse.js fuzzy search runs **before** any LLM call:

1. User types "deli marbel" (typo of "Delhi marble")
2. Fuse.js searches filenames with `threshold: 0.4` (tolerates the typo)
3. Match found with high confidence → **no LLM call** → returns files directly
4. If the match is ambiguous → LLM is called, but only with the filtered file list (not a fresh search)

This prevents wasting LLM API credits on queries that can be answered from the filename index alone.

### Voice Chat (Zero-Credit)

| Feature | API | Cost |
|---|---|---|
| Voice input | `SpeechRecognition` / `webkitSpeechRecognition` | Free |
| Text-to-speech | `SpeechSynthesis` | Free |
| Third-party APIs | None | — |

When voice input is used, the AI response is automatically spoken aloud. A "Stop" button appears while speaking. Browser support: Chrome/Edge (full), Safari (partial), Firefox (synthesis only).

## Build for Production

```bash
npm run build
```

The `dist/` folder contains the production-ready static files. Deploy to any static host (Vercel, Netlify, Cloudflare Pages, GitHub Pages) or Supabase Hosting.

## Deploy to GitHub

```bash
git init
git add .
git commit -m "Initial commit: Sales Assistant Hub"
git branch -M main
git remote add origin https://github.com/yourusername/sales-assistant-hub.git
git push -u origin main
```

## License

MIT
