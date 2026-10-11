
import type { AiSettings, NumenTool } from '../../../shared/numen'
import { boundedText } from './mcp'
export interface ToolCall { id: string; name: string; arguments: Record<string, unknown> }
export interface BrainMessage { role: 'user' | 'assistant' | 'tool'; text: string; calls?: ToolCall[]; callId?: string; isError?: boolean }
export interface ModelReply { text: string; calls: ToolCall[]; inputTokens: number; outputTokens: number }
export function modelEndpoint(base: string, protocol: AiSettings['protocol']): string {
  const url = new URL(base.trim())
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash) throw new Error('模型地址须使用 HTTPS，本机模型可使用 HTTP；不要在地址里填写密钥')
  const suffix = protocol === 'anthropic' ? '/messages' : '/chat/completions'
  url.pathname = url.pathname.replace(/\/+$/, '')
  if (!url.pathname.endsWith(suffix)) url.pathname += suffix
  return url.toString()
}
export function modelPayload(settings: AiSettings, system: string, history: BrainMessage[], tools: NumenTool[]): unknown {
  if (settings.protocol === 'anthropic') {
    const messages: Array<{ role: string; content: any[] }> = []
    for (const message of history) {
      const role = message.role === 'assistant' ? 'assistant' : 'user'
      const content: any[] = []
      if (message.role === 'tool') content.push({ type: 'tool_result', tool_use_id: message.callId, content: message.text, is_error: message.isError === true })
      else {
        if (message.text) content.push({ type: 'text', text: message.text })
        for (const call of message.calls ?? []) content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments })
        if (!content.length) content.push({ type: 'text', text: '(no text)' })
      }
      if (messages.at(-1)?.role === role) messages.at(-1)!.content.push(...content)
      else messages.push({ role, content })
    }
    return { model: settings.model, max_tokens: settings.maxTokens, system, messages, ...(tools.length ? { tools: tools.map(tool => ({ name: tool.name, description: tool.description ?? '', input_schema: tool.inputSchema })) } : {}) }
  }
  const messages: any[] = [{ role: 'system', content: system }]
  for (const message of history) {
    if (message.role === 'tool') messages.push({ role: 'tool', tool_call_id: message.callId, content: message.text })
    else messages.push({ role: message.role, content: message.text || (message.calls?.length ? null : ''), ...(message.calls?.length ? { tool_calls: message.calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : {}) })
  }
  return { model: settings.model, messages, max_tokens: settings.maxTokens, ...(tools.length ? { tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description ?? '', parameters: tool.inputSchema } })) } : {}) }
}
export function parseModelReply(body: any, protocol: AiSettings['protocol']): ModelReply {
  if (protocol === 'anthropic') {
    if (!Array.isArray(body?.content)) throw new Error('模型没有返回 Anthropic Messages 内容')
    if (body.stop_reason === 'max_tokens') throw new Error('模型输出被截断，请提高单次输出上限')
    return { text: body.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n'), calls: body.content.filter((part: any) => part.type === 'tool_use').map((part: any) => ({ id: part.id, name: part.name, arguments: part.input })), inputTokens: body.usage?.input_tokens ?? 0, outputTokens: body.usage?.output_tokens ?? 0 }
  }
  const choice = body?.choices?.[0]
  if (!choice?.message) throw new Error('模型没有返回 Chat Completions 内容')
  if (choice.finish_reason === 'length') throw new Error('模型输出被截断，请提高单次输出上限')
  return { text: typeof choice.message.content === 'string' ? choice.message.content : '', calls: (choice.message.tool_calls ?? []).map((call: any) => {
    let args: unknown
    try { args = JSON.parse(call.function.arguments) } catch { throw new Error('模型返回了无法解析的工具参数') }
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('模型的工具参数必须是 JSON 对象')
    return { id: call.id, name: call.function.name, arguments: args }
  }), inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0 }
}
export class AiModelClient {
  constructor(readonly settings: AiSettings, private key: string, private transport: typeof fetch = fetch) {}
  async call(system: string, history: BrainMessage[], tools: NumenTool[], signal: AbortSignal): Promise<ModelReply> {
    const response = await this.transport(modelEndpoint(this.settings.baseUrl, this.settings.protocol), { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', ...(this.settings.protocol === 'anthropic' ? { 'x-api-key': this.key, 'anthropic-version': '2023-06-01' } : this.key ? { Authorization: 'Bearer ' + this.key } : {}) }, body: JSON.stringify(modelPayload(this.settings, system, history, tools)), signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]) })
    if (!response.ok) { await response.body?.cancel(); throw new Error('模型服务请求失败（HTTP ' + response.status + '），请检查地址、模型、密钥和余额') }
    const body = JSON.parse(await boundedText(response))
    if (body.error) throw new Error('模型服务返回错误，请检查模型名称和服务配置')
    return parseModelReply(body, this.settings.protocol)
  }
}
