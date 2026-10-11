<script setup lang="ts">
import { ref } from 'vue'
import { useMotion } from '../motion'
const names = ['BAI_ZHU', 'AeZz', '物晖', '牛肉', '好好', 'hun_Bk', 'J39', '略略略', '鸦猫', 'sheri', '书九叶', 'yansan', '(x_x;)', '小坎坷', 'MuxYang', '八千代', 'Henry', '月を見ていた', 'Hiro', '摇滚高手']
const expanded = ref(false)
const drift = names.map(() => ({ x: (Math.random() * 12 - 6).toFixed(1) + 'px', y: (Math.random() * 8 - 4).toFixed(1) + 'px', duration: (3.8 + Math.random() * 3).toFixed(2) + 's' }))
const { decorativeActive } = useMotion()
function onFocusOut(event: FocusEvent) { if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) expanded.value = false }
</script>
<template>
 <section class="creator-card" :class="{expanded}" data-ui="home:creators" @mouseenter="expanded=true" @mouseleave="expanded=false" @focusin="expanded=true" @focusout="onFocusOut">
  <div data-ui="CreatorCard:3b0bd35ff2cd" class="creator-heading"><button data-ui="CreatorCard:b838c4453411" class="creator-toggle" :aria-expanded="expanded" aria-controls="creator-names" @click="expanded=true">参与测试及创作者<small data-ui="CreatorCard:d9b60520217e" lang="en">TESTERS &amp; CREATORS</small></button><a data-ui="CreatorCard:86b4c178a448" href="https://space.bilibili.com/9596327" target="_blank" rel="noopener noreferrer" class="icon-btn" aria-label="访问卡慕的哔哩哔哩空间">↗</a></div>
  <div class="creator-message">
   <p data-ui="CreatorCard:5031cfb3dd7e" class="creator-intro">好想做卡慕的狗啊，别的狗至少还图口饭，我不一样，我只希望他发视频的时候能允许我在评论区汪两声。卡慕但凡回我一个“？”我都能截图裱起来当传家宝。</p>
   <div :inert="!expanded" id="creator-names" class="creator-name-layer" :class="{moving:decorativeActive && expanded}" data-ui="home:creator-names"><span data-ui="CreatorCard:7cd0fbc9196c" v-for="(name,i) in names" :key="name" class="creator-bubble" :style="{'--delay':i*40+'ms','--drift-x':drift[i].x,'--drift-y':drift[i].y,'--duration':drift[i].duration}"><span data-ui="CreatorCard:587246bec0b9">{{name}}</span></span></div>
  </div>
 </section>
</template>
<style scoped>
.creator-card { min-width:0; overflow:hidden; padding:var(--card-pad); border:1px solid var(--border); border-radius:var(--radius-lg); background:var(--surface-content); }
.creator-heading { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.creator-toggle { color:var(--text); background:none; border:0; padding:0; text-align:left; font-size:14px; font-weight:600; cursor:pointer; }
.creator-toggle small { display:block; font-size:11px; letter-spacing:1px; color:var(--text-dim); margin-top:4px; }
.creator-message { position:relative; min-height:70px; margin-top:12px; }
.creator-intro, .creator-name-layer { position:absolute; inset:0; margin:0; transition:opacity 180ms ease, transform 220ms var(--ease-out); }
.creator-intro { color:var(--text-dim); font-size:12px; line-height:1.7; opacity:1; transform:none; }
.creator-name-layer { display:flex; align-content:flex-start; flex-wrap:wrap; gap:6px; overflow:auto; padding:0 2px 2px; opacity:0; pointer-events:none; contain:layout paint; transform:translateY(4px); }
.creator-card.expanded .creator-intro { opacity:0; transform:translateY(-4px); }
.creator-card.expanded .creator-name-layer { opacity:1; pointer-events:auto; transform:none; }
.creator-bubble { flex:none; font-size:11px; border-radius:999px; background:var(--card-2); color:var(--text); padding:5px 8px; }
.creator-bubble:hover { background:var(--accent-soft); color:var(--accent-2); }
.moving .creator-bubble { animation:reveal 220ms both; animation-delay:var(--delay); }
.moving .creator-bubble span { display:block; animation:drift var(--duration) ease-in-out infinite alternate; animation-delay:var(--delay); }
@keyframes reveal { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:none; } }
@keyframes drift { from { transform:translate(calc(var(--drift-x) * -1),calc(var(--drift-y) * -1)); } to { transform:translate(var(--drift-x),var(--drift-y)); } }
@media (prefers-reduced-motion: reduce) {
 .creator-intro, .creator-name-layer { transition:none; }
 .moving .creator-bubble, .moving .creator-bubble span { animation:none; }
}
</style>
