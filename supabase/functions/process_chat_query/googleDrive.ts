/**
 * Google Drive API helper.
 *
 * Uses a Google Service Account to access the shared Drive folder.
 * Returns file metadata + thumbnail links for the Edge Function.
 */

export interface ServiceAccount {
  client_email: string
  private_key: string
  project_id: string
}

export interface DriveFile {
  id: string
  name: string
  mimeType: string
  thumbnailLink?: string
  webViewLink?: string
  webContentLink?: string
  iconLink?: string
}

const DRIVE_API = 'https://www.googleapis.com/drive/v3'

let cachedToken: string | null = null
let tokenExpiry = 0

function base64url(input: ArrayBuffer | string): string {
  const bytes =
    typeof input === 'string'
      ? new TextEncoder().encode(input)
      : new Uint8Array(input)

  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)

  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/**
 * Get an OAuth2 access token using the service account JWT.
 * Implements RS256 JWT signing via Web Crypto API (Deno-compatible).
 * Exported so other functions (e.g. get-image) can reuse it directly.
 */
export async function getAccessToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000)

  if (cachedToken && now < tokenExpiry - 60) {
    return cachedToken
  }

  const header = { alg: 'RS256', typ: 'JWT' }
  const payload = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  }

  const unsignedToken = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(payload)
  )}`

  // Import the PKCS8 private key for RS256 signing
  const pem = sa.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '')
  const keyBytes = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0))

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    keyBytes.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  )

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(unsignedToken)
  )

  const jwt = `${unsignedToken}.${base64url(signature)}`

  // Exchange the signed JWT for an access token
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

const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder'

/**
 * List the immediate children (files + subfolders) of a single Drive folder.
 * Paginates through all results. Internal helper — not exported.
 */
async function listFolderChildren(
  folderId: string,
  token: string
): Promise<DriveFile[]> {
  const allEntries: DriveFile[] = []
  let pageToken: string | undefined

  const fields =
    'files(id,name,mimeType,thumbnailLink,webViewLink,webContentLink,iconLink),nextPageToken'

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
    allEntries.push(...(data.files || []))
    pageToken = data.nextPageToken
  } while (pageToken)

  return allEntries
}

/**
 * Internal recursive worker. Takes an already-fetched token so we don't
 * re-resolve it (and hit the cache lock) on every recursive call.
 */
async function listDriveFilesRecursive(
  folderId: string,
  token: string,
  depth: number
): Promise<DriveFile[]> {
  // Safety cap so a misconfigured Drive structure can't cause runaway recursion
  if (depth > 8) return []

  const entries = await listFolderChildren(folderId, token)

  const files: DriveFile[] = []
  const subfolders: DriveFile[] = []

  for (const entry of entries) {
    if (entry.mimeType === FOLDER_MIME_TYPE) {
      subfolders.push(entry)
    } else {
      files.push(entry)
    }
  }

  // Recurse into all subfolders IN PARALLEL rather than one at a time —
  // this is the main speed win when a folder has several subfolders.
  if (subfolders.length > 0) {
    const nestedResults = await Promise.all(
      subfolders.map((folder) =>
        listDriveFilesRecursive(folder.id, token, depth + 1)
      )
    )
    for (const nested of nestedResults) {
      files.push(...nested)
    }
  }

  return files
}

/**
 * List all files in the specified Google Drive folder, recursing into
 * subfolders so files nested inside them are included too. Folders
 * themselves are never included in the returned results — only actual
 * downloadable files.
 */
export async function listDriveFiles(
  folderId: string,
  serviceAccount: ServiceAccount
): Promise<DriveFile[]> {
  const token = await getAccessToken(serviceAccount)
  return listDriveFilesRecursive(folderId, token, 0)
}

/**
 * Categorize files into images and documents.
 */
export function categorizeFiles(files: DriveFile[]) {
  const images: DriveFile[] = []
  const videos: DriveFile[] = []
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
    } else if (file.mimeType.startsWith('video/')) {
      videos.push(file)
    } else {
      documents.push(file)
    }
  }

  return { images, videos, documents }
}

/**
 * Get a direct-access thumbnail URL.
 * Falls back to our own get-image proxy function (which streams the
 * file from Drive using the service account) if no thumbnail exists.
 */
export function getImageUrl(file: DriveFile): string {
  if (file.thumbnailLink) {
    return file.thumbnailLink
  }
  const projectRef = Deno.env.get('SUPABASE_URL') ?? ''
  return `${projectRef}/functions/v1/get-image?fileId=${file.id}`
}

export function getFileDownloadUrl(file: DriveFile): string {
  // Always use our own proxy — Google's webContentLink requires an
  // authenticated Google session and will not load in a plain <img> tag
  // for private files, causing broken images in the browser.
  const projectRef = Deno.env.get('SUPABASE_URL') ?? ''
  return `${projectRef}/functions/v1/get-image?fileId=${file.id}`
}

export function getFileViewUrl(file: DriveFile): string {
  return file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`
}