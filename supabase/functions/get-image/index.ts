// supabase/functions/get-image/index.ts

import { getAccessToken, type ServiceAccount } from '../process_chat_query/googleDrive.ts'

const SA_JSON = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON') ?? ''

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, Range',
  'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS })
  }

  const url = new URL(req.url)
  const fileId = url.searchParams.get('fileId')

  if (!fileId) {
    return new Response('Missing fileId', { status: 400, headers: CORS_HEADERS })
  }

  if (!SA_JSON) {
    return new Response('Google Drive not configured. Set GOOGLE_SERVICE_ACCOUNT_JSON secret.', {
      status: 500,
      headers: CORS_HEADERS,
    })
  }

  try {
    const serviceAccount = JSON.parse(SA_JSON) as ServiceAccount

    // 1. Get an access token via the shared service-account JWT flow
    const token = await getAccessToken(serviceAccount)

    // 2. Fetch the file's raw bytes directly from Google Drive.
    //    Forward the browser's Range header (used for video seeking/
    //    scrubbing) so Drive can return partial content instead of the
    //    whole file every time.
    const driveHeaders: Record<string, string> = { Authorization: `Bearer ${token}` }
    const rangeHeader = req.headers.get('Range')
    if (rangeHeader) {
      driveHeaders['Range'] = rangeHeader
    }

    const driveResp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
      { headers: driveHeaders }
    )

    if (!driveResp.ok && driveResp.status !== 206) {
      const errText = await driveResp.text()
      return new Response(`Failed to fetch image: ${driveResp.status} ${errText}`, {
        status: 502,
        headers: CORS_HEADERS,
      })
    }

    // 3. Stream the file back with the correct headers for browser
    //    rendering/playback. Preserve 206 Partial Content + range headers
    //    when Drive returns them (needed for video scrubbing).
    const buffer = await driveResp.arrayBuffer()
    const responseHeaders: Record<string, string> = {
      ...CORS_HEADERS,
      'Content-Type': driveResp.headers.get('Content-Type') || 'application/octet-stream',
      'Cache-Control': 'public, max-age=86400', // Cache for 1 day
      'Accept-Ranges': 'bytes',
    }

    const contentRange = driveResp.headers.get('Content-Range')
    if (contentRange) responseHeaders['Content-Range'] = contentRange

    const contentLength = driveResp.headers.get('Content-Length')
    if (contentLength) responseHeaders['Content-Length'] = contentLength

    return new Response(buffer, {
      status: driveResp.status === 206 ? 206 : 200,
      headers: responseHeaders,
    })
  } catch (err) {
    return new Response(`Internal error: ${(err as Error).message}`, {
      status: 500,
      headers: CORS_HEADERS,
    })
  }
})