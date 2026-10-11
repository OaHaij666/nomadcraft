import type { NumenCompanion, NumenTool, NumenToolResult } from '../../../shared/numen'

export function localMcpEndpoint(input: string): string {
  const url = new URL(input)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/mcp') throw new Error('Numen 连接地址必须是本机 HTTP /mcp 端点')
  return url.toString()
}
export async function boundedText(response: Response, limit = 4 * 1024 * 1024): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const parts: Uint8Array[] = []; let size = 0
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break
      size += chunk.value.length
      if (size > limit) throw new Error('响应内容超过大小限制')
      parts.push(chunk.value)
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error }
  finally { reader.releaseLock() }
  return Buffer.concat(parts).toString('utf8')
}
export function resultText(result: NumenToolResult): string {
  return (result.content ?? []).filter(part => part.type === 'text').map(part => part.text ?? '').join('\n')
}
export function parseCompanions(text: string): NumenCompanion[] {
  return [...text.matchAll(/^- (\S+)\s+\(id:\s*([^)]+)\)/gm)].map(match => ({ name: match[1], id: match[2].trim() }))
}
export class NumenMcpClient {
  private nextId = 0
  instructions = ''
  tools: NumenTool[] = []
  constructor(readonly endpoint: string, private token: string, private transport: typeof fetch = fetch) { localMcpEndpoint(endpoint) }
  private async rpc(method: string, params: unknown, signal?: AbortSignal, timeout = 15000): Promise<any> {
    const id = ++this.nextId
    const response = await this.transport(this.endpoint, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(this.token ? { Authorization: 'Bearer ' + this.token } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) })
    if (!response.ok) { await response.body?.cancel(); throw new Error(response.status === 401 || response.status === 403 ? 'Numen 令牌不正确，请重新读取游戏配置' : 'Numen MCP 请求失败（HTTP ' + response.status + '）') }
    const text = await boundedText(response)
    let body: any
    try {
      if (response.headers.get('content-type')?.includes('text/event-stream')) {
        body = text.split(/\r?\n\r?\n/).map(event => event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')).filter(Boolean).map(value => JSON.parse(value)).find(value => value.id === id)
      } else body = JSON.parse(text)
    } catch { throw new Error('Numen MCP 返回了无效的 JSON 响应') }
    if (!body || body.id !== id || body.jsonrpc !== '2.0') throw new Error('Numen MCP 响应编号不匹配')
    if (body.error) throw new Error('Numen MCP：' + String(body.error.message ?? body.error.code))
    return body.result
  }
  async initialize(signal?: AbortSignal): Promise<void> {
    const result = await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'KAMUCL NC / Numen Harness', version: '0.1.0' } }, signal)
    if (result?.serverInfo?.name !== 'numen-mcp') throw new Error('此端点不是 Numen MCP 服务')
    this.instructions = String(result.instructions ?? '')
    const response = await this.transport(this.endpoint, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: 'Bearer ' + this.token } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) })
    await response.body?.cancel()
    if (!response.ok) throw new Error('Numen MCP 握手通知失败')
    const listed = await this.rpc('tools/list', {}, signal)
    if (!Array.isArray(listed?.tools) || listed.tools.length > 512) throw new Error('Numen 没有返回有效的工具列表')
    this.tools = listed.tools.filter((tool: NumenTool) => typeof tool.name === 'string' && tool.inputSchema && typeof tool.inputSchema === 'object')
    for (const name of ['list_companions', 'get_events', 'say', 'lua']) if (!this.tools.some(tool => tool.name === name)) throw new Error('当前 Numen 版本未提供工具 ' + name + '，请检查版本和隐藏工具设置')
  }
  async call(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<NumenToolResult> {
    if (!this.tools.some(tool => tool.name === name)) throw new Error('Numen 未提供工具：' + name)
    const result = await this.rpc('tools/call', { name, arguments: args }, signal, name === 'get_events' ? 65000 : 330000)
    if (!result || !Array.isArray(result.content)) throw new Error('Numen 工具未返回有效结果')
    return result
  }
  async companions(signal?: AbortSignal): Promise<NumenCompanion[]> {
    const result = await this.call('list_companions', {}, signal)
    if (result.isError) throw new Error(resultText(result))
    return parseCompanions(resultText(result))
  }
  scriptArgs(code: string, companion: string): Record<string, unknown> {
    const schema = this.tools.find(tool => tool.name === 'lua')?.inputSchema
    const properties = schema?.properties as Record<string, unknown> | undefined
    const key = ['code', 'script', 'program'].find(candidate => properties && candidate in properties)
    if (!key) throw new Error('当前 Numen Lua 工具的参数格式不受支持')
    return { companion, [key]: code }
  }
}
