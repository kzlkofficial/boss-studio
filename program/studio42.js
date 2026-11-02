(()=>{'use strict';
const $=id=>document.getElementById(id),defaultCfg=window.BOSS_STUDIO_4_CONFIG;let cfg,chosen,sim=null,simReady=false,animReady=false,visible='bosses',db=null;const exportIds=new Set();const urls=new Map(),iframeUrls=new Map();let animRequest=0;const slotTitles={idle:'Ожидание',attack:'Атака',hurt:'Получение урона',phase_change:'Смена фазы',phase_2:'Фаза 2',phase_3:'Фаза 3',death:'Смерть'},evtNames={hit:'!удар',magic:'!магия',guard:'!щит',follow:'Новый фоллов',bits:'Bits / Cheer',donation:'Донат',sub:'Подписка',resub:'Продление',giftsub:'Подарок',reward:'Баллы канала'},eventParams={followDamage:'Урон за новый фоллов',bitsDamagePerBit:'Урон за 1 Bit',bitsDamageCap:'Макс. Bits за событие',subDamage:'Урон за подписку',resubDamage:'Урон за продление',giftSubDamage:'Урон за подарок',giftSubCap:'Лимит подарков',donationDamagePerUnit:'Урон за единицу доната',donationAmountCap:'Лимит суммы доната',rewardDamage:'Урон за награду'},econParams={spawnChance:'Вероятность спавна, %',hitDamage:'Базовый удар',magicDamage:'Магия — урон',hitCooldownSec:'Перезарядка удара, сек',magicCooldownSec:'Перезарядка магии, сек',guardCooldownSec:'Перезарядка щита, сек',phase2Percent:'Фаза 2, % HP',phase3Percent:'Фаза 3, % HP',phase2Armor:'Броня фазы 2',phase3Armor:'Броня фазы 3',guardRequired:'Щитов против проклятия',guardHealPercent:'Лечение при провале, %',guardDurationSec:'Время защиты, сек'};
function clone(x){return JSON.parse(JSON.stringify(x));}function esc(x){return String(x??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));}
function notice(t,bad=false){$('saveStatus').textContent=t;$('saveStatus').className='status '+(bad?'errmsg':'good');}
const DEFAULT_ANIM={spawnFadeMs:900,spawnRisePx:14,hurtMs:350,phaseMs:1900,deathHoldMs:1700,deathFadeMs:1100};
const animationFields={spawnFadeMs:['Плавное появление (fade-in)',0,3000,100,'мс'],spawnRisePx:['Смещение при появлении',0,120,5,'px'],hurtMs:['Реакция на урон',100,1500,50,'мс'],phaseMs:['Анимация смены фазы',300,5000,100,'мс'],deathHoldMs:['Показ PNG смерти перед исчезновением',0,6000,100,'мс'],deathFadeMs:['Плавное исчезновение (fade-out)',0,4000,100,'мс']};
function normalizeAnim(b){b.animations=b.animations||{};for(const [k,def] of Object.entries(DEFAULT_ANIM)){const v=Number(b.animations[k]);b.animations[k]=Number.isFinite(v)?Math.min(animationFields[k][2],Math.max(animationFields[k][1],v)):def;}}
function cleanCfg(x){if(!x||!Array.isArray(x.bosses)||!x.economy)throw Error('Некорректная база боссов');x.version=4;x.websocketUrl=x.websocketUrl||'ws://127.0.0.1:8080/';for(const [k,v] of Object.entries(defaultCfg.economy))if(x.economy[k]===undefined)x.economy[k]=v;for(const key of Object.keys(x.economy))if(!(key in defaultCfg.economy))delete x.economy[key];delete x.items;if(Array.isArray(x.bonuses))x.bonuses=x.bonuses.filter(b=>b.effect!=='souls');x.schedule=x.schedule||clone(defaultCfg.schedule);x.schedule.queue=x.schedule.queue?.length?x.schedule.queue:[{kind:'random'}];for(const b of x.bosses){b.name=String(b.name||'Босс').trim().slice(0,32);b.sprites=b.sprites||{};delete b.loot;b.trophy=b.trophy||{name:'Трофей '+b.name,image:'',memcoins:100};delete b.trophy.required;if(b.trophy.memcoins===0)b.trophy.memcoins=1;normalizeAnim(b);}return x;}
try{cfg=cleanCfg(JSON.parse((localStorage.getItem('bs42_config')||localStorage.getItem('bs41_config')))||clone(defaultCfg));}catch{cfg=clone(defaultCfg);}chosen=cfg.bosses[0]?.id||null;try{const ids=JSON.parse(localStorage.getItem('bs43_export_ids'));if(Array.isArray(ids))ids.forEach(id=>{if(cfg.bosses.some(b=>b.id===id))exportIds.add(id)});else cfg.bosses.forEach(b=>exportIds.add(b.id));}catch{cfg.bosses.forEach(b=>exportIds.add(b.id));}
function save(){try{localStorage.setItem('bs42_config',JSON.stringify(cfg));notice('● Автосохранение включено');}catch{notice('⚠ Браузер не сохранил базу: экспортируй ZIP',true);}}
function openDb(){return new Promise((resolve,reject)=>{try{const req=indexedDB.open('BossStudio41Media',1);req.onupgradeneeded=()=>req.result.createObjectStore('media',{keyPath:'path'});req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);}catch(e){reject(e);}})}
const volatileMedia=new Map();
const media={async put(path,bytes,mime){const record={path,bytes:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),mime};if(!db){volatileMedia.set(path,record);return;}return new Promise((resolve,reject)=>{const tx=db.transaction('media','readwrite');tx.objectStore('media').put(record);tx.oncomplete=resolve;tx.onerror=()=>{volatileMedia.set(path,record);resolve();notice('⚠ Файл сохранён временно. Скачай ZIP!',true);};});},async get(path){if(volatileMedia.has(path))return volatileMedia.get(path);if(!db)return null;return new Promise((resolve,reject)=>{const tx=db.transaction('media','readonly'),q=tx.objectStore('media').get(path);q.onsuccess=()=>resolve(q.result||null);q.onerror=()=>resolve(null);});}};
function bundled(path){let s=window.BS_BUNDLED_ASSETS?.[path];if(!s)return null;const b=atob(s),a=new Uint8Array(b.length);for(let i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return a;}
async function previewSrc(path){if(!path)return '';if(urls.has(path))return urls.get(path);let entry=await media.get(path);if(!entry&&window.BS_BUNDLED_ASSETS?.[path])return 'data:'+(path.endsWith('.gif')?'image/gif':'image/png')+';base64,'+window.BS_BUNDLED_ASSETS[path];if(!entry)return '';const url=URL.createObjectURL(new Blob([entry.bytes],{type:entry.mime}));urls.set(path,url);return url;}
// A relative assets/... path works in an exported OBS project, but not for
// uploads stored only in IndexedDB. Preview frames must receive embedded URLs.
// Data URLs also work across opaque file:// iframe origins where blob: URLs
// created in the parent document can be blocked by storage partitioning.
async function previewIframeSrc(path){
 if(!path)return '';
 if(iframeUrls.has(path))return iframeUrls.get(path);
 const mime=path.toLowerCase().endsWith('.gif')?'image/gif':'image/png';
 let result='';
 const entry=await media.get(path);
 if(!entry&&window.BS_BUNDLED_ASSETS?.[path]){
  result='data:'+mime+';base64,'+window.BS_BUNDLED_ASSETS[path];
 }else{
  if(!entry)return '';
  const blob=new Blob([entry.bytes],{type:entry.mime||mime});
  result=await new Promise((resolve,reject)=>{
   const reader=new FileReader();reader.onerror=()=>reject(reader.error||new Error('Не удалось загрузить изображение'));
   reader.onload=()=>resolve(String(reader.result||''));reader.readAsDataURL(blob);
  });
 }
 // Keep only a few recently used custom images to avoid retaining hundreds of
 // 25-MB image strings if the editor has a large collection of bosses.
 iframeUrls.set(path,result);
 if(iframeUrls.size>14)iframeUrls.delete(iframeUrls.keys().next().value);
 return result;
}
async function frameSprites(b){
 const overrides={};
 for(const path of new Set([...Object.values(b?.sprites||{}),b?.trophy?.image].filter(Boolean))){
  const image=await previewIframeSrc(path);
  if(image)overrides[path]=image;
 }
 return overrides;
}
const validId=s=>/^[a-z0-9][a-z0-9_-]{1,47}$/.test(s);const validPath=s=>/^assets\/[a-zA-Z0-9_\-/]+\.(png|gif)$/.test(s)&&!s.includes('..');const current=()=>cfg.bosses.find(x=>x.id===chosen)||cfg.bosses[0];
function show(tab){visible=tab;if(tab==='trophies')renderTrophies();if(tab==='schedule')renderSchedule();document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x.id==='tab-'+tab));document.querySelectorAll('#nav button').forEach(x=>x.classList.toggle('active',x.dataset.tab===tab));if(tab==='simulator'){refreshSimSelect();sendSim();}if(tab==='export'){renderExportBosses();check();}}
function drawList(){const el=$('bossList');el.innerHTML=cfg.bosses.map(b=>`<button class="bossrow ${b.id===chosen?'selected':''}" data-pick="${esc(b.id)}"><b>${esc(b.name)}</b><br><small>${esc(b.id)} · ${b.rarity} · вес ${b.weight}</small></button>`).join('');el.querySelectorAll('button').forEach(x=>x.onclick=()=>{chosen=x.dataset.pick;renderBoss();});$('bosscount').textContent=cfg.bosses.length+' персонажей';}
async function drawSprites(){const b=current();$('spriteGrid').innerHTML=Object.entries(slotTitles).map(([slot,label])=>`<div class="spritecard"><img id="spr-${slot}" alt="${label}"><b>${label}</b><small style="display:block;min-height:29px" id="sprpath-${slot}">${esc(b?.sprites?.[slot]||'Файл не выбран')}</small><button class="btn" data-upload="${slot}">↑ Выбрать PNG/GIF</button><input type="file" accept="image/png,image/gif,.png,.gif" id="file-${slot}"><button class="btn danger" data-remove="${slot}">× Очистить</button></div>`).join('');
 for(const [slot] of Object.entries(slotTitles)){let path=b?.sprites?.[slot]||'';let src=await previewSrc(path);$('spr-'+slot).src=src;$(`file-${slot}`).onchange=ev=>onUpload(slot,ev.target.files?.[0]);document.querySelector(`[data-upload="${slot}"]`).onclick=()=>$(`file-${slot}`).click();document.querySelector(`[data-remove="${slot}"]`).onclick=()=>{delete b.sprites[slot];save();drawSprites();drawPortrait();previewAnimation('spawn');sendSim();};}
}
function renderAnim(){const b=current(),panel=$('animationSliders');if(!panel)return;if(!b){panel.innerHTML='<p>Сначала добавь босса</p>';return;}normalizeAnim(b);
 panel.innerHTML=Object.entries(animationFields).map(([k,[label,min,max,step,unit]])=>`<div class="animRow"><div class="row"><label for="anim-${k}">${esc(label)}</label><output id="animval-${k}">${b.animations[k]} ${unit}</output></div><input id="anim-${k}" type="range" min="${min}" max="${max}" step="${step}" value="${b.animations[k]}"><small>${k==='deathHoldMs'?'Время, когда спрайт смерти полностью виден':k==='deathFadeMs'?'После задержки PNG смерти постепенно становится прозрачным':''}</small></div>`).join('');
 panel.querySelectorAll('input[type=range]').forEach(el=>{const k=el.id.slice(5),unit=animationFields[k][4];el.oninput=()=>{b.animations[k]=Number(el.value);$('animval-'+k).textContent=el.value+' '+unit;save();};el.onchange=()=>previewAnimation(k.startsWith('death')?'death':k.startsWith('phase')?'phase':k==='hurtMs'?'hurt':'spawn');});
}
async function previewAnimation(action='spawn') {
 if(!animReady)return;
 const b=current();if(!b)return;
 const request=++animRequest;
 try{
  const overrides=await frameSprites(b);
  if(request!==animRequest)return; // avoid stale preview after switching bosses
  const frame=$('animFrame').contentWindow;
  frame.postMessage({bs41:'config',config:cfg,overrides},'*');
  frame.postMessage({bs41:'battle',data:{kind:'boss-studio4',action,bossId:b.id,active:action!=='death',maxHp:b.hp,hp:action==='death'?0:action==='phase'?Math.floor(b.hp*.65):b.hp,armor:b.armor,phase:action==='phase'?2:1,damage:120,leaderboard:[]}},'*');
 }catch(e){notice('⚠ Ошибка предпросмотра: '+e.message,true);}
}
function rememberExportIds(){try{localStorage.setItem('bs43_export_ids',JSON.stringify([...exportIds]))}catch{}}
function renderExportBosses(){const box=$('exportBosses');if(!box)return;box.innerHTML=cfg.bosses.map(b=>`<label class="export-boss"><input type="checkbox" data-export-boss="${esc(b.id)}" ${exportIds.has(b.id)?'checked':''}><span><strong>${esc(b.name)}</strong><small>${esc(b.id)} · ${esc(b.rarity)} · ${b.enabled?'активен':'отключён'}</small></span></label>`).join('');box.querySelectorAll('input').forEach(el=>el.onchange=()=>{if(el.checked)exportIds.add(el.dataset.exportBoss);else exportIds.delete(el.dataset.exportBoss);rememberExportIds();updateExportCount();});updateExportCount();}
function updateExportCount(){const selected=cfg.bosses.filter(b=>exportIds.has(b.id));$('exportCount').textContent=`Выбрано: ${selected.length} из ${cfg.bosses.length} · в ZIP попадут только спрайты этих боссов`;}
function selectedConfig(){const out=clone(cfg);out.bosses=out.bosses.filter(b=>exportIds.has(b.id));out.schedule.queue=out.schedule.queue.filter(e=>e.kind==='random'||out.bosses.some(b=>b.id===e.bossId));if(!out.schedule.queue.length)out.schedule.queue=[{kind:'random'}];return out;}
async function drawPortrait(){let path=current()?.sprites?.idle||'';$('portrait').src=await previewSrc(path);$('previewPath').textContent=path||'Нет спрайта ожидания';}
async function onUpload(slot,file){if(!file)return;const extension=(file.name.match(/\.(png|gif)$/i)||[])[1]?.toLowerCase(),bytes=new Uint8Array(await file.arrayBuffer());const isPng=bytes.length>8&&[137,80,78,71,13,10,26,10].every((x,i)=>bytes[i]===x),isGif=bytes.length>6&&String.fromCharCode(...bytes.slice(0,6)).startsWith('GIF8');if(!extension||!((extension==='png'&&isPng)||(extension==='gif'&&isGif))){alert('Выбери настоящий файл PNG или GIF');return;}if(bytes.length>25_000_000){alert('Один спрайт не должен превышать 25 МБ');return;}const b=current();const path=`assets/custom_${b.id}/${slot}.${extension}`;try{await media.put(path,bytes,extension==='png'?'image/png':'image/gif');if(urls.has(path)){URL.revokeObjectURL(urls.get(path));urls.delete(path);}iframeUrls.delete(path);b.sprites[slot]=path;save();await drawSprites();await drawPortrait();previewAnimation('spawn');sendSim();notice('✓ Спрайт загружен в базу');}catch(e){alert('Не удалось сохранить спрайт: '+e.message);}}
function renderBoss(){drawList();const b=current();if(!b){$('bossHeader').textContent='Добавь первого босса';return;}$('bossHeader').textContent=b.name;for(const [id,k] of [['bname','name'],['bid','id'],['bhp','hp'],['barmor','armor'],['bweight','weight'],['brarity','rarity']])$(id).value=b[k];$('benabled').checked=b.enabled;drawSprites();drawPortrait();renderAnim();previewAnimation('spawn');}
function bindBossFields(){for(const [id,k] of [['bname','name'],['bhp','hp'],['barmor','armor'],['bweight','weight'],['brarity','rarity']])$(id).addEventListener('change',e=>{let b=current();b[k]=['hp','armor','weight'].includes(k)?Math.max(k==='hp'?1:0,Number(e.target.value)||0):e.target.value.trim().slice(0,32)||'Босс';save();renderBoss();});$('bid').onchange=e=>{let newId=e.target.value.trim().toLowerCase();if(!validId(newId)||cfg.bosses.some(x=>x.id===newId&&x!==current())){alert('ID: 2–48 символов a-z, 0-9, _ или -, уникальный');e.target.value=chosen;return;}const oldId=chosen;current().id=newId;cfg.schedule.queue.forEach(e=>{if(e.bossId===oldId)e.bossId=newId});chosen=newId;if(exportIds.delete(oldId))exportIds.add(newId);save();renderBoss();};$('benabled').onchange=e=>{current().enabled=e.target.checked;save();drawList();};}
function addBoss(){let id='boss_'+Math.random().toString(36).slice(2,8);cfg.bosses.push({id,name:'Новый босс',hp:10000,armor:0,weight:15,rarity:'common',enabled:true,sprites:{},trophy:{name:'Новый трофей',image:'',memcoins:100}});chosen=id;exportIds.add(id);rememberExportIds();save();renderBoss();}
function duplicateBoss(){let b=current();if(!b)return;let id='boss_'+Math.random().toString(36).slice(2,8),copy=clone(b);copy.id=id;copy.name=(copy.name+' (копия)').slice(0,32);copy.trophy.image='';cfg.bosses.push(copy);chosen=id;exportIds.add(id);rememberExportIds();save();renderBoss();}
function drawFields(el,obj,keys){$(el).innerHTML=Object.entries(keys).map(([k,label])=>`<div class="field"><label>${esc(label)}</label><input type="number" min="0" step="1" data-field="${k}" value="${esc(obj[k])}"></div>`).join('');$(el).querySelectorAll('input').forEach(x=>x.onchange=()=>{const k=x.dataset.field;let n=Math.max(0,Math.floor(Number(x.value)||0));if(['spawnChance','phase2Percent','phase3Percent','guardHealPercent'].includes(k))n=Math.min(100,n);cfg.economy[k]=n;save();});}
function renderTrophies(){const el=$('trophyRows');el.innerHTML=cfg.bosses.map(b=>{const t=b.trophy||{};return `<div class="card trophy-card" data-trophy="${esc(b.id)}"><h3>${esc(b.name)}</h3><div class="two"><div><img class="trophy-img" data-preview="${esc(b.id)}" alt="Трофей ${esc(b.name)}"><div class="row"><button class="btn" data-upload-trophy="${esc(b.id)}">↑ Загрузить PNG</button><button class="btn danger" data-clear-trophy="${esc(b.id)}">Очистить PNG</button></div><input type="file" accept="image/png,.png" data-trophy-file="${esc(b.id)}" hidden></div><div><div class="field"><label>Название трофея</label><input data-trophy-field="name" data-boss="${esc(b.id)}" maxlength="60" value="${esc(t.name||'')}"></div><div class="field"><label>Мемкоинов каждому участнику за победу (до 1000)</label><input data-trophy-field="memcoins" data-boss="${esc(b.id)}" type="number" min="1" max="1000" value="${esc(t.memcoins??100)}"></div><p>За каждую победу участники получают трофей и ожидающую выплату. Запросить накопленные мемкоины можно после сбора трофеев всех включённых боссов.</p></div></div></div>`}).join('');
 el.querySelectorAll('[data-preview]').forEach(async img=>{const b=cfg.bosses.find(x=>x.id===img.dataset.preview);img.src=await previewSrc(b?.trophy?.image);});
 el.querySelectorAll('[data-trophy-field]').forEach(input=>input.onchange=()=>{const b=cfg.bosses.find(x=>x.id===input.dataset.boss);if(!b)return;const k=input.dataset.trophyField;if(k==='name')b.trophy.name=input.value.trim().slice(0,60)||'Трофей '+b.name;else b.trophy[k]=Math.min(1000,Math.max(1,Math.floor(Number(input.value)||1)));input.value=b.trophy[k];save();});
 el.querySelectorAll('[data-upload-trophy]').forEach(btn=>btn.onclick=()=>el.querySelector(`[data-trophy-file="${btn.dataset.uploadTrophy}"]`).click());
 el.querySelectorAll('[data-clear-trophy]').forEach(btn=>btn.onclick=()=>{const b=cfg.bosses.find(x=>x.id===btn.dataset.clearTrophy);b.trophy.image='';save();renderTrophies();});
 el.querySelectorAll('[data-trophy-file]').forEach(input=>input.onchange=async()=>{const file=input.files?.[0],b=cfg.bosses.find(x=>x.id===input.dataset.trophyFile);if(!file||!b)return;const bytes=new Uint8Array(await file.arrayBuffer());if(bytes.length>5_000_000||![137,80,78,71,13,10,26,10].every((n,i)=>bytes[i]===n)){alert('Нужен настоящий PNG до 5 МБ');return;}const path=`assets/trophies/${b.id}.png`;await media.put(path,bytes,'image/png');if(urls.has(path)){URL.revokeObjectURL(urls.get(path));urls.delete(path)}b.trophy.image=path;save();renderTrophies();});}
