/**
 * Google Drive API helper.
 *
 * Uses a Google Service Account to access the shared Drive folder.
 * Returns file metadata + thumbnail links for the Edge Function.
 */

interface ServiceAccount {
  client_email: string
  private_key: string
  project_id: string
}

interface DriveFile {
  id: string
  name: string
  mimeType: string
  thumbnailLink?: string
  webViewLink?: string
  webContentLink?: string
  iconLink?: string
}

const DRIVE_API = 'https://www.googleapis.com/drive/v3'
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3'

let cachedToken: string | null = null
let tokenExpiry = 0

/**
 * Get an OAuth2 access token using the service account JWT.
 * Implements RS256 JWT signing via Web Crypto API (Deno-compatible).
 */
async function getAccessToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000)

  if (cachedToken && now < tokenExpiry - 60) {
    return cachedToken
  }

  const header = { alg: 'RS256', typ: 'JWT' }
  const payload = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }

  // Base64url encode
  const b64url = (obj: object) =>
    btoa(JSON.stringify(obj))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')

  const unsignedToken = `${b64url(header)}.${b64url(payload)}`

  // Import private key for signing
  const pem = sa.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '')
  const keyBytes = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0))

  const keyData = await crypto.subtle.importKey(
    'pkcs8',
    keyBytes.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  )

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    keyData,
    new TextEncoder().encode(unsignedToken)
  )

  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

  const jwt = `${unsignedToken}.${sigB64}`

  // Exchange JWT for access token
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  })

  if (!resp.ok) {
    const errText = await resp.text()
    throw new Error(`Google Auth failed: ${resp.status} ${errText}`)
  }

  const tokenData = await resp.json()
  cachedToken = tokenData.access_token
  tokenExpiry = now + tokenData.expires_in
  return cachedToken!
}

/**
 * List files in the specified Google Drive folder.
 * Paginates through all results.
 */
export async function listDriveFiles(
  folderId: string,
  serviceAccount: ServiceAccount
): Promise<DriveFile[]> {
  const token = await getAccessToken(serviceAccount)
  const allFiles: DriveFile[] = []
  let pageToken: string | undefined

  const fields = 'files(id,name,mimeType,thumbnailLink,webViewLink,webContentLink,iconLink),nextPageToken'

  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields,
      pageSize: '200',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    })

    if (pageToken) params.set('pageToken', pageToken)

    const resp = await fetch(`${DRIVE_API}/files?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (!resp.ok) {
      const errText = await resp.text()
      throw new Error(`Drive API list failed: ${resp.status} ${errText}`)
    }

    const data = await resp.json()
    allFiles.push(...(data.files || []))
    pageToken = data.nextPageToken
  } while (pageToken)

  return allFiles
}

/**
 * Categorize files into images and documents.
 */
export function categorizeFiles(files: DriveFile[]) {
  const images: DriveFile[] = []
  const documents: DriveFile[] = []

  const imageMimeTypes = [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/bmp',
    'image/tiff',
    'image/svg+xml',
  ]

  for (const file of files) {
    if (imageMimeTypes.includes(file.mimeType)) {
      images.push(file)
    } else {
      documents.push(file)
    }
  }

  return { images, documents }
}

/**
 * Get a direct-access thumbnail URL with auth token.
 * Returns a URL that works for display in the chat.
 */
export function getImageUrl(file: DriveFile): string {
  if (file.thumbnailLink) {
    return file.thumbnailLink
  }
  // Fallback: use the Drive file API with the access token
  // The thumbnailLink is publicly accessible from the API response
  return `${DRIVE_API}/files/${file.id}?alt=media`
}

export function getFileDownloadUrl(file: DriveFile): string {
  return file.webContentLink || `${DRIVE_API}/files/${file.id}?alt=media`
}

export function getFileViewUrl(file: DriveFile): string {
  return file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`
}
