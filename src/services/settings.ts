import { create } from 'zustand'
import type { TtsVoice } from './api/speech.js'
import type { ChatModel } from './api/types.js'
import { normalizeLocation, type UserLocation } from './location.js'

export type Locale = 'zh-CN' | 'en-US'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

/** 思考强度映射到 Messages API 的 output_config.effort。 */
export type ThinkingEffort = 'low' | 'high' | 'max'

/** DeepSeek 扩展字段 safety_check.level。 */
export type SafetyCheckLevel = 'low' | 'high'

/** 本机设置，存 localStorage：API Key、语言、主题、位置、朗读音色、深度思考与智能搜索开关、侧边栏收起状态、外部存储地址 */
type Settings = {
  apiKey: string | null
  locale: Locale
  themePreference: ThemePreference
  location: UserLocation | null
  ttsVoice: TtsVoice
  thinking: boolean
  search: boolean
  siderCollapsed: boolean
  chatModel: ChatModel
  thinkingEffort: ThinkingEffort
  safetyCheck: SafetyCheckLevel
  withdrawOnRefusal: boolean
  remoteStorageUrl: string
  remoteStorageToken: string
  remotePrefetchCount: number
}

const KEYS = {
  apiKey: 'chat-demo:api-key',
  locale: 'chat-demo:locale',
  location: 'chat-demo:location',
  themePreference: 'chat-demo:theme-preference',
  ttsVoice: 'chat-demo:tts-voice',
  thinking: 'chat-demo:thinking',
  search: 'chat-demo:search',
  siderCollapsed: 'chat-demo:sider-collapsed',
  chatModel: 'chat-demo:chat-model',
  thinkingEffort: 'chat-demo:thinking-effort',
  safetyCheck: 'chat-demo:safety-check',
  withdrawOnRefusal: 'chat-demo:withdraw-on-refusal',
  remoteStorageUrl: 'chat-demo:remote-storage-url',
  remoteStorageToken: 'chat-demo:remote-storage-token',
  remotePrefetchCount: 'chat-demo:remote-prefetch-count',
} as const

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

/** 位置选择模式跟随浏览器语言，与应用内选择的界面语言无关。 */
export const isChineseBrowser = (): boolean =>
  (typeof navigator === 'undefined' ? 'zh' : navigator.language).toLowerCase().startsWith('zh')

const initialLocale = (): Locale => {
  const saved = read(KEYS.locale)
  if (saved === 'zh-CN' || saved === 'en-US') {
    return saved
  }
  return isChineseBrowser() ? 'zh-CN' : 'en-US'
}

const initialLocation = (): UserLocation | null => {
  try {
    const location = normalizeLocation(JSON.parse(read(KEYS.location) ?? 'null'))
    if (!location) {
      return null
    }
    return isChineseBrowser()
      ? location.region === 'CN' && location.province
        ? location
        : null
      : { region: location.region }
  } catch {
    return null
  }
}

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

/** 未保存过时使用服务端默认音色 stella（海星） */
const initialTtsVoice = (): TtsVoice => (read(KEYS.ttsVoice) === 'tide' ? 'tide' : 'stella')

const initialChatModel = (): ChatModel => {
  const saved = read(KEYS.chatModel)
  return saved === 'deepseek-v4-pro' ? 'deepseek-v4-pro' : 'deepseek-flash'
}

const initialThinkingEffort = (): ThinkingEffort => {
  const saved = read(KEYS.thinkingEffort)
  return saved === 'low' || saved === 'max' ? saved : 'high'
}

export const useSettings = create<Settings>(() => ({
  apiKey: read(KEYS.apiKey),
  locale: initialLocale(),
  location: initialLocation(),
  themePreference: initialThemePreference(),
  ttsVoice: initialTtsVoice(),
  thinking: read(KEYS.thinking) === 'true',
  search: read(KEYS.search) === 'true',
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
  chatModel: initialChatModel(),
  thinkingEffort: initialThinkingEffort(),
  safetyCheck: read(KEYS.safetyCheck) === 'low' ? 'low' : 'high',
  withdrawOnRefusal: read(KEYS.withdrawOnRefusal) !== 'false',
  remoteStorageUrl: read(KEYS.remoteStorageUrl) ?? __REMOTE_STORAGE_URL__,
  remoteStorageToken: read(KEYS.remoteStorageToken) ?? '',
  remotePrefetchCount: Number(read(KEYS.remotePrefetchCount) ?? '1'),
}))

export const setLocale = (locale: Locale) => {
  write(KEYS.locale, locale)
  useSettings.setState({ locale })
}

export const setLocation = (value: UserLocation | null) => {
  const location = normalizeLocation(value)
  write(KEYS.location, location ? JSON.stringify(location) : null)
  useSettings.setState({ location })
}

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference)
  useSettings.setState({ themePreference })
}

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  write(KEYS.ttsVoice, ttsVoice)
  useSettings.setState({ ttsVoice })
}

export const setApiKey = (apiKey: string | null) => {
  write(KEYS.apiKey, apiKey)
  useSettings.setState({ apiKey })
}

export const setThinking = (thinking: boolean) => {
  write(KEYS.thinking, String(thinking))
  useSettings.setState({ thinking })
}

export const setSearch = (search: boolean) => {
  write(KEYS.search, String(search))
  useSettings.setState({ search })
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}

export const setRemoteStorage = (url: string, token: string) => {
  const normalizedUrl = url.trim()
  const normalizedToken = token.trim()
  write(KEYS.remoteStorageUrl, normalizedUrl || null)
  write(KEYS.remoteStorageToken, normalizedToken || null)
  useSettings.setState({
    remoteStorageUrl: normalizedUrl,
    remoteStorageToken: normalizedToken,
  })
}

export const setRemotePrefetchCount = (count: number) => {
  const normalized = Number.isFinite(count) ? Math.max(0, Math.min(20, Math.trunc(count))) : 1
  write(KEYS.remotePrefetchCount, String(normalized))
  useSettings.setState({ remotePrefetchCount: normalized })
}

export const setChatModel = (chatModel: ChatModel) => {
  write(KEYS.chatModel, chatModel)
  useSettings.setState({ chatModel })
}

export const setThinkingEffort = (thinkingEffort: ThinkingEffort) => {
  write(KEYS.thinkingEffort, thinkingEffort)
  useSettings.setState({ thinkingEffort })
}

export const setSafetyCheck = (safetyCheck: SafetyCheckLevel) => {
  write(KEYS.safetyCheck, safetyCheck)
  useSettings.setState({ safetyCheck })
}

export const setWithdrawOnRefusal = (withdrawOnRefusal: boolean) => {
  write(KEYS.withdrawOnRefusal, String(withdrawOnRefusal))
  useSettings.setState({ withdrawOnRefusal })
}
