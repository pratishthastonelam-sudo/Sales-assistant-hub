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
  // ?thumb=800 returns a small preview (Drive thumbnail) instead of the full file,
  // so chat previews don't pull 25MB originals or whole videos.
  const thumb = url.searchParams.get('thumb')
  const download = url.searchParams.get('download') === '1'

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
    if (thumb) {
      const metaResp = await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}?fields=thumbnailLink&supportsAllDrives=true`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      const link = metaResp.ok ? (await metaResp.json()).thumbnailLink : null
      if (link) {
        const size = Math.min(Math.max(parseInt(thumb) || 800, 100), 1600)
        const thumbResp = await fetch(link.replace(/=s\d+$/, `=s${size}`), {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (thumbResp.ok) {
          return new Response(thumbResp.body, {
            headers: {
              ...CORS_HEADERS,
              'Content-Type': thumbResp.headers.get('Content-Type') || 'image/jpeg',
              'Cache-Control': 'public, max-age=86400',
            },
          })
        }
      }
      // No thumbnail (e.g. huge TIFFs): don't stream the multi-hundred-MB original as a "preview"
      return new Response('No preview available', { status: 404, headers: CORS_HEADERS })
    }

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
    //    when Drive returns them (needed for video scrubbing). Streamed rather
    //    than buffered so large videos and brochures don't exhaust memory.
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

    if (download) {
      const nameResp = await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}?fields=name&supportsAllDrives=true`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      const name = nameResp.ok ? (await nameResp.json()).name : fileId
      responseHeaders['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`
    }

    return new Response(driveResp.body, {
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