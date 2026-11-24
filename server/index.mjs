// External storage server for chat-demo.
//
// A tiny zero-dependency HTTP server that stores sessions and attachment blobs
// on disk. The chat-demo frontend can use it as a cross-device storage backend.
//
// Environment:
//   REMOTE_STORAGE_HOST  bind host (default 127.0.0.1)
//   REMOTE_STORAGE_PORT  bind port (default 8787)
//   REMOTE_STORAGE_TOKEN optional bearer token required from clients
//   DATA_DIR             storage directory (default ./data)
//   CORS_ORIGIN          allowed origin (default *)
//
// API:
//   GET    /health
//   GET    /api/sessions
//   GET    /api/sessions/:id
//   PUT    /api/sessions/:id
//   PATCH  /api/sessions/:id       body: { title }
//   DELETE /api/sessions/:id
//   GET    /api/files/:id
//   PUT    /api/files/:id
//   DELETE /api/files/:id
//   GET    /api/tombstones
//   DELETE /api/all

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { importOfficialArchive } from './import-official.mjs'

const HOST = process.env.REMOTE_STORAGE_HOST || '127.0.0.1'
const PORT = Number(process.env.REMOTE_STORAGE_PORT || 8787)
const TOKEN = process.env.REMOTE_STORAGE_TOKEN || ''
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*'
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'))
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions')
const FILES_DIR = path.join(DATA_DIR, 'files')
const TOMBSTONES_FILE = path.join(DATA_DIR, 'tombstones.json')
const JSON_LIMIT = 32 * 1024 * 1024
const FILE_LIMIT = 128 * 1024 * 1024
const IMPORT_LIMIT = 256 * 1024 * 1024
const ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/

await mkdir(SESSIONS_DIR, { recursive: true })
await mkdir(FILES_DIR, { recursive: true })

const corsHeaders = {
  'Access-Control-Allow-Origin': CORS_ORIGIN,
  'Access-Control-Allow-Methods': 'GET,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-File-Type',
  'Access-Control-Max-Age': '86400',
}

