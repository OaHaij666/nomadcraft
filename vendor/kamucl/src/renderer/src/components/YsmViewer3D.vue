<script setup lang="ts">
import { onMounted,onUnmounted,ref,watch } from 'vue'
import { ysmApi } from '../ysmApi'
import { errText } from '../api'
import { useMotion } from '../motion'
const props=withDefaults(defineProps<{assetId?:string;texture?:string;compact?:boolean;paused?:boolean;defaultAnimation?:string}>(),{compact:false,paused:false})
const emit=defineEmits<{loaded:[count:number];error:[message:string];animations:[names:string[]]}>()
const frame=ref<HTMLIFrameElement>(),loading=ref(true),error=ref(''),clips=ref<string[]>([]),selected=ref(''),playing=ref(true)
const {decorativeActive}=useMotion()
const viewerUrl=new URL('./ysmviewer/index.html',document.baseURI).href
let ready=false,closed=false,revision=0,visible=true,observer:IntersectionObserver|undefined,timer:ReturnType<typeof setTimeout>|undefined
function send(type:string,data:Record<string,unknown>={}){frame.value?.contentWindow?.postMessage({channel:'nomad-ysm',type,...data},'*')}
function active(){send('active',{active:visible&&decorativeActive.value&&!props.paused})}
function fail(message:string){clearTimeout(timer);loading.value=false;error.value=message;emit('error',message)}
async function load(){const request=++revision;clearTimeout(timer);error.value='';clips.value=[];loading.value=true;if(!ready)return;if(!props.assetId){fail('请选择本地 YSM 模型');return}
 try{const data=await ysmApi.preview(props.assetId);if(closed||request!==revision)return;if(!data.viewer)throw new Error('模型预览缓存尚未更新');const defaults=props.defaultAnimation?undefined:await ysmApi.defaults();if(closed||request!==revision)return;send('load',{payload:data.viewer,texture:props.texture,animation:props.defaultAnimation||(defaults?.assetId===props.assetId?defaults.animation:undefined),fallbackAnimation:data.defaultAnimation});timer=setTimeout(()=>fail('YSM 模型预览加载超时'),15000)}catch(e){if(!closed&&request===revision)fail(errText(e))}
}
function receive(event:MessageEvent){if(event.source!==frame.value?.contentWindow||event.data?.channel!=='nomad-ysm')return;const msg=event.data;if(msg.type==='ready'){ready=true;void load()}else if(msg.type==='loaded'){clearTimeout(timer);loading.value=false;clips.value=msg.clips;selected.value=msg.selected||'';playing.value=true;active();emit('loaded',clips.value.length);emit('animations',clips.value)}else if(msg.type==='error')fail(msg.error)}
function choose(){playing.value=true;send('play',{name:selected.value})}
function toggle(){playing.value=!playing.value;send(playing.value?'play':'pause',{name:selected.value})}
watch(()=>[props.assetId,props.texture,props.defaultAnimation],()=>void load())
watch([decorativeActive,()=>props.paused],active)
onMounted(()=>{window.addEventListener('message',receive);observer=new IntersectionObserver(entries=>{visible=entries[0]?.isIntersecting??true;active()});if(frame.value)observer.observe(frame.value);timer=setTimeout(()=>{if(!ready)fail('无法启动本地 YSMViewer 预览')},15000)})
onUnmounted(()=>{closed=true;revision++;clearTimeout(timer);observer?.disconnect();window.removeEventListener('message',receive)})
</script>
<template><div class="ysm-viewer" :class="{compact}"><iframe ref="frame" class="ysm-canvas" :src="viewerUrl" title="YSM 模型立体预览" sandbox="allow-scripts allow-same-origin" @error="fail('无法读取本地 YSMViewer 文件')"></iframe><div v-if="loading" class="ysm-overlay">正在读取本地模型…</div><div v-else-if="error" class="ysm-overlay error" role="alert">{{error}}</div><div v-if="!compact&&!loading&&!error" class="ysm-controls"><select v-if="clips.length" v-model="selected" aria-label="YSM 预览动作" @change="choose"><option v-for="clip in clips" :key="clip" :value="clip">{{clip}}</option></select><button v-if="clips.length" :aria-label="playing?'暂停 YSM 动画':'播放 YSM 动画'" @click="toggle">{{playing?'暂停':'播放'}}</button><span v-else>模型未附带动画</span><button aria-label="重置 YSM 视角" @click="send('reset')">复位</button></div></div></template>
<style scoped>.ysm-viewer{width:100%;height:100%;min-height:160px;position:relative;overflow:hidden}.ysm-canvas{position:absolute;left:0;top:0;width:100%;height:calc(100% - 40px);border:0}.compact .ysm-canvas{height:100%}.compact .ysm-canvas{bottom:0}.ysm-canvas :deep(canvas){display:block;width:100%;height:100%;outline:none}.ysm-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:20px;font-size:11px;color:var(--text-dim);line-height:1.8;text-align:center;overflow-wrap:anywhere;background:color-mix(in srgb,var(--card-2) 65%,transparent)}.ysm-overlay.error{color:var(--danger)}.ysm-controls{position:absolute;bottom:6px;left:10px;right:10px;display:flex;align-items:center;gap:6px;height:30px}.ysm-controls select{flex:1;min-width:0;width:0;font-size:10px;padding:6px 5px;border:1px solid var(--border);background:var(--card-2);border-radius:7px;color:var(--text)}.ysm-controls button{padding:6px 8px;border:1px solid var(--border);background:var(--card-2);border-radius:7px;color:var(--text);font:inherit;font-size:10px;cursor:pointer;white-space:nowrap}.ysm-controls span{font-size:10px;color:var(--text-dim);flex:1}</style>
