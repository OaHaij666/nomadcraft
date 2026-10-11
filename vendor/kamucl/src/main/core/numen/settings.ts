
import fs from 'node:fs'
import path from 'node:path'
import { app, safeStorage } from 'electron'
import { protectedCredentialStorage } from '../credentialProtection'
import { AI_DEFAULTS, type AiSettings, type AiSettingsPatch, type AiSettingsView } from '../../../shared/numen'
import { modelEndpoint } from './model'
let sessionKey: string | undefined
function file(): string { return path.join(app.getPath('userData'), 'ai-companion.json') }
function stored(): AiSettings & { encryptedApiKey?: string } {
  if (!fs.existsSync(file())) return { ...AI_DEFAULTS }
  const raw = JSON.parse(fs.readFileSync(file(),'utf8'))
  return { ...AI_DEFAULTS, ...raw }
}
export function aiCredentials(): { settings: AiSettings; key: string } {
  const raw = stored(); let key = sessionKey ?? ''
  if (sessionKey === undefined && raw.encryptedApiKey) {
    if (!protectedCredentialStorage(safeStorage)) throw new Error('系统凭据保护当前不可用，请重新填写 API Key（仅本次会话使用）')
    try { key = safeStorage.decryptString(Buffer.from(raw.encryptedApiKey,'base64')); sessionKey = key } catch { throw new Error('无法解密已保存的 API Key，请重新填写') }
  }
  const { encryptedApiKey: _key, ...settings } = raw
  return { settings, key }
}
export function aiSettings(): AiSettingsView {
  const { encryptedApiKey, ...settings } = stored()
  return { ...settings, hasApiKey: sessionKey !== undefined ? !!sessionKey : !!encryptedApiKey, persistentSecrets: protectedCredentialStorage(safeStorage) }
}
export function saveAiSettings(input: AiSettingsPatch): AiSettingsView {
  if (!input || !['openai','anthropic'].includes(input.protocol) || typeof input.baseUrl !== 'string' || typeof input.model !== 'string' || typeof input.persona !== 'string') throw new Error('AI 配置格式无效')
  modelEndpoint(input.baseUrl,input.protocol)
  if (input.model.length > 200 || input.persona.length > 12000 || !Number.isInteger(input.maxTokens) || input.maxTokens < 256 || input.maxTokens > 32768 || !Number.isInteger(input.maxTurns) || input.maxTurns < 1 || input.maxTurns > 100) throw new Error('请检查模型名称、输出上限（256–32768）与工具轮次（1–100）')
  const next: ReturnType<typeof stored> = { protocol: input.protocol, baseUrl: input.baseUrl.trim(), model: input.model.trim(), persona: input.persona, maxTokens: input.maxTokens, maxTurns: input.maxTurns }
  const old = stored()
  next.encryptedApiKey = old.encryptedApiKey
  if (input.clearApiKey) { sessionKey = ''; delete next.encryptedApiKey }
  else if (input.apiKey !== undefined) {
    if (typeof input.apiKey !== 'string' || input.apiKey.length > 8192 || /[\r\n]/.test(input.apiKey)) throw new Error('API Key 格式无效')
    sessionKey = input.apiKey.trim()
    if (protectedCredentialStorage(safeStorage)) next.encryptedApiKey = safeStorage.encryptString(sessionKey).toString('base64')
    else delete next.encryptedApiKey
  }
  fs.mkdirSync(path.dirname(file()),{recursive:true})
  const temp = file()+'.tmp'; fs.writeFileSync(temp,JSON.stringify(next,null,2),{mode:0o600}); fs.renameSync(temp,file())
  return aiSettings()
}
export function redactAiText(text: unknown, secrets: string[] = []): string {
  let value = String(text)
  for (const secret of secrets) if (secret) value = value.replaceAll(secret,'[已隐藏]')
  return value.replace(/\bBearer\s+[^\s"']+/gi,'Bearer [已隐藏]').replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|numen-[A-Za-z0-9_-]{8,})/g,'[已隐藏]')
}