function renderSchedule(){const q=cfg.schedule;for(const [id,k] of [['scheduleFirst','firstDelayMin'],['scheduleNext','nextDelayMin'],['scheduleMax','maxBosses']])$(id).value=q[k];$('scheduleEnabled').checked=!!q.enabled;const box=$('scheduleQueue');box.innerHTML=q.queue.map((entry,i)=>`<div class="row" style="margin:7px 0"><b>${i+1}.</b><select data-queue="${i}"><option value="random" ${entry.kind==='random'?'selected':''}>🎲 Случайный босс</option>${cfg.bosses.map(b=>`<option value="${esc(b.id)}" ${entry.bossId===b.id?'selected':''}>${esc(b.name)}</option>`).join('')}</select><button class="btn" data-move="${i}" data-dir="-1">↑</button><button class="btn" data-move="${i}" data-dir="1">↓</button><button class="btn danger" data-remove-queue="${i}">×</button></div>`).join('');box.querySelectorAll('[data-queue]').forEach(x=>x.onchange=()=>{q.queue[+x.dataset.queue]=x.value==='random'?{kind:'random'}:{kind:'boss',bossId:x.value};save();renderSchedule();});box.querySelectorAll('[data-move]').forEach(x=>x.onclick=()=>{let a=+x.dataset.move,b=a+ +x.dataset.dir;if(b<0||b>=q.queue.length)return;[q.queue[a],q.queue[b]]=[q.queue[b],q.queue[a]];save();renderSchedule();});box.querySelectorAll('[data-remove-queue]').forEach(x=>x.onclick=()=>{if(q.queue.length===1)return;q.queue.splice(+x.dataset.removeQueue,1);save();renderSchedule();});}
function refreshSimSelect(){const x=$('simBoss'),old=x.value;x.innerHTML=cfg.bosses.filter(b=>b.enabled).map(b=>`<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('');if([...x.options].some(op=>op.value===old))x.value=old;}
let initBusy=false,sendAgain=false;async function sendSim(){
 if(!sim||!simReady)return;
 if(initBusy){sendAgain=true;return;}
 initBusy=true;
 try{
  do{
   sendAgain=false;
   const selected=cfg.bosses.find(b=>b.id===sim.bossId);
   const overrides=await frameSprites(selected);
   if(sendAgain)continue;
   const target=$('simFrame').contentWindow;
   target.postMessage({bs41:'config',config:cfg,overrides},'*');
   target.postMessage({bs41:'battle',data:BattleCore.snapshot(sim,sim.lastResult||{action:'sync'})},'*');
  }while(sendAgain);
 }catch(e){notice('⚠ Полигон: '+e.message,true);}finally{initBusy=false;}
}
function applySim(event){if(!sim)sim=BattleCore.make(clone(cfg),1234);const r=BattleCore.apply(sim,event);r.player=event.user||'Тестер';sim.lastResult=r;$('simStatus').textContent=(r.ok?'✓ ':'⚠ ')+(r.reason||`${event.type}: ${r.damage||0} урона`);$('simStatus').className=r.ok?'notice good':'notice errmsg';let b=cfg.bosses.find(b=>b.id===sim.bossId);const profile=sim.players[($('simUser').value||'test').trim().toLowerCase()];const trophy=cfg.bosses.find(x=>x.id===sim.bossId)?.trophy;$('simSummary').innerHTML=[`Босс: ${esc(b?.name||'—')}`,`HP: ${sim.hp}/${sim.maxHp}`,`Броня: ${sim.armor}`,`Фаза: ${sim.phase}`,`Игроков: ${Object.keys(sim.participants).length}`,`Проклятие: ${sim.curseActive?'да':'нет'}`,`Трофеи этого босса: ${profile?.bossTrophies?.[sim.bossId]||0}`].map(x=>`<span>${x}</span>`).join('');$('simLog').innerHTML=sim.log.map(x=>`<div>${esc(x.text)}</div>`).join('');sendSim();return r;}
function eventInput(type){return {type,user:($('simUser').value||'Тестовый_зритель').trim(),userId:($('simUser').value||'test').trim().toLowerCase(),amount:Math.max(0,Number($('simAmount').value)||0)};}
function stress(){if(!sim?.active)applySim({type:'spawn',bossId:$('simBoss').value});const list=['hit','bits','magic','follow','sub','donation','guard','giftsub'];for(let i=0;i<500;i++){if(!sim.active)BattleCore.apply(sim,{type:'spawn',bossId:$('simBoss').value});sim.time+=1000;BattleCore.apply(sim,{type:list[i%list.length],user:'Bot'+(i%18),userId:'bot'+(i%18),amount:5+i%30,eventId:'stress'+i});if(sim.curseActive&&i%4===0)BattleCore.apply(sim,{type:'guard',user:'Guard'+i,userId:'guard'+i});}sim.lastResult={action:'sync'};applySim({type:'tick',amount:0});}
function phases(){if(!sim?.active)applySim({type:'spawn',bossId:$('simBoss').value});const order=['phase2','phase3','death'];for(const marker of order){if(!sim.active)break;const target=marker==='phase2'?Math.floor(sim.maxHp*cfg.economy.phase2Percent/100):marker==='phase3'?Math.floor(sim.maxHp*cfg.economy.phase3Percent/100):0;const dmg=sim.armor+Math.max(0,sim.hp-target)+1;let b=BattleCore.apply(sim,{type:'donation',amount:Math.ceil(dmg/Math.max(1,cfg.economy.donationDamagePerUnit)),user:'Контрольный донат',userId:'scenario'});while(sim.active&&sim.hp>target){sim.time+=60000;const r=BattleCore.apply(sim,{type:'bits',amount:cfg.economy.bitsDamageCap,user:'Контроль',userId:'scenario',eventId:'phase'+sim.seq+sim.time});if(!r.ok||sim.hp===target)break;}sim.lastResult={action:sim.active?'phase':'death',damage:0};}applySim({type:'tick',amount:0});}
function download(name,blob){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),5000);}
function jsonBlob(x){return new Blob([JSON.stringify(x,null,2)],{type:'application/json'});}
function issues(bosses=cfg.bosses){const arr=[];const seen=new Set();for(const b of bosses){if(!validId(b.id))arr.push('Недопустимый ID босса '+b.id);if(seen.has(b.id))arr.push('Дублированный ID '+b.id);seen.add(b.id);if(b.hp<1)arr.push('HP должен быть >0: '+b.name);if(!b.sprites?.idle)arr.push('Нет спрайта ожидания: '+b.name);for(const v of Object.values(b.sprites||{}))if(!validPath(v))arr.push('Небезопасный путь к спрайту: '+v);if(b.trophy?.image&&!validPath(b.trophy.image))arr.push('Неверный путь трофея '+b.name);if(!Number.isInteger(b.trophy?.memcoins)||b.trophy.memcoins<1||b.trophy.memcoins>1000)arr.push('Проверь награду '+b.name);}if(cfg.economy.phase3Percent>=cfg.economy.phase2Percent)arr.push('Фаза 3 должна начинаться при меньшем HP, чем фаза 2');if(!bosses.some(b=>b.enabled&&b.weight>0))arr.push('Нет активных боссов с положительным весом');return arr;}
async function check(bosses=cfg.bosses){let arr=issues(bosses),missing=[];for(const b of bosses)for(const path of [...Object.values(b.sprites||{}),b.trophy?.image].filter(Boolean)){if(!path||window.BS_BUNDLED_ASSETS?.[path])continue;if(!(await media.get(path)))missing.push(path);}arr.push(...missing.map(x=>'Нет загруженного файла: '+x));$('issues').innerHTML=arr.length?arr.map(x=>`<div class="errmsg">⚠ ${esc(x)}</div>`).join(''):'<div class="good">✓ Конфигурация и ссылки на медиа проверены</div>';return arr;}
async function packageSelected(){
 const selected=selectedConfig();
 if(!selected.bosses.length)throw Error('Отметь хотя бы одного босса во вкладке экспорта.');
 const problems=await check(selected.bosses);
 if(problems.length)throw Error('Исправь ошибки проекта перед синхронизацией: '+problems.join('; '));
 const map={'boss-config.json':JSON.stringify(selected,null,2),'boss-config.js':'window.BOSS_STUDIO_4_CONFIG='+JSON.stringify(selected).replace(/</g,'\\u003c')+';\n','project.json':JSON.stringify(selected,null,2),'overlay.html':BS_TEMPLATES.overlay,'README_RU.md':BS_TEMPLATES.readme,'battle-core.js':BS_TEMPLATES.battleCore};
 const sprites=[...new Set(selected.bosses.flatMap(b=>[...Object.values(b.sprites||{}),b.trophy?.image]).filter(Boolean))];
 for(const path of sprites){
  if(!validPath(path))throw Error('Недопустимое имя спрайта: '+path);
  const stored=await media.get(path);let bytes=stored?new Uint8Array(stored.bytes):bundled(path);
  if(!bytes)throw Error('Нет файла '+path);
  map[path]=bytes;
 }
 return {blob:BSZip.make(map),count:selected.bosses.length,sprites:sprites.length};
}
async function exportZip(){
 try{$('zipStatus').textContent='Формируем комплект…';const pkg=await packageSelected();download('BossStudio43_Selected_Raid_Project.zip',pkg.blob);$('zipStatus').textContent='✓ Экспортировано '+pkg.count+' боссов и '+pkg.sprites+' изображений';}
 catch(e){$('zipStatus').textContent='Ошибка: '+e.message;notice(e.message,true);}
}
async function checkBridge(){
 const box=$('bridgeStatus');box.textContent='Проверяем локальный мост…';
 try{const r=await fetch('/api/status',{cache:'no-store'});if(!r.ok)throw Error('HTTP '+r.status);const d=await r.json();if(!d.ok||!d.token)throw Error('Мост ответил некорректно');window.BS43_BRIDGE=d;box.textContent='✓ Локальный мост включён. Папка: '+d.dataDir;$('liveOverlayUrl').value=d.overlayUrl;return d;}
 catch(e){box.textContent='⚠ Мост недоступен. Запусти START_WINDOWS.bat и открой редактор через http://127.0.0.1:8765/editor';throw e;}
}
async function websocketRequest(ws,request){
 return new Promise((resolve,reject)=>{
  const id='bs43-'+Math.random().toString(36).slice(2);
  let done=false;const timer=setTimeout(()=>finish(new Error('Нет ответа от Streamer.bot')),5000);
  function finish(err,result){if(done)return;done=true;clearTimeout(timer);ws.removeEventListener('message',onMessage);err?reject(err):resolve(result);}
  function onMessage(ev){let m;try{m=JSON.parse(ev.data)}catch{return;}if(m.id===id)finish(m.status==='error'?new Error(m.error||'Streamer.bot отклонил запрос'):null,m);}
  ws.addEventListener('message',onMessage);ws.send(JSON.stringify({...request,id}));
 });
}
function openStreamerSocket(){return new Promise((resolve,reject)=>{
 const url=$('websocketUrl').value.trim();if(!/^wss?:\/\/(?:127\.0\.0\.1|localhost):\d+\/?$/.test(url)){reject(Error('Можно использовать только локальный WebSocket 127.0.0.1 или localhost'));return;}
 let ws;try{ws=new WebSocket(url);}catch(e){reject(e);return;}
 const timer=setTimeout(()=>{ws.close();reject(Error('Таймаут подключения к Streamer.bot'));},4500);
 ws.onopen=()=>{clearTimeout(timer);resolve(ws);};ws.onerror=()=>{clearTimeout(timer);reject(Error('WebSocket недоступен — проверь сервер и авторизацию'));};ws.onclose=()=>{clearTimeout(timer);};
 });}
async function checkStreamer(){
 const label=$('sbStatus');label.textContent='Проверяем Streamer.bot и Twitch…';let ws=null;
 try{
   ws=await openStreamerSocket();const m=await websocketRequest(ws,{request:'GetBroadcaster'});
   const channel=m.platforms?.twitch?.broadcastUserName||m.platforms?.twitch?.broadcastUser||'';
   if(!channel) {label.textContent='⚠ Streamer.bot запущен, но Twitch не подключён. Войди в аккаунт Twitch в Streamer.bot.';return {found:false};}
   label.textContent='✓ Streamer.bot и Twitch подключены: '+channel+'. C#-действия не нужны.';
   return {found:true};
 }catch(e){label.textContent='⚠ '+e.message;return {found:false,error:e.message};}
 finally{if(ws&&ws.readyState===WebSocket.OPEN)ws.close();}
}
async function signalStreamer(){return 'Настройки эфира синхронизированы.';}
async function loadPublished(){
 if(!confirm('Заменить текущую базу редактора опубликованной базой эфира? Перед заменой сохрани ZIP-копию, если есть неопубликованные изменения.'))return;
 const btn=$('loadPublished');btn.disabled=true;
 try{
  const response=await fetch('/api/live-config',{cache:'no-store'});if(!response.ok)throw Error('Опубликованная база не найдена');
  const incoming=cleanCfg(await response.json());
  const paths=[...new Set(incoming.bosses.flatMap(b=>[...Object.values(b.sprites||{}),b.trophy?.image]).filter(Boolean))];
  for(const path of paths){if(!validPath(path))throw Error('Недопустимый путь изображения: '+path);
   const file=await fetch('/live/'+path,{cache:'no-store'});if(!file.ok)throw Error('Изображение недоступно: '+path);
   await media.put(path,new Uint8Array(await file.arrayBuffer()),path.endsWith('.gif')?'image/gif':'image/png');if(urls.has(path)){URL.revokeObjectURL(urls.get(path));urls.delete(path)}iframeUrls.delete(path);
  }
  cfg=incoming;chosen=cfg.bosses[0]?.id||null;exportIds.clear();cfg.bosses.forEach(b=>exportIds.add(b.id));rememberExportIds();save();renderAll();renderExportBosses();sim=BattleCore.make(clone(cfg),42);sendSim();await refreshPublished();notice('✓ Опубликованная база и изображения загружены');
 }catch(e){notice('⚠ '+e.message,true)}finally{btn.disabled=false;}
}
async function refreshPublished(){try{const r=await fetch('/api/easy/config',{cache:'no-store'});if(!r.ok)throw Error('Эфир не отвечает');const d=await r.json();$('publishedBosses').textContent='В эфире сейчас: '+(d.bosses||[]).map(b=>b.name+(b.enabled?'':' (отключён)')).join(', ');}catch(e){$('publishedBosses').textContent='⚠ '+e.message}}
async function syncNow(){const status=$('liveSyncStatus');const btn=$('syncNow');btn.disabled=true;
 try{status.textContent='Собираем выбранных боссов…';const bridge=await checkBridge();const pkg=await packageSelected();status.textContent='Отправляем '+pkg.count+' боссов и '+pkg.sprites+' PNG/GIF…';
 const r=await fetch('/api/deploy',{method:'POST',headers:{'Content-Type':'application/zip','X-Boss-Studio-Token':bridge.token},body:pkg.blob});const result=await r.json();if(!r.ok||!result.ok)throw Error(result.error||'Ошибка моста');
 status.textContent='✓ '+result.bosses+' боссов / '+result.sprites+' спрайтов синхронизированы. Проверяем Streamer.bot…';
 const sb=await signalStreamer();status.textContent='✓ Файлы и OBS-оверлей обновлены. '+sb;await refreshPublished();
 }catch(e){status.textContent='⚠ '+e.message;notice(e.message,true);}finally{btn.disabled=false;}
}
async function importFrom(file){if(!file)return;try{let data;if(file.name.toLowerCase().endsWith('.zip')){const files=BSZip.read(await file.arrayBuffer());if(!files['project.json']&&!files['boss-config.json'])throw Error('Нет JSON проекта');data=JSON.parse(BSZip.decode(files['project.json']||files['boss-config.json']));const paths=[...new Set(data.bosses.flatMap(b=>[...Object.values(b.sprites||{}),b.trophy?.image]).filter(Boolean))];for(const path of paths){if(files[path]&&validPath(path))await media.put(path,files[path],path.endsWith('.gif')?'image/gif':'image/png');}
 }else data=JSON.parse(await file.text());cfg=cleanCfg(data);chosen=cfg.bosses[0]?.id||null;exportIds.clear();cfg.bosses.forEach(b=>exportIds.add(b.id));rememberExportIds();save();renderAll();previewAnimation('spawn');sendSim();notice('✓ База загружена');alert('База успешно импортирована');}catch(e){alert('Ошибка импорта: '+e.message);}}
function renderAll(){renderBoss();drawFields('eventFields',cfg.economy,eventParams);drawFields('econFields',cfg.economy,econParams);renderTrophies();renderSchedule();refreshSimSelect();}
function init(){document.querySelectorAll('#nav button').forEach(x=>x.onclick=()=>show(x.dataset.tab));bindBossFields();$('addBoss').onclick=addBoss;$('dupBoss').onclick=duplicateBoss;$('delBoss').onclick=()=>{if(!confirm('Удалить босса из базы?'))return;exportIds.delete(chosen);rememberExportIds();cfg.bosses=cfg.bosses.filter(b=>b.id!==chosen);cfg.schedule.queue=cfg.schedule.queue.filter(e=>e.bossId!==chosen);if(!cfg.schedule.queue.length)cfg.schedule.queue=[{kind:'random'}];chosen=cfg.bosses[0]?.id||null;save();renderBoss();};$('simFrame').onload=()=>{simReady=true;sendSim();};$('animFrame').onload=()=>{animReady=true;previewAnimation('spawn');};$('animPreviewSpawn').onclick=()=>previewAnimation('spawn');$('animPreviewDeath').onclick=()=>previewAnimation('death');$('animPreviewPhase').onclick=()=>previewAnimation('phase');$('resetAnimations').onclick=()=>{const b=current();if(!b)return;b.animations=clone(DEFAULT_ANIM);save();renderAnim();previewAnimation('spawn');};$('exportSelectAll').onclick=()=>{cfg.bosses.forEach(b=>exportIds.add(b.id));rememberExportIds();renderExportBosses();};$('exportSelectNone').onclick=()=>{exportIds.clear();rememberExportIds();renderExportBosses();};$('scheduleEnabled').onchange=e=>{cfg.schedule.enabled=e.target.checked;save();};for(const [id,key] of [['scheduleFirst','firstDelayMin'],['scheduleNext','nextDelayMin'],['scheduleMax','maxBosses']])$(id).onchange=e=>{cfg.schedule[key]=Math.max(key==='maxBosses'?1:0,Math.min(key==='maxBosses'?100:10080,Math.floor(Number(e.target.value)||0)));e.target.value=cfg.schedule[key];save();};$('scheduleAddBoss').onclick=()=>{if(cfg.schedule.queue.length>=100){alert('Максимум 100 записей');return;}cfg.schedule.queue.push({kind:'random'});save();renderSchedule();};$('scheduleSync').onclick=async()=>{await syncNow();$('scheduleSyncMsg').textContent=$('liveSyncStatus').textContent;};$('simButtons').innerHTML=Object.entries(evtNames).map(([v,label])=>`<button class="btn" data-sim="${v}">${label}</button>`).join('');$('simButtons').querySelectorAll('button').forEach(x=>x.onclick=()=>applySim(eventInput(x.dataset.sim)));$('simSpawn').onclick=()=>applySim({type:'spawn',bossId:$('simBoss').value});$('simReset').onclick=()=>{sim=BattleCore.make(clone(cfg),42);applySim({type:'reset'});};$('simTick').onclick=()=>applySim({type:'tick',amount:20});$('simStress').onclick=stress;$('simPhases').onclick=phases;$('checkBridge').onclick=()=>checkBridge().catch(()=>{});$('checkStreamerbot').onclick=checkStreamer;$('syncNow').onclick=syncNow;$('syncBossesTop').onclick=syncNow;$('loadPublished').onclick=loadPublished;refreshPublished();$('copyLiveUrl').onclick=()=>{const address=$('liveOverlayUrl').value;if(!navigator.clipboard?.writeText){window.prompt('Скопируй URL OBS:',address);return;}navigator.clipboard.writeText(address).then(()=>{$('liveSyncStatus').textContent='Адрес OBS скопирован';}).catch(()=>{window.prompt('Скопируй URL OBS:',address);});};$('exportZip').onclick=exportZip;$('exportJson').onclick=()=>download('boss-database-all.json',jsonBlob(cfg));$('exportSelectedJson').onclick=()=>{const data=selectedConfig();if(!data.bosses.length){alert('Выбери хотя бы одного босса');return;}download('boss-database-selected.json',jsonBlob(data));};$('inputImport').onchange=e=>importFrom(e.target.files?.[0]);$('importZip').onclick=()=>{$('inputImport').accept='.zip';$('inputImport').value='';$('inputImport').click();};$('importJson').onclick=()=>{$('inputImport').accept='.json';$('inputImport').value='';$('inputImport').click();};$('checkProject').onclick=()=>check();$('adminLogin').value=cfg.adminLogin||'';$('adminLogin').onchange=()=>{cfg.adminLogin=$('adminLogin').value.trim().replace(/^@/,'').toLowerCase();save();};$('websocketUrl').value=cfg.websocketUrl||'ws://127.0.0.1:8080/';$('websocketUrl').onchange=()=>{cfg.websocketUrl=$('websocketUrl').value.trim();save();};renderAll();renderExportBosses();sim=BattleCore.make(clone(cfg),42);notice('● База готова');}
openDb().then(x=>{db=x;init();}).catch(e=>{init();notice('⚠ Временное хранилище: сразу экспортируй ZIP',true);});
})();
