(()=>{'use strict';
const $=id=>document.getElementById(id);
const SLOTS=[['idle','Ожидание'],['attack','Атака'],['hurt','Получение урона'],['phase_change','Смена фазы'],['phase_2','Стойка фазы 2'],['phase_3','Стойка фазы 3'],['death','Смерть']];
const EVENTS=[['spawn','Появление'],['attack','Атака босса'],['hurt','Получение урона'],['phase','Переход фазы'],['idle','Возврат к обычной стойке'],['death','Исчезновение после смерти']];
const EFFECTS=[['none','Без анимации'],['fade','Плавное появление / исчезновение'],['fade-up','Появление снизу'],['crossfade','Перетекание PNG'],['zoom','Приближение'],['zoom-out','Отдаление'],['slide-left','Сдвиг влево'],['slide-right','Сдвиг вправо'],['shake','Тряска'],['pulse','Пульсация'],['blur','Размытие'],['spin','Вращение'],['lunge','Рывок'],['sink','Падение вниз'],['flash','Вспышка'],['wipe','Проявление слева']];
const FALLBACK={spawn:['fade-up',900,30],attack:['lunge',520,35],hurt:['shake',350,25],phase:['pulse',1900,40],idle:['crossfade',250,20],death:['fade',1100,25]};
let models=[],selected='',token='',dirty=false,postTimer=null,previewBusy=false;
const clamp=(v,min,max)=>Math.min(max,Math.max(min,+v||0));
function optionMarkup(list,chosen){return list.map(([value,label])=>`<option value="${value}" ${value===chosen?'selected':''}>${label}</option>`).join('')}
function current(){return models.find(b=>b.id===selected)}
function normalize(b){b.spriteScales=b.spriteScales||{};b.visualTransitions=b.visualTransitions||{};for(const [key] of SLOTS)if(!Number.isFinite(+b.spriteScales[key]))b.spriteScales[key]=100;for(const [key,[effect,durationMs,intensity]] of Object.entries(FALLBACK))b.visualTransitions[key]={effect,durationMs,intensity,...b.visualTransitions[key]};b.deathHoldMs=b.deathHoldMs??1700;return b;}
function slider(label,min,max,value,onChange,suffix='%'){
 const div=document.createElement('div');div.className='visual-slider';
 const top=document.createElement('label');top.textContent=label;
 const output=document.createElement('output');output.textContent=value+suffix;top.append(output);
 const input=document.createElement('input');input.type='range';input.min=min;input.max=max;input.step=5;input.value=value;
 input.oninput=()=>{output.textContent=input.value+suffix;onChange(+input.value)};
 div.append(top,input);return div;
}
function schedule(){dirty=true;$('visualSaveMessage').textContent='Не сохранено — нажми «Применить в эфир»';}
function draw(){const b=current();const parent=$('visualControls');parent.replaceChildren();if(!b)return;
 const title=document.createElement('h3');title.textContent='Размер PNG для каждого состояния';parent.append(title);
 const info=document.createElement('p');info.className='sub';info.textContent='100% — исходный размер. Можно увеличивать и уменьшать конкретный PNG отдельно от общего масштаба сцены.';parent.append(info);
 const scales=document.createElement('div');scales.className='visual-grid';parent.append(scales);
 for(const [slot,label] of SLOTS){const range=slider(label,30,250,b.spriteScales[slot],v=>{b.spriteScales[slot]=v;schedule()},'%');scales.append(range)}
 const h=document.createElement('h3');h.textContent='Переходы и анимации';parent.append(h);
 const desc=document.createElement('p');desc.className='sub';desc.textContent='Выбери эффект переключения PNG, затем настрой длительность и силу. Настройки индивидуальны для этого босса.';parent.append(desc);
 const tabs=document.createElement('div');tabs.className='visual-grid';parent.append(tabs);
 for(const [key,label] of EVENTS){const item=b.visualTransitions[key];const box=document.createElement('div');box.className='visual-transition';
 const l=document.createElement('label');l.textContent=label;const sel=document.createElement('select');sel.innerHTML=optionMarkup(EFFECTS,item.effect);sel.onchange=()=>{item.effect=sel.value;schedule()};box.append(l,sel);
 box.append(slider('Длительность',0,6000,item.durationMs,v=>{item.durationMs=v;schedule()},' мс'));
 box.append(slider('Сила эффекта',0,100,item.intensity,v=>{item.intensity=v;schedule()}));
 const preview=document.createElement('button');preview.textContent='▶ Проверить '+label.toLowerCase();preview.className='visual-test-button';preview.onclick=()=>{previewAction(key)};box.append(preview);tabs.append(box);
 }
 const hold=slider('Сколько показывать PNG смерти до исчезновения',0,10000,b.deathHoldMs,v=>{b.deathHoldMs=v;schedule()},' мс');parent.append(hold);
}
async function reload(){try{const status=await(await fetch('/api/easy/status')).json();token=status.token;
 const result=await(await fetch('/api/easy/boss-visuals',{cache:'no-store'})).json();models=(result.bosses||[]).map(normalize);
 if(!models.some(b=>b.id===selected))selected=models[0]?.id||'';
 $('visualBossSelect').innerHTML=models.map(b=>`<option value="${b.id}">${b.name.replaceAll('&','&amp;').replaceAll('<','&lt;')}</option>`).join('');$('visualBossSelect').value=selected;
 draw();$('visualSaveMessage').textContent='Выбери переход и нажми «Проверить»';dirty=false;
 await initialPreview();
 }catch(e){$('visualSaveMessage').textContent='⚠ '+e.message}}
async function saveVisuals(){const b=current();if(!b)return;const res=await fetch('/api/easy/boss-visuals',{method:'POST',headers:{'Content-Type':'application/json','X-Boss-Studio-Token':token},body:JSON.stringify(b)});const result=await res.json();if(!res.ok||!result.ok)throw Error(result.error||'Не удалось сохранить');
 const idx=models.findIndex(x=>x.id===b.id);models[idx]=normalize(result.boss);dirty=false;$('visualSaveMessage').textContent='✓ Настройки сохранены! OBS обновится автоматически.';
 await updatePreviewConfig();}
async function updatePreviewConfig(){const r=await fetch('/api/live-config',{cache:'no-store'});if(!r.ok)return;const config=await r.json();$('visualPreview').contentWindow?.postMessage({bs41:'config',config},'*');}
function dataFor(action){const b=current(),hp=b?.hp||10000;return{kind:'boss-studio4',action,bossId:b.id,active:action!=='death',maxHp:hp,hp:action==='death'?0:action==='hurt'?Math.round(hp*.8):action==='phase'?Math.round(hp*.6):hp,armor:250,phase:action==='phase'?2:1,damage:340,player:'Тест',leaderboard:[{name:'Зритель',damage:500}]};}
async function initialPreview(){const frame=$('visualPreview');if(!frame.contentWindow||!current())return;await updatePreviewConfig();frame.contentWindow.postMessage({bs41:'battle',data:dataFor('spawn')},'*')}
async function previewAction(action){if(previewBusy||!current())return;previewBusy=true;try{
   // Save first so the embedded overlay uses the exact values shown on the sliders.
   if(dirty)await saveVisuals();
   await updatePreviewConfig();
   const frame=$('visualPreview');const d=dataFor(action);
   frame.contentWindow.postMessage({bs41:'battle',data:d},'*');
   $('visualSaveMessage').textContent='▶ Предпросмотр: '+EVENTS.find(x=>x[0]===action)?.[1];
 }catch(e){$('visualSaveMessage').textContent='⚠ '+e.message}finally{previewBusy=false}}
$('visualBossSelect').onchange=()=>{if(dirty&&!confirm('Несохранённые изменения будут потеряны. Продолжить?')){$('visualBossSelect').value=selected;return;}selected=$('visualBossSelect').value;draw();dirty=false;initialPreview()};
$('saveVisuals').onclick=()=>saveVisuals().catch(e=>$('visualSaveMessage').textContent='⚠ '+e.message);
$('previewSpawn').onclick=()=>previewAction('spawn');
$('previewHurt').onclick=()=>previewAction('hurt');
$('previewPhase').onclick=()=>previewAction('phase');
$('previewDeath').onclick=()=>previewAction('death');
$('visualPreview').addEventListener('load',()=>initialPreview());
reload();
})();
