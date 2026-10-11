import * as viewer from './ysm-three-renderer.js';
let current,selected,playing=false,active=true;
function send(type,data={}){parent.postMessage({channel:'nomad-ysm',type,...data},'*')}
function resize(){viewer.setViewportRect(0,0,innerWidth,innerHeight)}
function bytes(png){return Uint8Array.from(atob(png),c=>c.charCodeAt(0))}
function play(){if(playing&&active&&selected)viewer.resumeAnimation();else viewer.pauseAnimation()}
window.addEventListener('message',event=>{if(event.source!==parent||event.data?.channel!=='nomad-ysm')return;const msg=event.data;try{
 if(msg.type==='load'){
  viewer.clearScene();current=msg.payload;const spec=JSON.parse(current.spec);
  spec.models=spec.models.filter(m=>m.defaultVisible);
  if(!spec.models?.length)throw new Error('模型未包含可预览的几何数据');
  const chosen=current.textures.find(t=>t.name===msg.texture||t.name.replace(/\.png$/i,'').split('/').pop()===msg.texture);
  if(chosen)for(const model of spec.models)if(model.defaultVisible)model.textureId=chosen.id;
  viewer.loadModelGeometry(JSON.stringify(spec));
  for(const tex of current.textures)viewer.addTextureData(tex.id,bytes(tex.png));
  for(const text of current.animations)viewer.loadAnimationData(text);const names=new Set(viewer.getAvailableAnimations());
  selected=[...names].find(n=>n===msg.animation)||[...names].find(n=>/^(idle|walk)$|[.]idle$|[.]walk$/.test(n))||[...names].find(n=>n===msg.fallbackAnimation||n.endsWith('.'+msg.fallbackAnimation))||[...names][0];playing=true;if(selected)viewer.playAnimation(selected);play();viewer.resetCamera();send('loaded',{clips:[...names],selected});
 }else if(msg.type==='play'){selected=msg.name;playing=true;viewer.playAnimation(selected);play()}
 else if(msg.type==='pause'){playing=false;play()}
 else if(msg.type==='active'){active=msg.active;play()}
 else if(msg.type==='reset')viewer.resetCamera();
 }catch(error){send('error',{error:String(error.message||error)})}});
try{viewer.init('ysm');viewer.setBackground(3.683,4.265,6.164);resize();new ResizeObserver(resize).observe(document.body);send('ready')}catch(error){send('error',{error:String(error.message||error)})}
window.addEventListener('pagehide',()=>viewer.dispose());
