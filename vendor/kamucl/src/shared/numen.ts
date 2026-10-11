import type { InstanceTarget } from './instanceCenter'
export type AiProtocol = 'openai' | 'anthropic'
export interface AiSettings { protocol: AiProtocol; baseUrl: string; model: string; persona: string; maxTokens: number; maxTurns: number }
export interface AiSettingsView extends AiSettings { hasApiKey: boolean; persistentSecrets: boolean }
export interface AiSettingsPatch extends AiSettings { apiKey?: string; clearApiKey?: boolean }
export interface NumenTool { name: string; description?: string; inputSchema: Record<string, unknown> }
export interface NumenToolResult { content?: Array<{ type: string; text?: string }>; isError?: boolean }
export interface NumenCompanion { id: string; name: string }
export type NumenPhase = 'disconnected' | 'ready' | 'listening' | 'thinking' | 'acting' | 'stopped' | 'error'
export interface NumenLog { id: number; time: number; kind: 'system' | 'model' | 'tool' | 'game' | 'user' | 'error'; text: string; companion?: string }
export interface NumenSnapshot { target?: InstanceTarget; directory?: string; installed: boolean; mcpEnabled: boolean; quietFallback: boolean; endpoint: string; hasToken: boolean; connected: boolean; companions: NumenCompanion[]; tools: string[]; selectedCompanion?: string; characterId?: string; characterName?: string; phase: NumenPhase; error?: string; logs: NumenLog[]; turns: number; inputTokens: number; outputTokens: number }
export type NumenCommand = 'status' | 'inventory' | 'look' | 'stop' | 'follow' | 'come' | 'gather-wood' | 'gather-stone' | 'protect'
export const AI_DEFAULTS: AiSettings = { protocol: 'openai', baseUrl: 'https://api.openai.com/v1', model: '', persona: '你是一位友善可靠的 Minecraft 陪玩同伴。使用中文交流，优先照顾自己和玩家的安全；行动前先观察，不擅自破坏玩家的建筑。', maxTokens: 4096, maxTurns: 24 }
export const NUMEN_EVENT = 'numen:event'
