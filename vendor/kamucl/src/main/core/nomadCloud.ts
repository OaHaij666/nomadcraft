import { getSettings, saveSettings } from './settings'
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

export interface NomadStatus {
  serviceId?: string
  address: string
  connected: boolean
  signedIn: boolean
  username?: string
}
export interface NomadCatalog { instances: unknown[]; fetchedAt: number }
interface NomadConfig { address: string }
let address = ''
let token: string | null = null
let cookie = ''
let username: string | undefined
let serviceId: string | undefined
let localStatusEnricher:(instances:any[],serviceId:string)=>Promise<void>=async()=>{}
export function registerCloudCatalogStatus(enricher:typeof localStatusEnricher){localStatusEnricher=enricher}
function configFile(): string { return path.join(app.getPath('userData'), 'nomadcraft.json') }
function loadConfig(): void {
  if (address) return
  try { address = normalizeAddress((JSON.parse(fs.readFileSync(configFile(), 'utf8')) as Partial<NomadConfig>).address ?? '') } catch { address = '' }
}
function saveConfig(): void {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true })
  fs.writeFileSync(configFile(), JSON.stringify({ address }, null, 2), 'utf8')
}
export function normalizeAddress(input: string): string {
  const value = String(input ?? '').trim()
  if (!value || value.length > 512) throw new Error('请输入 NomadCraft 服务地址')
  const url = new URL(value.endsWith('/') ? value : value + '/')
  const localHttp = url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1')
  if ((url.protocol !== 'https:' && !localHttp) || url.username || url.password || url.search || url.hash) throw new Error('服务地址必须是 HTTPS 根地址；本机调试可使用 HTTP')
  return url.toString().endsWith('/') ? url.toString().slice(0, -1) : url.toString()
}
function endpoint(route: string): string {
  const base = address.endsWith('/') ? address.slice(0, -1) : address
  const suffix = route.startsWith('/') ? route.slice(1) : route
  return base + '/' + suffix
}
function requireAddress(): string { loadConfig(); if (!address) throw new Error('请先填写 NomadCraft 服务地址'); return address }
export async function request(route: string, init: RequestInit = {}): Promise<unknown> {
  requireAddress()
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  headers.set('X-Requested-With', 'XMLHttpRequest')
  if (token) headers.set('Authorization', 'Bearer ' + token)
  if (cookie) headers.set('Cookie', cookie)
  const response = await fetch(endpoint(route), { ...init, headers, signal: AbortSignal.timeout(20000) })
  const getCookies = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie
  const receivedCookies = getCookies ? getCookies.call(response.headers) : []
  if (receivedCookies.length) cookie = receivedCookies.map(value => value.split(';', 1)[0]).join('; ')
  const text = await response.text()
  let body: any = null
  try { body = text ? JSON.parse(text) : null } catch { throw new Error('NomadCraft 返回了无效响应') }
  if (!response.ok || (body && typeof body.status === 'number' && body.status !== 200)) throw new Error(String(body?.data?.message ?? body?.data ?? 'NomadCraft 请求失败（' + response.status + '）'))
  return body?.data ?? body
}
export function status(): NomadStatus { loadConfig(); return { address, connected: !!address, serviceId, signedIn: !!token, ...(username ? { username } : {}) } }
export function webToken(): { address: string; token: string | null } {
  loadConfig()
  return { address, token }
}

