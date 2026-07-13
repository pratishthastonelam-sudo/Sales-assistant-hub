# Supabase Edge Function: process_chat_query

## Environment Variables / Secrets

Set these via `supabase secrets set` (production) or `supabase/.env` (local):

```bash
# Google Drive
GOOGLE_DRIVE_FOLDER_ID=your_112gb_folder_id
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}

# LLM (Google Gemini — free tier available)
GEMINI_API_KEY=your_gemini_api_key

# WhatsApp webhook verification
WHATSAPP_VERIFY_TOKEN=your_custom_verify_token

# Supabase (for logging queries)
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

## Local Development

```bash
# Install Supabase CLI
npm install -g supabase

# Login and link your project
supabase login
supabase link --project-ref your-project-ref

# Set secrets
supabase secrets set GOOGLE_DRIVE_FOLDER_ID=xxx
supabase secrets set GOOGLE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'
supabase secrets set GEMINI_API_KEY=xxx
supabase secrets set WHATSAPP_VERIFY_TOKEN=your_token

# Serve locally
supabase functions serve process_chat_query --no-verify-jwt
```

## Deploy

```bash
supabase functions deploy process_chat_query
```

The function URL will be:
```
https://your-project-ref.supabase.co/functions/v1/process_chat_query
```

## WhatsApp Webhook Setup

1. Go to Meta Business Suite → WhatsApp Manager → API Setup
2. Add the webhook URL: `https://your-project-ref.supabase.co/functions/v1/process_chat_query`
3. Set the Verify Token to match `WHATSAPP_VERIFY_TOKEN`
4. Subscribe to `messages` event
5. The function handles both GET (verification) and POST (messages)
