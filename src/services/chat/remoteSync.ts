import * as remote from '../remoteStorage.js'
import * as db from './db.js'
import type { Session, SessionSummary } from './types.js'

const fileIdsOf = (session: Session): string[] => {
  const ids = new Set<string>()
  for (const message of session.messages) {
    if (message.role !== 'user') {
      continue
    }
    for (const file of message.files) {
      ids.add(file.id)
    }
  }
  return [...ids]
}

const loadSessionFiles = async (session: Session): Promise<db.StoredFile[]> => {
  const files: db.StoredFile[] = []
  for (const id of fileIdsOf(session)) {
    const blob = await db.loadFile(id)
    if (blob) {
      files.push({ id, blob })
    }
  }
  return files
}

const uploadedFileIds = new Set<string>()
let uploadedCacheKey = ''

const ensureUploadCache = () => {
  const { url, token } = remote.getRemoteStorageConfig()
  const key = `${url}\n${token}`
  if (key !== uploadedCacheKey) {
    uploadedFileIds.clear()
    uploadedCacheKey = key
  }
}

const pushSessionRecord = async (session: Session, files: db.StoredFile[]): Promise<void> => {
  ensureUploadCache()
  await remote.remotePutSession(session)
  for (const file of files) {
    if (uploadedFileIds.has(file.id)) {
      continue
    }
    await remote.remotePutFile(file.id, file.blob)
    uploadedFileIds.add(file.id)
  }
}

/** 把单个会话和它的本地附件镜像到外部服务器。 */
export const pushSession = async (
  session: Session,
  files: db.StoredFile[] = []
): Promise<void> => {
  if (!remote.isRemoteStorageConfigured()) {
    return
  }
  await pushSessionRecord(session, files)
}

/** 从本地 IndexedDB 读取会话与附件后推送；用于初始化与手动同步。 */
export const pushSessionById = async (id: string): Promise<void> => {
  if (!remote.isRemoteStorageConfigured()) {
    return
  }
  const session = await db.loadSession(id)
  if (!session) {
    return
  }
  await pushSessionRecord(session, await loadSessionFiles(session))
}

export const pushSessionTitle = async (id: string, title: string): Promise<void> => {
  if (!remote.isRemoteStorageConfigured()) {
    return
  }
  await remote.remotePatchSessionTitle(id, title)
}

export const deleteSession = async (id: string): Promise<void> => {
  if (!remote.isRemoteStorageConfigured()) {
    return
  }
  await remote.remoteDeleteSession(id)
}

/**
 * 双向合并：先拉取远端较新的会话和墓碑，再把本地较新或远端缺失的会话推上去。
 * 冲突策略是按会话 updatedAt 的 last-write-wins。
 */
export const pullIntoLocal = async (): Promise<void> => {
  if (!remote.isRemoteStorageConfigured()) {
    return
  }

  const [remoteSummaries, tombstones, localSummaries] = await Promise.all([
    remote.remoteListSessions(),
    remote.remoteListTombstones(),
    db.loadSessionSummaries(),
  ])

  const localById = new Map<string, SessionSummary>(localSummaries.map((item) => [item.id, item]))
  const remoteById = new Map<string, SessionSummary>(remoteSummaries.map((item) => [item.id, item]))

  for (const tombstone of tombstones) {
    const local = localById.get(tombstone.id)
    if (local && tombstone.deletedAt >= local.updatedAt) {
      await db.deleteSession(tombstone.id)
      localById.delete(tombstone.id)
    }
  }

  for (const remoteSummary of remoteSummaries) {
    const local = localById.get(remoteSummary.id)
    if (local && remoteSummary.updatedAt <= local.updatedAt) {
      continue
    }
    try {
      const session = await remote.remoteGetSession(remoteSummary.id)
      const files: db.StoredFile[] = []
      for (const id of fileIdsOf(session)) {
        try {
          const blob = await remote.remoteGetFile(id)
          if (blob.size > 0) {
            files.push({ id, blob })
          }
        } catch {
          // A missing remote blob must not block the rest of the session.
        }
      }
      await db.saveSession(session, files)
      localById.set(session.id, remoteSummary)
    } catch (error) {
      // Keep the local copy if one session cannot be downloaded.
      db.reportStorageError('pull remote session')(error)
    }
  }

  for (const local of localById.values()) {
    const remoteSummary = remoteById.get(local.id)
    if (remoteSummary && remoteSummary.updatedAt >= local.updatedAt) {
      continue
    }
    try {
      const session = await db.loadSession(local.id)
      if (!session) {
        continue
      }
      await pushSessionRecord(session, await loadSessionFiles(session))
    } catch (error) {
      db.reportStorageError('push local session')(error)
    }
  }
}

/**
 * 用于导入/清空后的整库替换：让远端严格镜像当前本地数据。
 * 会先清空远端会话、附件和墓碑，再逐条上传。
 */
export const replaceRemoteWithLocal = async (): Promise<void> => {
  if (!remote.isRemoteStorageConfigured()) {
    return
  }
  await remote.remoteClearAll()
  ensureUploadCache()
  uploadedFileIds.clear()
  const summaries = await db.loadSessionSummaries()
  for (const summary of summaries) {
    const session = await db.loadSession(summary.id)
    if (!session) {
      continue
    }
    await pushSessionRecord(session, await loadSessionFiles(session))
  }
}
