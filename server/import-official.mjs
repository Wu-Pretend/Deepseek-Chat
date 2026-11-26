// Server-side importer for DeepSeek's official chat-history ZIP archives
// (export_format_version: 3). Kept dependency-free and intentionally close to
// the browser-side importer so both produce the same Session shape.

import { inflateRawSync } from 'node:zlib'

const EXPORT_FORMAT_VERSION = 3

const fail = (message) => {
  const error = new Error(message)
  error.status = 400
  throw error
}

const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const sessionId = (value) => {
  if (typeof value !== 'string' || !value || /[/\\]/.test(value) || value === '.' || value === '..') {
    fail('invalid session id in official archive')
  }
  return value
}

// ---------------------------------------------------------------------------
// Minimal ZIP32 reader (STORE / DEFLATE), sufficient for official exports.

const findEndOfCentralDirectory = (buffer) => {
  const min = Math.max(0, buffer.length - 0xffff - 22)
  for (let offset = buffer.length - 22; offset >= min; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset
  }
  fail('invalid ZIP archive: end of central directory not found')
}

export const readZipDirectory = (buffer) => {
  const eocd = findEndOfCentralDirectory(buffer)
  const entriesCount = buffer.readUInt16LE(eocd + 10)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (entriesCount === 0xffff || centralOffset === 0xffffffff) {
    fail('ZIP64 archives are not supported')
  }

  const entries = new Map()
  let offset = centralOffset
  for (let index = 0; index < entriesCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) fail('invalid ZIP central directory')
    const flags = buffer.readUInt16LE(offset + 8)
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const uncompressedSize = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localHeaderOffset = buffer.readUInt32LE(offset + 42)
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      fail('ZIP64 archives are not supported')
    }
    const nameBytes = buffer.subarray(offset + 46, offset + 46 + nameLength)
    const name = nameBytes.toString(flags & 0x800 ? 'utf8' : 'latin1').normalize('NFC')

    if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      fail(`invalid ZIP local header for ${name}`)
    }
    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28)
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength
    entries.set(name, { method, compressedSize, uncompressedSize, dataStart })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** Decompress one archive entry on demand; callers must not retain large buffers. */
const readZipEntry = (buffer, entry) => {
  if (!entry) fail('missing ZIP entry')
  const compressed = buffer.subarray(entry.dataStart, entry.dataStart + entry.compressedSize)
  let data
  if (entry.method === 0) {
    data = Buffer.from(compressed)
  } else if (entry.method === 8) {
    data = inflateRawSync(compressed)
  } else {
    fail(`unsupported ZIP compression method ${entry.method}`)
  }
  if (entry.uncompressedSize !== data.length) {
    fail('invalid ZIP entry size')
  }
  return data
}

// ---------------------------------------------------------------------------
// Official archive -> local Session conversion (mirrors src/services/chat/history/toLocal.ts).