const sendJson = (res, status, value) => {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    ...corsHeaders,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

const sendText = (res, status, text) => {
  res.writeHead(status, {
    ...corsHeaders,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  })
  res.end(text)
}

const readBody = (req, limit) =>
  new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error(`request body exceeds ${limit} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })

const readJson = async (req) => {
  const body = await readBody(req, JSON_LIMIT)
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    throw new Error('invalid JSON body')
  }
}

const atomicWrite = async (file, data) => {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(tmp, data)
  await rename(tmp, file)
}

const ensureId = (id) => {
  if (!ID_PATTERN.test(id)) {
    const error = new Error('invalid id')
    error.status = 400
    throw error
  }
  return id
}

const sessionFile = (id) => path.join(SESSIONS_DIR, `${ensureId(id)}.json`)
const filePath = (id) => path.join(FILES_DIR, ensureId(id))
const fileMetaPath = (id) => path.join(FILES_DIR, `${ensureId(id)}.json`)

const writeStoredFile = async (id, data, contentType) => {
  await atomicWrite(filePath(id), data)
  await atomicWrite(
    fileMetaPath(id),
    JSON.stringify({ contentType, size: data.length, updatedAt: Date.now() })
  )
}

const readTombstones = async () => {
  try {
    const value = JSON.parse(await readFile(TOMBSTONES_FILE, 'utf8'))
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

const writeTombstones = (tombstones) => atomicWrite(TOMBSTONES_FILE, JSON.stringify(tombstones))

const addTombstone = async (id, deletedAt = Date.now()) => {
  const tombstones = (await readTombstones()).filter((item) => item.id !== id)
  tombstones.push({ id, deletedAt })
  await writeTombstones(tombstones)
}

const loadSession = async (id) => {
  try {
    return JSON.parse(await readFile(sessionFile(id), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

const summarize = (session) => ({
  id: session.id,
  title: session.title,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
})

const listSessions = async () => {
  const names = await readdir(SESSIONS_DIR)
  const sessions = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const session = JSON.parse(await readFile(path.join(SESSIONS_DIR, name), 'utf8'))
      if (session && typeof session.id === 'string') sessions.push(summarize(session))
    } catch {
      // Ignore a partially written or manually corrupted file.
    }
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt)
}

const authorized = (req) => {
  if (!TOKEN) return true
  return req.headers.authorization === `Bearer ${TOKEN}`
}

const notFound = (res) => sendJson(res, 404, { error: 'not_found' })

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders)
      res.end()
      return
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const pathname = decodeURIComponent(url.pathname)

    if (pathname === '/health') {
      sendJson(res, 200, { ok: true })
      return
    }

    if (!authorized(req)) {
      sendJson(res, 401, { error: 'unauthorized' })
      return
    }

    if (pathname === '/api/sessions' && req.method === 'GET') {
      sendJson(res, 200, await listSessions())
      return
    }

    if (pathname === '/api/tombstones' && req.method === 'GET') {
      sendJson(res, 200, await readTombstones())
      return
    }

    if (pathname === '/api/import/official' && req.method === 'POST') {
      const body = await readBody(req, IMPORT_LIMIT)
      const imported = importOfficialArchive(body)
      for (const file of imported.files) {
        await writeStoredFile(file.id, file.data, file.contentType)
      }
      for (const session of imported.sessions) {
        await atomicWrite(sessionFile(session.id), JSON.stringify(session))
      }
      sendJson(res, 200, {
        ok: true,
        sessions: imported.sessions.length,
        files: imported.files.length,
        entries: imported.entryCount,
      })
      return
    }

    if (pathname === '/api/all' && req.method === 'DELETE') {
      await rm(SESSIONS_DIR, { recursive: true, force: true })
      await rm(FILES_DIR, { recursive: true, force: true })
      await mkdir(SESSIONS_DIR, { recursive: true })
      await mkdir(FILES_DIR, { recursive: true })
      await writeTombstones([])
      sendJson(res, 200, { ok: true })
      return
    }

    const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/)
    if (sessionMatch) {
      const id = sessionMatch[1]
      if (req.method === 'GET') {
        const session = await loadSession(id)
        if (!session) return notFound(res)
        sendJson(res, 200, session)
        return
      }
      if (req.method === 'PUT') {
        const body = await readJson(req)
        if (!body || body.id !== id) return sendJson(res, 400, { error: 'session id mismatch' })
        await atomicWrite(sessionFile(id), JSON.stringify(body))
        sendJson(res, 200, { ok: true })
        return
      }
      if (req.method === 'PATCH') {
        const body = await readJson(req)
        if (!body || typeof body.title !== 'string') {
          return sendJson(res, 400, { error: 'title is required' })
        }
        const session = await loadSession(id)
        if (!session) return notFound(res)
        session.title = body.title
        session.updatedAt = Date.now()
        await atomicWrite(sessionFile(id), JSON.stringify(session))
        sendJson(res, 200, summarize(session))
        return
      }
      if (req.method === 'DELETE') {
        await rm(sessionFile(id), { force: true })
        await addTombstone(id)
        sendJson(res, 200, { ok: true })
        return
      }
    }

    const fileMatch = pathname.match(/^\/api\/files\/([^/]+)$/)
    if (fileMatch) {
      const id = fileMatch[1]
      if (req.method === 'GET') {
        try {
          const blob = await readFile(filePath(id))
          let contentType = 'application/octet-stream'
          try {
            const meta = JSON.parse(await readFile(fileMetaPath(id), 'utf8'))
            if (typeof meta.contentType === 'string') contentType = meta.contentType
          } catch {
            // No metadata: use the generic binary content type.
          }
          res.writeHead(200, {
            ...corsHeaders,
            'Content-Type': contentType,
            'Content-Length': blob.length,
            'Cache-Control': 'no-store',
          })
          res.end(blob)
        } catch (error) {
          if (error.code === 'ENOENT') return notFound(res)
          throw error
        }
        return
      }
      if (req.method === 'PUT') {
        const body = await readBody(req, FILE_LIMIT)
        const contentType =
          req.headers['x-file-type'] ||
          (req.headers['content-type'] && req.headers['content-type'] !== 'application/octet-stream'
            ? req.headers['content-type']
            : 'application/octet-stream')
        await atomicWrite(filePath(id), body)
        await atomicWrite(
          fileMetaPath(id),
          JSON.stringify({ contentType, size: body.length, updatedAt: Date.now() })
        )
        sendJson(res, 200, { ok: true, size: body.length })
        return
      }
      if (req.method === 'DELETE') {
        await rm(filePath(id), { force: true })
        await rm(fileMetaPath(id), { force: true })
        sendJson(res, 200, { ok: true })
        return
      }
    }

    notFound(res)
  } catch (error) {
    const status = error.status || 500
    sendText(res, status, error instanceof Error ? error.message : String(error))
  }
})

server.listen(PORT, HOST, () => {
  console.log(`chat-demo external storage listening on http://${HOST}:${PORT}`)
  console.log(`data directory: ${DATA_DIR}`)
})
