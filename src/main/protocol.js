import { net, protocol } from 'electron'
import { extname, join, relative, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isSessionId } from './sessions.js'

// Serves session files to the renderer:
//   resonant://session/<id>/reference.wav
//   resonant://session/<id>/stems/drums.wav
export const SCHEME = 'resonant'

const CONTENT_TYPES = { '.wav': 'audio/wav', '.json': 'application/json' }

// Must run before the app is ready. Lets the page fetch() these URLs.
export function registerSchemePrivileges() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
    },
  ])
}

// Maps a resonant:// URL to a file inside that session's folder, or null if it
// isn't one. Never resolves outside the session folder.
export function resolveSessionUrl(sessionsDir, url) {
  let parsed
  let parts
  try {
    parsed = new URL(url)
    parts = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  } catch {
    return null
  }
  if (parsed.protocol !== `${SCHEME}:` || parsed.hostname !== 'session') return null

  const [id, ...fileParts] = parts
  if (!isSessionId(id) || fileParts.length === 0) return null

  const sessionDir = join(sessionsDir, id)
  const filePath = join(sessionDir, ...fileParts)
  const rel = relative(sessionDir, filePath)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return filePath
}

export function handleSessionProtocol(getSessionsDir) {
  protocol.handle(SCHEME, async (request) => {
    const filePath = resolveSessionUrl(getSessionsDir(), request.url)
    if (!filePath) return new Response('Not found', { status: 404 })

    let file
    try {
      file = await net.fetch(pathToFileURL(filePath).toString())
    } catch {
      return new Response('Not found', { status: 404 })
    }
    const headers = new Headers(file.headers)
    headers.set('Content-Type', CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream')
    // The page's origin is the dev server or file://, so allow it to read the response
    headers.set('Access-Control-Allow-Origin', '*')
    return new Response(file.body, { status: file.status, headers })
  })
}
