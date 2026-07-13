/**
 * Fuse.js fuzzy search implementation.
 *
 * This is the "Credit Saver" — when a user misspells a query
 * (e.g., "deli marbel" instead of "Delhi marble"), Fuse.js matches
 * the correct filenames LOCALLY before any LLM call is made.
 * This prevents wasting LLM API credits on failed typo queries.
 */

import Fuse from 'npm:fuse.js@7.0.0'

interface DriveFile {
  id: string
  name: string
  mimeType: string
  thumbnailLink?: string
  webViewLink?: string
  webContentLink?: string
  iconLink?: string
}

interface FuseResult {
  item: DriveFile
  score?: number
}

/**
 * Create a Fuse index over file names.
 * Configured for typo-tolerance:
 *   - threshold: 0.4 (moderate fuzziness — allows "marbel" → "marble")
 *   - ignoreLocation: true (matches anywhere in the filename)
 *   - minMatchCharLength: 3 (avoids noise from short typos)
 */
function createFuseIndex(files: DriveFile[]): Fuse<DriveFile> {
  return new Fuse(files, {
    keys: ['name'],
    threshold: 0.4,
    ignoreLocation: true,
    minMatchCharLength: 3,
    includeScore: true,
    findAllMatches: true,
  })
}

/**
 * Split a user query into search terms and run fuzzy search on each.
 * This handles multi-word queries like "delhi marble slab" — each word
 * gets fuzzy-matched independently, then we intersect/deduplicate results.
 */
export function fuzzySearch(
  query: string,
  files: DriveFile[],
  maxResults = 20
): DriveFile[] {
  if (!query || files.length === 0) return []

  const fuse = createFuseIndex(files)
  const resultsMap = new Map<string, { file: DriveFile; totalScore: number; matchCount: number }>()

  // Split query into terms, filter out very short words
  const terms = query
    .toLowerCase()
    .split(/[\s,]+/)
    .filter((t) => t.length >= 2)

  // Also search the full query string as one phrase
  const fullQuery = query.toLowerCase().trim()
  if (fullQuery.length >= 3) {
    const fullResults = fuse.search(fullQuery)
    for (const r of fullResults) {
      const score = r.score ?? 1
      const existing = resultsMap.get(r.item.id)
      if (existing) {
        existing.totalScore += score * 2 // Full-phrase match weighted higher
        existing.matchCount++
      } else {
        resultsMap.set(r.item.id, {
          file: r.item,
          totalScore: score * 2,
          matchCount: 1,
        })
      }
    }
  }

  // Search each term individually
  for (const term of terms) {
    const termResults: FuseResult[] = fuse.search(term)
    for (const r of termResults) {
      const score = r.score ?? 1
      const existing = resultsMap.get(r.item.id)
      if (existing) {
        existing.totalScore += score
        existing.matchCount++
      } else {
        resultsMap.set(r.item.id, {
          file: r.item,
          totalScore: score,
          matchCount: 1,
        })
      }
    }
  }

  // Sort: files matching more terms first, then by lower score (better match)
  const sorted = Array.from(resultsMap.values()).sort((a, b) => {
    if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount
    return a.totalScore - b.totalScore
  })

  return sorted.slice(0, maxResults).map((r) => r.file)
}

/**
 * Determine if the fuzzy search found confident matches.
 * If the best match score is below 0.3 (Fuse scores 0=perfect, 1=no match),
 * we consider it a confident match. This is used to decide whether to
 * call the LLM at all (credit saver) or return files directly.
 */
export function hasConfidentMatch(
  query: string,
  files: DriveFile[]
): boolean {
  if (!query || files.length === 0) return false

  const fuse = createFuseIndex(files)
  const results = fuse.search(query.toLowerCase().trim())

  if (results.length === 0) return false
  const bestScore = results[0].score ?? 1
  return bestScore <= 0.4 // threshold for confidence
}

/**
 * Format matched files into a context string for the LLM.
 * This keeps the prompt lean while giving the LLM enough info.
 */
export function formatFileContext(files: DriveFile[]): string {
  if (files.length === 0) return 'No matching files found in the Drive.'

  const lines = files.map((f, i) => {
    const type = f.mimeType.startsWith('image/') ? '[Image]' : '[Document]'
    return `${i + 1}. ${type} "${f.name}" (id: ${f.id})`
  })

  return `Found ${files.length} relevant files:\n${lines.join('\n')}`
}
