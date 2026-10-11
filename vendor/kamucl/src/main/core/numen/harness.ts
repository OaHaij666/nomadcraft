
/**
 * SPDX-License-Identifier: LGPL-3.0-only
 * TypeScript adaptation of Dwinovo/minecraft-numen's AgentLoop (revision
 * 2df6979ec33ae45edd623c512ee6644dd94ef11a), with the external-MCP body transport.
 * Retains the event inbox -> model -> serial tools -> receipt -> model loop,
 * wake-on-owner-input, idle hold, cancellation and bounded context compaction.
 * Minecraft tick/instinct/task arbitration remain in the original Numen mod.
 */
import { setTimeout as delay } from 'node:timers/promises'
import type { AiSettings, NumenPhase, NumenTool, NumenToolResult } from '../../../shared/numen'
import type { AiModelClient, BrainMessage, ModelReply } from './model'
import type { NumenMcpClient } from './mcp'
import { resultText } from './mcp'
import { UPSTREAM_OPERATING_PROMPT, UPSTREAM_SPEAKING } from './prompt'
import type { CharacterCard } from '../../../shared/characterCard'
import { personaSection } from './characterPrompt'
export interface HarnessHost {
  log(kind: 'system' | 'model' | 'tool' | 'user' | 'error', text: string): void
  phase(phase: NumenPhase): void
  usage(reply: ModelReply): void
  save(history: BrainMessage[]): void
}
export const HARNESS_RULES = [
  'You are the brain of exactly the selected Numen companion. All tool calls are scoped to that companion.',
  'The launcher receives get_events continuously and injects game chat and world events into your inbox. Do not poll them yourself.',
  'Use the actual tool descriptions and numen.api.help through lua. Never invent APIs. Perceive before and after acting; inspect receipts and adapt to failures.',
  'One body, one active job. Execute actions serially. Body instincts and game permissions are enforced by the mod; do not bypass them.',
  'Use say to talk in-game. A final text answer is also spoken if you have not already used say in that turn.',
  'Do not dismiss or create other companions. Use todo for multi-step plans and memory for durable in-game notes.',
  'Local filesystem commands are unavailable. Lua executes only inside the Numen game sandbox.'
].join('\n')
export function harnessTools(tools: NumenTool[]): NumenTool[] {
  return tools.filter(tool => !['list_companions','create_companion','delete_companion','get_events'].includes(tool.name)).map(tool => {
    const schema = structuredClone(tool.inputSchema)
    const properties = schema.properties as Record<string, unknown> | undefined
    if (properties) delete properties.companion
    if (Array.isArray(schema.required)) schema.required = schema.required.filter(key => key !== 'companion')
    return { ...tool, inputSchema: schema }
  })
}
/** Settle interrupted tool calls before replay; never invent a successful receipt. */
export function settleHistory(history: BrainMessage[]): BrainMessage[] {
  const output: BrainMessage[] = []
  for (let i = 0; i < history.length; i++) {
    const message = history[i]
    if (message.role === 'tool') continue
    output.push(structuredClone(message))
    if (message.role === 'assistant' && message.calls?.length) {
      const receipts = new Map<string, BrainMessage>()
      while (history[i+1]?.role === 'tool') { const result=history[++i]; if(result.callId)receipts.set(result.callId,result) }
      for (const call of message.calls) output.push(structuredClone(receipts.get(call.id) ?? { role: 'tool', callId: call.id, isError: true, text: 'The launcher interrupted this call. The game may have performed some actions; outcome is unknown. Inspect the current body/world state before continuing.' }))
    }
  }
  return output
}
/** Uses Numen's persona-first composition followed by body/tool and speaking rules. */
export function composeHarnessPrompt(personaSection:string,instructions:string,companion:string):string {
  return [personaSection,UPSTREAM_OPERATING_PROMPT,instructions,HARNESS_RULES,'Selected companion: '+companion,UPSTREAM_SPEAKING].filter(Boolean).join('\n\n')
}
export class NumenHarness {
  private controller = new AbortController()
  private inbox: string[] = []
  private wake: (() => void) | undefined
  private running: Promise<void> | undefined
  private poller: Promise<void> | undefined
  private stopped = false
  readonly history: BrainMessage[]
  constructor(private mcp: NumenMcpClient, private model: Pick<AiModelClient, 'call'>, private companion: string, private settings: AiSettings, private host: HarnessHost, history: BrainMessage[] = [], private character?: CharacterCard) { this.history = settleHistory(history) }
  start(): void {
    if (this.running) throw new Error('该同伴的 AI 已在运行')
    this.host.log('system', '启动器 Harness 已接管；等待任务或游戏内消息。')
    this.poller = this.pollEvents()
    this.running = this.pump()
  }
  enqueue(text: string): void {
    if (this.controller.signal.aborted) throw new Error('AI 已停止，请重新开始陪玩')
    if (this.inbox.length >= 80) throw new Error('待处理消息过多，请稍后再发')
    this.inbox.push(text.slice(0,16000)); this.wake?.(); this.wake = undefined
  }
  send(text: string): void { this.host.log('user', text); this.enqueue(text) }
  async stop(): Promise<void> {
    this.stopped = true; this.controller.abort(); this.wake?.(); this.wake = undefined
    await Promise.allSettled([this.running, this.poller])
    this.checkpoint(); this.host.phase('stopped')
  }
  private checkpoint(): void {
    if (this.inbox.length) this.history.push(...this.inbox.splice(0).map(text=>({role:'user' as const,text})))
    this.history.splice(0,this.history.length,...settleHistory(this.history))
    this.host.save(this.history)
  }
  private fail(error: unknown): void {
    if (this.controller.signal.aborted) return
    this.host.log('error', error instanceof Error ? error.message : String(error))
    this.host.phase('error'); this.controller.abort(); this.wake?.(); this.wake = undefined
  }
  private async pollEvents(): Promise<void> {
    try {
      while (!this.controller.signal.aborted) {
        const start = Date.now()
        const result = await this.mcp.call('get_events', { companion: this.companion, wait_seconds: 2 }, this.controller.signal)
        if (result.isError) throw new Error(resultText(result))
        const text = resultText(result).trim()
        // The upstream empty receipt is '(no events)'; it must not spend a model turn.
        if (text && !/^(\(no (?:new )?events(?:[^)]*)\)|no events\.?|\[\])$/i.test(text)) {
          this.host.log('system', '收到游戏事件：' + text.slice(0,1500)); this.enqueue('<game_events>\n' + text + '\n</game_events>')
        }
        if (Date.now()-start < 500) await delay(500-(Date.now()-start), undefined, { signal: this.controller.signal })
      }
    } catch (error) { this.fail(error) }
  }
  private async compact(): Promise<void> {
    if (JSON.stringify(this.history).length < 100000) return
    this.host.log('system', '整理对话上下文，保留目标、行动结果和未完成事项。')
    const summary = await this.model.call('Summarize this Minecraft companion session. Preserve owner requests, completed actions, failures, coordinates, current task and unresolved obligations. Do not take actions.', [{ role: 'user', text: JSON.stringify(this.history).slice(-200000) }], [], this.controller.signal)
    if (!summary.text) throw new Error('模型未返回上下文摘要，已暂停以保留原记录')
    this.host.usage(summary)
    this.history.splice(0, this.history.length, { role: 'user', text: '<previous_session_summary>\n' + summary.text + '\n</previous_session_summary>' })
    this.host.save(this.history)
  }
  private async pump(): Promise<void> {
    const signal = this.controller.signal
    const tools = harnessTools(this.mcp.tools)
    try {
      while (!signal.aborted) {
        if (!this.inbox.length) {
          this.host.phase('listening')
          await new Promise<void>(resolve => { this.wake = resolve; if (signal.aborted || this.inbox.length) { this.wake = undefined; resolve() } })
          if (signal.aborted) break
        }
        await this.compact()
        this.history.push(...this.inbox.splice(0).map(text => ({ role: 'user' as const, text })))
        let complete = false
        for (let turn = 0; turn < this.settings.maxTurns; turn++) {
          signal.throwIfAborted()
          this.host.phase('thinking'); this.host.log('model', '正在调用模型 · 工具轮次 ' + (turn+1))
          const system=composeHarnessPrompt(personaSection(this.character?.text,this.settings.persona),this.mcp.instructions,this.companion)
          const reply = await this.model.call(system, this.history, tools, signal)
          signal.throwIfAborted(); this.host.usage(reply)
          if (reply.calls.length > 32 || reply.calls.some(call => !call.id || !call.name || !call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) || new Set(reply.calls.map(call=>call.id)).size !== reply.calls.length) throw new Error('模型返回了无效的工具调用')
          this.history.push({ role: 'assistant', text: reply.text, ...(reply.calls.length ? { calls: reply.calls } : {}) })
          if (reply.text) this.host.log('model', reply.text)
          let spoke = false
          for (const call of reply.calls) {
            signal.throwIfAborted(); this.host.phase('acting')
            const permitted = tools.some(tool => tool.name === call.name)
            let result: NumenToolResult
            if (!permitted) result = { isError: true, content: [{ type: 'text', text: 'Tool is not exposed to this companion harness: ' + call.name }] }
            else {
              const args = { ...call.arguments, companion: this.companion }
              this.host.log('tool', '→ ' + call.name + ' ' + JSON.stringify(args).slice(0,6000))
              result = await this.mcp.call(call.name, args, signal)
              if (call.name === 'say' && !result.isError) spoke = true
            }
            const text = resultText(result).slice(0,24000)
            this.host.log(result.isError ? 'error' : 'tool', '← ' + call.name + '\n' + text)
            this.history.push({ role: 'tool', text, callId: call.id, isError: result.isError })
          }
          this.host.save(this.history)
          if (!reply.calls.length) {
            if (reply.text && !spoke) {
              const said = await this.mcp.call('say', { companion: this.companion, text: reply.text.slice(0,4000) }, signal)
              if (said.isError) throw new Error(resultText(said))
            }
            complete = true; break
          }
          if (this.inbox.length) this.history.push(...this.inbox.splice(0).map(text=>({role:'user' as const,text})))
        }
        if (!complete) throw new Error('已达到本次任务的工具轮次上限。AI 已暂停，检查日志后再继续。')
        this.host.save(this.history)
      }
    } catch (error) { this.fail(error) }
    finally { if (!this.stopped) this.checkpoint() }
  }
}