export function connect(input: string): NomadStatus { address = normalizeAddress(input); token = null; cookie = ''; username = undefined; serviceId=undefined; saveConfig(); return status() }
export async function login(input: string, user: string, password: string, code = ''): Promise<NomadStatus> {
  connect(input)
  const data = await request('api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: String(user), password: String(password), code: String(code) }) })
  if (data === 'NEED_2FA') throw new Error('此账号需要二步验证码')
  if (typeof data !== 'string' || data.length < 16 || data.length > 256) throw new Error('NomadCraft 登录未返回有效会话')
  token = data; username = String(user);try{serviceId=(await request('api/nomad/distribution/identity') as {serviceId:string}).serviceId}catch{serviceId=undefined} return status()
}
export async function logout(): Promise<NomadStatus> {
  try {
    if (token) await request('api/auth/logout')
  } catch {
    // Local credentials are still cleared when the server is unreachable.
  }
  token = null
  cookie = ''
  username = undefined
  return status()
}
export async function catalog(): Promise<NomadCatalog> {
  if (!token) throw new Error('请先登录 NomadCraft')
  const data = await request('api/nomad/catalog/') as any
  const instances=Array.isArray(data?.instances)?data.instances:[]
  if(serviceId)await localStatusEnricher(instances,serviceId)
  return { ...data, instances, fetchedAt: Date.now() }
}
export interface NomadOfficialInput { version: string; name: string; profile?: unknown; server?: unknown }
export interface NomadSaveInput { name: string; description?: string; rules?: unknown }
export interface NomadRoomInput { name: string; desiredState: 'open' | 'closed' }
export async function createOfficial(input: NomadOfficialInput): Promise<{ id: string }> {
  if (!token) throw new Error('请先登录 NomadCraft')
  return await request('api/nomad/catalog/official', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }) as { id: string }
}
export async function createSave(instanceId: string, input: NomadSaveInput): Promise<unknown> {
  if (!token) throw new Error('请先登录 NomadCraft')
  return await request('api/nomad/catalog/instances/' + encodeURIComponent(instanceId) + '/saves', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
}
export async function room(instanceId: string, saveId: string, input: NomadRoomInput, create = false): Promise<unknown> {
  if (!token) throw new Error('请先登录 NomadCraft')
  const route = 'api/nomad/catalog/instances/' + encodeURIComponent(instanceId) + '/saves/' + encodeURIComponent(saveId) + '/room'
  return await request(route, { method: create ? 'POST' : 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
}


export function storage(): { path: string; valid: boolean } {
  const directory=getSettings().cloudInstanceRoot??''
  try{return{path:directory,valid:!!directory&&fs.statSync(directory).isDirectory()}}catch{return{path:directory,valid:false}}
}
export function setStorage(directory:string):{path:string;valid:boolean}{
  if(typeof directory!=='string'||!path.isAbsolute(directory)||!fs.statSync(directory).isDirectory())throw new Error('请选择存在的本地文件夹')
  fs.accessSync(directory,fs.constants.R_OK|fs.constants.W_OK)
  const resolved=fs.realpathSync(directory);saveSettings({cloudInstanceRoot:resolved});return storage()
}

/** Freeze the accepted service/session across asynchronous transfers. */
export function cloudClient(){requireAddress();if(!token||!serviceId)throw new Error('请登录支持云端分发的 NomadCraft 服务');const origin=address,credential=token,cookies=cookie,identity=serviceId;
 const raw=async(route:string,init:RequestInit & {timeoutMs?:number}={})=>{const {timeoutMs,...requestInit}=init;const headers=new Headers(init.headers);headers.set('Authorization','Bearer '+credential);headers.set('X-Requested-With','XMLHttpRequest');if(cookies)headers.set('Cookie',cookies);const response=await fetch(origin+'/'+route.replace(/^\//,''),{...requestInit,headers,redirect:'error',signal:(AbortSignal as typeof AbortSignal & { any(signals: AbortSignal[]): AbortSignal }).any([init.signal??new AbortController().signal,AbortSignal.timeout(Math.max(1000,Math.min(timeoutMs??60000,300000)))])});if(!response.ok){const text=(await response.text()).slice(0,500);throw new Error('云端请求失败 '+response.status+'：'+text)}return response};
 const json=async(route:string,init:RequestInit & {timeoutMs?:number}={})=>{const response=await raw(route,{...init,headers:{'Content-Type':'application/json',...init.headers}});const body=await response.json();if(body.status&&body.status!==200)throw new Error(String(body.data));return body.data??body};return{origin,serviceId:identity,raw,json};
}
