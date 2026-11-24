import { useSettings } from './settings.js'
import type { Session, SessionSummary } from './chat/types.js'

export type RemoteStorageConfig = {
  url: string
  token: string
}

export type RemoteTombstone = {
  id: string
  deletedAt: number
}

export const getRemoteStorageConfig = (): RemoteStorageConfig => {
  const state = useSettings.getState()
  return {
    url: state.remoteStorageUrl.trim().replace(/\/+$/, ''),
    token: state.remoteStorageToken.trim(),
  }
}

export const isRemoteStorageConfigured = (): boolean => getRemoteStorageConfig().url.length > 0

const remoteFetch = async (path: string, init: RequestInit = {}) => {
  const { url, token } = getRemoteStorageConfig()
  if (!url) {
    throw new Error('external storage is not configured')
  }
  const headers = new Headers(init.headers)
  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
  }
  const response = await fetch(`${url}${path}`, {
    ...init,
    headers,
    cache: 'no-store',
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`external storage ${response.status}: ${text || response.statusText}`)
  }
  return response
}

export const remoteHealth = async (): Promise<boolean> => {
  try {
    const response = await remoteFetch('/health')
    return response.ok
  } catch {
    return false
  }
}

export const remoteListSessions = async (): Promise<SessionSummary[]> => {
  const response = await remoteFetch('/api/sessions')
  const value = (await response.json()) as unknown
  if (!Array.isArray(value)) {
    throw new Error('external storage returned an invalid session list')
  }
  return value as SessionSummary[]
}

export const remoteGetSession = async (id: string): Promise<Session> => {
  const response = await remoteFetch(`/api/sessions/${encodeURIComponent(id)}`)
  return (await response.json()) as Session
}

export const remotePutSession = async (session: Session): Promise<void> => {
  await remoteFetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(session),
  })
}

export const remotePatchSessionTitle = async (id: string, title: string): Promise<void> => {
  await remoteFetch(`/api/sessions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
}

export const remoteDeleteSession = async (id: string): Promise<void> => {
  await remoteFetch(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export const remoteListTombstones = async (): Promise<RemoteTombstone[]> => {
  const response = await remoteFetch('/api/tombstones')
  const value = (await response.json()) as unknown
  if (!Array.isArray(value)) {
    throw new Error('external storage returned invalid tombstones')
  }
  return value as RemoteTombstone[]
}

export const remoteGetFile = async (id: string): Promise<Blob> => {
  const response = await remoteFetch(`/api/files/${encodeURIComponent(id)}`)
  return await response.blob()
}

export const remotePutFile = async (id: string, blob: Blob): Promise<void> => {
  await remoteFetch(`/api/files/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: {
      'Content-Type': blob.type || 'application/octet-stream',
      'X-File-Type': blob.type || 'application/octet-stream',
    },
    body: blob,
  })
}

export const remoteDeleteFile = async (id: string): Promise<void> => {
  await remoteFetch(`/api/files/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export const remoteClearAll = async (): Promise<void> => {
  await remoteFetch('/api/all', { method: 'DELETE' })
}