const isWebUrl = (value) => {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

const sessionFilesDir = (id) => `chat_sessions/${id}_files/`

const toFile = (file) => ({
  id: file.id,
  serverId: null,
  name: file.file_name,
  size: file.file_size,
  isImage: file.is_image,
  mimeType: '',
})

const toUser = (message) => ({
  id: String(message.id),
  role: 'user',
  createdAt: Date.parse(message.inserted_at),
  content: message.fragments.map((item) => (item.type === 'REQUEST' ? item.content : '')).join(''),
  files: message.fragments.flatMap((item) => (item.type === 'FILE' ? item.files.map(toFile) : [])),
})

const toolBlocks = (id, input, kind, result) => [
  {
    type: 'server_tool_use',
    id,
    name: kind === 'read_link' ? 'deepseek_read_url' : 'deepseek_web_search',
    input,
    kind,
    caller: { type: 'direct' },
  },
  ...(result ? [result] : []),
]

const fetchResult = (toolUseId, content) => ({
  type: 'web_fetch_tool_result',
  tool_use_id: toolUseId,
  kind: 'deep_search',
  content,
})

const fetched = (url, title, publishedAt) => ({
  type: 'web_fetch_result',
  url,
  content: {
    type: 'document',
    source: { type: 'text', media_type: 'text/plain', data: '' },
    title,
  },
  published_at: publishedAt,
})

const unavailable = {
  type: 'web_fetch_tool_result_error',
  error_code: 'unavailable',
}

const toBlocks = (fragments, messageId) => {
  const searchKind = fragments.some(
    (item) => item.type === 'TOOL_OPEN' || item.type === 'TOOL_FIND'
  )
    ? 'deep_search'
    : 'search'
  return fragments.flatMap((item, index) => {
    const id = `history-${messageId}-${index}`
    switch (item.type) {
      case 'RESPONSE':
        return [{ type: 'text', text: item.content }]
      case 'TEMPLATE_RESPONSE':
        return [{ type: 'text', text: item.content, isTemplate: true }]
      case 'THINK':
        return [
          {
            type: 'thinking',
            thinking: item.content,
            ...(item.elapsed_secs === null ? {} : { elapsedSeconds: item.elapsed_secs }),
          },
        ]
      case 'TOOL_SEARCH':
        return toolBlocks(
          id,
          { action: 'search', query: item.queries[0] ?? '', queries: item.queries },
          searchKind,
          item.status === 'WIP'
            ? undefined
            : {
                type: 'web_search_tool_result',
                tool_use_id: id,
                kind: searchKind,
                content:
                  item.status === 'FAILED'
                    ? [{ type: 'web_search_tool_result_error', error_code: 'unavailable' }]
                    : item.results
                        .filter((result) => isWebUrl(result.url))
                        .map((result) => ({
                          type: 'web_search_result',
                          url: result.url,
                          title: result.title,
                          snippet: result.snippet,
                          site_icon:
                            result.site_icon && isWebUrl(result.site_icon)
                              ? result.site_icon
                              : null,
                          site_name: result.site_name,
                          page_age: result.published_at,
                          encrypted_content: '',
                        })),
              }
        )
      case 'TOOL_OPEN':
        if (!item.url || !isWebUrl(item.url)) return []
        return toolBlocks(
          id,
          { action: 'open_page', url: item.url },
          'deep_search',
          item.status === 'WIP'
            ? undefined
            : fetchResult(
                id,
                item.status === 'FINISHED'
                  ? fetched(item.url, item.title, item.published_at)
                  : unavailable
              )
        )
      case 'TOOL_FIND':
        return toolBlocks(
          id,
          { action: 'find_in_page', url: '', pattern: item.pattern ?? '' },
          'deep_search',
          item.status === 'WIP'
            ? undefined
            : fetchResult(id, item.status === 'FINISHED' ? fetched('', null, null) : unavailable)
        )
      case 'READ_LINK':
        return item.results.flatMap((result, resultIndex) => {
          const url = result.url && isWebUrl(result.url) ? result.url : ''
          if (!url && !result.signature.trim()) return []
          const toolId = `${id}-${resultIndex}`
          return toolBlocks(toolId, { action: 'read_link', url }, 'read_link', {
            type: 'web_fetch_tool_result',
            tool_use_id: toolId,
            kind: 'read_link',
            content: fetched(url, result.title ?? null, null),
            signature: result.signature,
          })
        })
      default:
        return []
    }
  })
}

const replyStatus = {
  FINISHED: 'done',
  CONTENT_FILTER: 'done',
  FAILED: 'error',
  CONTEXT_LENGTH_EXCEEDED: 'error',
  INCOMPLETE: 'stopped',
  TIMEOUT: 'error',
  WIP: 'stopped',
}

const toAssistant = (message) => {
  const id = String(message.id)
  const blocks = toBlocks(message.fragments, id)
  const refused = message.status === 'CONTENT_FILTER'
  return {
    id,
    role: 'assistant',
    createdAt: Date.parse(message.inserted_at),
    model: null,
    thinking: message.thinking_enabled,
    search: message.search_enabled,
    prefix: false,
    status: replyStatus[message.status] ?? 'error',
    ...(refused ? { stopReason: 'refusal' } : {}),
    blocks: refused
      ? blocks.filter(
          (block) => block.type !== 'thinking' && (block.type !== 'text' || block.isTemplate)
        )
      : blocks,
  }
}

const buildTree = (file) => {
  const sorted = [...file.messages].sort((a, b) => a.id - b.id)
  const byId = new Map()
  const messages = sorted.map((message) => {
    const { id, parent_id } = message
    const parent = parent_id === null ? undefined : byId.get(parent_id)
    if (
      byId.has(id) ||
      (parent_id === null ? message.role !== 'USER' : !parent) ||
      (parent && parent.role === (message.role === 'USER' ? 'user' : 'assistant'))
    ) {
      fail('invalid message tree in official archive')
    }
    const local = message.role === 'USER' ? toUser(message) : toAssistant(message)
    local.parentId = parent ? parent.id : null
    if (parent) parent.selectedChildId = local.id
    byId.set(id, local)
    return local
  })
  if (messages.length === 0) return { messages, rootMessageId: null }
  let current = byId.get(file.current_message_id)
  if (!current) fail('current_message_id is missing from official archive')
  current.selectedChildId = undefined
  while (current.parentId) {
    const parent = byId.get(Number(current.parentId))
    if (!parent) fail('invalid message parent in official archive')
    parent.selectedChildId = current.id
    current = parent
  }
  return { messages, rootMessageId: current.id }
}

export const toLocalSession = (file) => {
  if (!isRecord(file) || !Array.isArray(file.messages)) {
    fail('invalid session JSON in official archive')
  }
  const session = {
    id: sessionId(file.id),
    title: file.title ?? '',
    createdAt: Date.parse(file.inserted_at),
    updatedAt: Date.parse(file.updated_at),
    ...buildTree(file),
  }
  const images = new Map()
  for (const message of file.messages) {
    for (const item of message.fragments ?? []) {
      if (item.type !== 'FILE') continue
      for (const entry of item.files) {
        if (!entry.is_image) continue
        const path = entry.export_path?.normalize('NFC')
        if (path === undefined) continue
        if (
          !path.startsWith(sessionFilesDir(file.id)) ||
          (images.get(path) ?? entry.id) !== entry.id
        ) {
          fail('invalid image reference in official archive')
        }
        images.set(path, entry.id)
      }
    }
  }
  return { session, images }
}

// ---------------------------------------------------------------------------
// Whole-archive conversion.

const imageType = (bytes) => {
  const startsWith = (...prefix) => prefix.every((byte, index) => bytes[index] === byte)
  const header = bytes.subarray(0, 12).toString('ascii')
  if (startsWith(0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) return 'image/gif'
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') return 'image/webp'
  if (startsWith(0x42, 0x4d)) return 'image/bmp'
  if (startsWith(0x49, 0x49, 0x2a, 0) || startsWith(0x4d, 0x4d, 0, 0x2a)) return 'image/tiff'
  if (header.slice(4, 8) === 'ftyp' && ['avif', 'avis'].includes(header.slice(8, 12))) {
    return 'image/avif'
  }
  return 'application/octet-stream'
}

const parseJsonEntry = (buffer, entries, path) => {
  const entry = entries.get(path)
  if (!entry) fail(`missing ${path} in official archive`)
  try {
    return JSON.parse(readZipEntry(buffer, entry).toString('utf8'))
  } catch {
    fail(`invalid JSON in ${path}`)
  }
}

/**
 * Process an official archive incrementally. Uncompressed entries are never
 * all retained: each session JSON and each image is decoded only when needed,
 * then handed to the caller for immediate persistence.
 */
export const importOfficialArchive = async (buffer, handlers) => {
  const entries = readZipDirectory(buffer)
  const manifest = parseJsonEntry(buffer, entries, 'manifest.json')
  if (!isRecord(manifest)) fail('invalid manifest.json')
  if (manifest.export_format_version > EXPORT_FORMAT_VERSION) {
    fail('archive format is newer than this server supports')
  }
  if (manifest.export_format_version !== EXPORT_FORMAT_VERSION) {
    fail('unsupported archive format version')
  }

  const index = parseJsonEntry(buffer, entries, 'chat_session_index.json')
  if (!Array.isArray(index)) fail('invalid chat_session_index.json')
  const listed = new Set(index.map((item) => item && item.id))
  if (listed.size !== index.length) fail('duplicate session ids in chat_session_index.json')

  const sessionPaths = [...entries.keys()].filter((path) =>
    /^chat_sessions\/[^/]+\.json$/.test(path)
  )
  if (sessionPaths.length !== listed.size) fail('session index does not match archive entries')

  const importedIds = new Set()
  const seenFiles = new Set()
  let fileCount = 0

  for (const path of sessionPaths) {
    const raw = parseJsonEntry(buffer, entries, path)
    const { session, images } = toLocalSession(raw)
    if (!listed.has(session.id) || importedIds.has(session.id)) {
      fail(`session ${session.id} is missing from the index`)
    }

    const imageByFileId = new Map([...images.entries()].map(([imagePath, id]) => [id, imagePath]))
    for (const message of session.messages) {
      if (message.role !== 'user') continue
      for (const file of message.files) {
        if (seenFiles.has(file.id)) continue
        const imagePath = imageByFileId.get(file.id)
        if (!imagePath) continue
        const entry = entries.get(imagePath)
        if (!entry) continue
        const bytes = readZipEntry(buffer, entry)
        const contentType = imageType(bytes)
        file.mimeType = contentType
        await handlers.onFile({ id: file.id, data: bytes, contentType })
        seenFiles.add(file.id)
        fileCount += 1
      }
    }

    await handlers.onSession(session)
    importedIds.add(session.id)
  }

  if (
    importedIds.size !== listed.size ||
    [...listed].some((id) => !importedIds.has(id))
  ) {
    fail('session index does not match archive entries')
  }

  return { sessions: importedIds.size, files: fileCount, entryCount: entries.size }
}
