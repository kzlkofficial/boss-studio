(()=>{'use strict';
const $=id=>document.getElementById(id);
const FONTS=[['Georgia','Georgia (классический)'],['Segoe UI','Segoe UI (современный)'],['Arial','Arial (простой)'],['Verdana','Verdana (чёткий)'],['Trebuchet MS','Trebuchet MS'],['Tahoma','Tahoma'],['Impact','Impact (крупный)'],['Courier New','Courier New (печатный)'],['Times New Roman','Times New Roman']];
const TEXT_FIELDS=[
 ['bossName','Имя босса','ХАПКА',220,'Georgia',true,'#f9f0df'],
 ['phase','Строка фазы / редкости','ФАЗА 2 · RARE',190,'Segoe UI',false,'#dcc79e'],
 ['topTitle','Подпись «Топ урона»','⚔ Топ урона',200,'Segoe UI',true,'#e8c18a'],
 ['hp','Числа здоровья (HP)','6 500 / 10 000 HP',180,'Arial',true,'#ffffff'],
 ['notice','Предупреждения и способности','⚠ ПРОКЛЯТИЕ',200,'Georgia',true,'#f9f0df'],
 ['topRows','Ники и урон в топе','1. Зритель  —  1 200',200,'Segoe UI',false,'#f9f0df'],
 ['armor','Щиты и броня','🛡 Броня 250',200,'Segoe UI',true,'#b7d6e7'],
 ['bonusText','Названия бонусов','Бонус зрителя',200,'Segoe UI',true,'#ffe2c3'],
 ['bonusCost','Стоимость бонусов','100 баллов Twitch',200,'Segoe UI',false,'#efd1a7']
];
const BOX_DEFAULTS={boss:{x:690,y:450,w:1620,h:2220},bossName:{x:450,y:60,w:2100,h:120},phase:{x:450,y:180,w:2100,h:70},health:{x:720,y:2760,w:1560,h:50},hpText:{x:720,y:2760,w:1560,h:50},armor:{x:720,y:2650,w:900,h:70},top:{x:2340,y:1050,w:600,h:600},topTitle:{x:2356,y:1060,w:568,h:75},notice:{x:810,y:600,w:1380,h:180},bonusDock:{x:60,y:2100,w:360,h:600}};
const BOX_LABELS={boss:'Спрайт босса',bossName:'Имя босса',phase:'Фаза и редкость',health:'Полоса HP',hpText:'Числа HP',armor:'Броня',top:'Окно топа',topTitle:'Заголовок топа',notice:'Предупреждение',bonusDock:'Бонусы зрителей'};
const TEXT_TEMPLATES={bossName:'{boss}',phase:'ФАЗА {phase} · {rarity}',hpText:'{hp} / {maxHp} HP',armor:'🛡 Броня {armor}',notice:'⚠ ПРОКЛЯТИЕ — !щит ({guards}/{requiredGuards})'};
const defaults={backgroundColor:'#16131e',backgroundOpacity:0,hpColor:'#e45a67',topTitle:'⚔ Топ урона',topVisible:true,topOpacity:82,fontScale:100,overallScale:100,bonusIconScale:100,bonusFlashScale:100,layout:BOX_DEFAULTS,layerOrder:Object.keys(BOX_DEFAULTS),textTemplates:TEXT_TEMPLATES};
const sliders=[['backgroundOpacity','Прозрачность подложки',0,100,'%'],['topOpacity','Непрозрачность окна топа',0,100,'%'],['overallScale','Масштаб всей сцены (в пределах OBS)',50,100,'%'],['bonusIconScale','Размер иконок бонусов',50,800,'%'],['bonusFlashScale','Размер всплывающего бонуса',50,800,'%']];
const EDGES=['nw','n','ne','e','se','s','sw','w'];
const EDGE_POS={nw:[0,0],n:[50,0],ne:[100,0],e:[100,50],se:[100,100],s:[50,100],sw:[0,100],w:[0,50]};
const STAGE=3000,MIN_W=120,MIN_H=30;
let selected='bossName',previewConfig=null,previewBossId='',drag=null,paintPending=false,dirty=false;
const clamp=(value,min,max)=>Math.max(min,Math.min(max,Number.isFinite(+value)?+value:min));
function boundBox(box){const w=Math.round(clamp(box.w,MIN_W,STAGE)),h=Math.round(clamp(box.h,MIN_H,STAGE));return{x:Math.round(clamp(box.x,0,STAGE-w)),y:Math.round(clamp(box.y,0,STAGE-h)),w,h};}
const defaultsFor=([key,label,sample,max,font,bold,color],legacyScale=100)=>({scale:key==='bossName'?legacyScale:100,font,bold,italic:false,underline:false,color});
let config={...defaults,typography:{}},token='';
function normalize(value){const v={...defaults,...value};v.typography=v.typography||{};const old=v.layout||{},heading=old.heading||{},health=old.health||{};
 v.layout={};for(const [key,box] of Object.entries(BOX_DEFAULTS)){
  let source=old[key]||{};
  if(key==='bossName'&&!old[key]&&old.heading)source=heading;
  if(key==='phase'&&!old[key]&&old.heading)source={...heading,y:(+heading.y||60)+120};
  if(key==='hpText'&&!old[key]&&old.health)source=health;
  if(key==='topTitle'&&!old[key]&&old.top)source={x:(+old.top.x||2340)+16,y:(+old.top.y||1050)+10,w:Math.max(120,(+old.top.w||600)-32),h:75};
  if(key==='health'&&!('h' in source)&&v.hpBarScale)source={...source,h:Math.round(50*clamp(v.hpBarScale,50,400)/100)};
  if(key==='hpText'&&!('h' in source)&&v.hpBarScale)source={...source,h:Math.round(50*clamp(v.hpBarScale,50,400)/100)};
  v.layout[key]=boundBox({...box,...source});
 }
 v.overallScale=Math.min(100,Number(v.overallScale)||100);v.textTemplates={...TEXT_TEMPLATES,...(v.textTemplates||{})};const existing=Array.isArray(v.layerOrder)?v.layerOrder:[];v.layerOrder=[...new Set([...existing.filter(k=>Object.hasOwn(BOX_DEFAULTS,k)),...Object.keys(BOX_DEFAULTS)])];
 for(const item of TEXT_FIELDS){const key=item[0],base=defaultsFor(item,Number(v.fontScale)||100);v.typography[key]={...base,...(v.typography[key]||{})};}return v;}
function fontCss(name){return `'${name.replaceAll("'",'')}', sans-serif`;}
function previewStyle(el,t){el.style.fontFamily=fontCss(t.font);el.style.fontWeight=t.bold?'700':'400';el.style.fontStyle=t.italic?'italic':'normal';el.style.textDecoration=t.underline?'underline':'none';el.style.color=t.color;el.style.fontSize=(Math.min(64,Math.max(13,20*t.scale/100)))+'px';}
function drawTypography(){const host=$('typographyFields');if(!host)return;host.replaceChildren();
 for(const item of TEXT_FIELDS){const [key,label,sample,max]=item,t=config.typography[key];const card=document.createElement('div');card.className='type-card';
   const head=document.createElement('strong');head.textContent=label;card.append(head);
   const preview=document.createElement('div');preview.className='type-preview';preview.textContent=key==='topTitle'?config.topTitle:sample;card.append(preview);
   const fontLabel=document.createElement('label');fontLabel.textContent='Шрифт';const sel=document.createElement('select');sel.id='type_'+key+'_font';
   for(const [fontName,caption] of FONTS){const option=document.createElement('option');option.value=fontName;option.textContent=caption;sel.append(option)}sel.value=t.font;sel.onchange=()=>{t.font=sel.value;previewStyle(preview,t);markChanged()};fontLabel.append(sel);card.append(fontLabel);
   const labelScale=document.createElement('label');labelScale.textContent='Масштаб текста ';const output=document.createElement('output');output.textContent=t.scale+'%';labelScale.append(output);card.append(labelScale);
   const range=document.createElement('input');range.type='range';range.min='10';range.max='1000';range.step='5';range.value=t.scale;range.id='type_'+key+'_scale';range.oninput=()=>{t.scale=Number(range.value);number.value=t.scale;output.textContent=t.scale+'%';previewStyle(preview,t);markChanged()};card.append(range);
   const number=document.createElement('input');number.type='number';number.min='10';number.max='10000';number.step='1';number.value=t.scale;number.setAttribute('aria-label','Масштаб текста, процентов');number.onchange=()=>{t.scale=Math.max(10,Math.min(10000,Math.round(Number(number.value)||100)));number.value=t.scale;range.value=Math.min(1000,t.scale);output.textContent=t.scale+'%';previewStyle(preview,t);markChanged()};card.append(number);
   const row=document.createElement('div');row.className='type-options';
   for(const [field,caption,title] of [['bold','Ж','Жирный'],['italic','К','Курсив'],['underline','Ч','Подчёркнутый']]){
     const btn=document.createElement('button');btn.type='button';btn.className='type-toggle';btn.textContent=caption;btn.title=title;btn.setAttribute('aria-label',title);btn.setAttribute('aria-pressed',String(!!t[field]));btn.onclick=()=>{t[field]=!t[field];btn.setAttribute('aria-pressed',String(t[field]));previewStyle(preview,t);markChanged()};row.append(btn);
   }
   const colorLabel=document.createElement('label');colorLabel.className='type-color';colorLabel.textContent='Цвет ';const color=document.createElement('input');color.type='color';color.value=t.color;color.id='type_'+key+'_color';color.oninput=()=>{t.color=color.value;previewStyle(preview,t);markChanged()};colorLabel.append(color);row.append(colorLabel);card.append(row);
   host.append(card);previewStyle(preview,t);
 }
}
function draw(){let parts=`<div class="bonus-field"><label>Цвет подложки</label><input type="color" id="sty_backgroundColor" value="${config.backgroundColor}"></div><div class="bonus-field"><label>Цвет HP</label><input type="color" id="sty_hpColor" value="${config.hpColor}"></div><div class="bonus-field"><label>Подпись топа урона</label><input id="sty_topTitle" maxlength="50"></div><div class="bonus-field"><label><input type="checkbox" id="sty_topVisible" ${config.topVisible?'checked':''}> Показывать топ урона</label></div>`;
 for(const [k,label,min,max,suffix] of sliders)parts+=`<div class="bonus-field"><label>${label}<output id="styout_${k}">${config[k]}${suffix}</output></label><input type="range" id="sty_${k}" min="${min}" max="${max}" value="${config[k]}"></div>`;
 $('designFields').innerHTML=parts;$('sty_topTitle').value=config.topTitle;
 for(const k of ['backgroundColor','hpColor','topTitle'])$('sty_'+k).oninput=e=>{config[k]=e.target.value;if(k==='topTitle'){const node=$('typographyFields')?.querySelector('.type-card:nth-child(3) .type-preview');if(node)node.textContent=config.topTitle}markChanged()};
 $('sty_topVisible').onchange=e=>{config.topVisible=e.target.checked;markChanged()};
 for(const [k,,,,suffix] of sliders)$('sty_'+k).oninput=e=>{config[k]=+e.target.value;$('styout_'+k).textContent=config[k]+suffix;markChanged()};
 drawTypography();drawPicks();drawInspector();drawLayerList();drawBoxes();}
function drawPicks(){const host=$('designPickList');host.replaceChildren();for(const [key,label] of Object.entries(BOX_LABELS)){
 const button=document.createElement('button');button.type='button';button.textContent=label;button.dataset.pick=key;button.className=selected===key?'selected':'';button.onclick=()=>select(key);host.append(button);
 }}
function select(key){if(!BOX_DEFAULTS[key])return;selected=key;drawPicks();drawInspector();drawLayerList();drawBoxes();}
function drawInspector(){const host=$('designInspector');host.replaceChildren();const title=document.createElement('strong');title.textContent='Выбран: '+BOX_LABELS[selected];host.append(title);
 const fields=document.createElement('div');fields.className='bonus-fields';host.append(fields);
 for(const [axis,label] of [['x','X'],['y','Y'],['w','Ширина'],['h','Высота']]){
  const wrapper=document.createElement('label');wrapper.textContent=label+' (px)';const input=document.createElement('input');input.type='number';input.min=axis==='w'?MIN_W:axis==='h'?MIN_H:0;input.max=STAGE;input.step='1';input.dataset.coord=axis;input.value=config.layout[selected][axis];input.onchange=()=>{const box=config.layout[selected];config.layout[selected]=boundBox({...box,[axis]:Math.round(Number(input.value))});drawInspector();markChanged()};wrapper.append(input);fields.append(wrapper);
 }
 if(Object.hasOwn(TEXT_TEMPLATES,selected)||selected==='topTitle'){
  const label=document.createElement('label');label.textContent='Текст (двойной щелчок по рамке тоже открывает редактор)';
  const input=document.createElement('input');input.type='text';input.maxLength=selected==='topTitle'?50:120;input.value=selected==='topTitle'?config.topTitle:config.textTemplates[selected];input.dataset.textField=selected;
  input.oninput=()=>{setText(selected,input.value);markChanged()};label.append(input);host.append(label);
  const help=document.createElement('p');help.className='sub';help.textContent='Переменные: {boss}, {phase}, {rarity}, {hp}, {maxHp}, {armor}, {guards}, {requiredGuards}. Они подставляются во время боя.';host.append(help);
  const edit=document.createElement('button');edit.type='button';edit.textContent='Редактировать прямо на макете';edit.onclick=()=>openInline(selected);host.append(edit);
 }
 const layerButtons=document.createElement('div');layerButtons.className='actions';for(const [delta,title] of [[1,'На слой вперёд'],[-1,'На слой назад']]){const btn=document.createElement('button');btn.type='button';btn.textContent=title;btn.onclick=()=>moveLayer(selected,delta);layerButtons.append(btn)}host.append(layerButtons);
 const hint=document.createElement('p');hint.className='sub';hint.textContent='Перемещай рамку мышью. Растягивай за углы или стороны. Стрелки двигают выделенный элемент на 1 px, Shift + стрелка — на 10 px.';host.append(hint);
}
function setText(key,value){if(key==='topTitle'){config.topTitle=value.slice(0,50);const top=$('sty_topTitle');if(top)top.value=config.topTitle}else config.textTemplates[key]=value.slice(0,120)}
function openInline(key){if(!(Object.hasOwn(TEXT_TEMPLATES,key)||key==='topTitle'))return;select(key);
 const host=$('designHitLayer'),old=host.querySelector('.design-inline-text');if(old)old.remove();const b=config.layout[key],scale=$('designStage').clientWidth/STAGE;
 const input=document.createElement('input');input.className='design-inline-text';input.type='text';input.maxLength=key==='topTitle'?50:120;input.value=key==='topTitle'?config.topTitle:config.textTemplates[key];
 Object.assign(input.style,{left:b.x*scale+'px',top:b.y*scale+'px',width:b.w*scale+'px',height:Math.max(28,b.h*scale)+'px',fontSize:Math.max(14,Math.min(64,b.h*scale*.7))+'px'});host.append(input);input.focus();input.select();
 let done=false;const finish=commit=>{if(done)return;done=true;if(commit){setText(key,input.value);drawInspector();markChanged()}input.remove()};
 input.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();finish(true)}else if(e.key==='Escape'){e.preventDefault();finish(false)}};input.onblur=()=>finish(true);
}
function moveLayer(key,delta){const order=config.layerOrder,i=order.indexOf(key),next=i+delta;if(i<0||next<0||next>=order.length)return;[order[i],order[next]]=[order[next],order[i]];drawLayerList();markChanged()}
function drawLayerList(){const host=$('designLayerList');if(!host)return;host.replaceChildren();
 for(const key of [...config.layerOrder].reverse()){
  const row=document.createElement('div');row.className='design-layer-row'+(key===selected?' selected':'');row.draggable=true;row.dataset.layer=key;
  const label=document.createElement('span');label.textContent=BOX_LABELS[key];label.onclick=()=>select(key);row.append(label);
  for(const [delta,caption] of [[1,'↑'],[-1,'↓']]){const btn=document.createElement('button');btn.type='button';btn.textContent=caption;btn.title=delta>0?'Вперёд':'Назад';btn.onclick=()=>moveLayer(key,delta);row.append(btn)}
  row.ondragstart=e=>{e.dataTransfer.setData('text/plain',key);e.dataTransfer.effectAllowed='move'};
  row.ondragover=e=>e.preventDefault();row.ondrop=e=>{e.preventDefault();const from=e.dataTransfer.getData('text/plain'),order=config.layerOrder;if(!order.includes(from)||from===key)return;const original=order.indexOf(from),target=order.indexOf(key);order.splice(original,1);order.splice(original<target?order.indexOf(key)+1:order.indexOf(key),0,from);drawLayerList();markChanged()};host.append(row);
 }
}
function updateInspectorValues(){for(const input of $('designInspector').querySelectorAll('[data-coord]'))input.value=config.layout[selected][input.dataset.coord];}
function sceneScale(){return clamp(config.overallScale,50,100)/100}
function drawBoxes(){const host=$('designHitLayer'),stage=$('designStage');if(!host||!stage)return;host.style.transform='scale('+sceneScale()+')';host.replaceChildren();const scale=stage.clientWidth/STAGE;
 for(const [key,label] of Object.entries(BOX_LABELS)){
  const b=config.layout[key],node=document.createElement('div');node.className='design-box'+(key===selected?' selected':'');node.dataset.box=key;
  Object.assign(node.style,{left:b.x*scale+'px',top:b.y*scale+'px',width:b.w*scale+'px',height:b.h*scale+'px',zIndex:String(key===selected?100:config.layerOrder.indexOf(key)+1)});
  const caption=document.createElement('span');caption.className='design-label';caption.textContent=label;node.append(caption);
  if(key===selected)for(const edge of EDGES){const handle=document.createElement('span');handle.className='design-handle';handle.dataset.edge=edge;handle.style.left=EDGE_POS[edge][0]+'%';handle.style.top=EDGE_POS[edge][1]+'%';node.append(handle)}
  host.append(node);
 }}
function markChanged(){dirty=true;$('designMsg').textContent='Изменения видны в предпросмотре. Нажми «Применить оформление в эфир» для сохранения.';drawBoxes();queuePreview();}
function queuePreview(){if(paintPending)return;paintPending=true;requestAnimationFrame(()=>{paintPending=false;preview()})}
function preview(){if(!previewConfig||!previewBossId)return;const frame=$('designPreview');if(!frame?.contentWindow)return;
 const enabled=(previewConfig.bonuses||[]).filter(b=>b.enabled!==false);const draft={...previewConfig,overlayStyle:config,bonuses:enabled.length?previewConfig.bonuses:[{id:'preview-bonus',name:'Бонус зрителя',cost:100,enabled:true,icon:''}]};frame.contentWindow.postMessage({bs41:'config',config:draft},location.origin);
 const boss=draft.bosses.find(b=>b.id===previewBossId)||draft.bosses[0];if(!boss)return;
 frame.contentWindow.postMessage({bs41:'battle',data:{kind:'boss-studio4',action:'sync',bossId:boss.id,active:true,maxHp:boss.hp||10000,hp:Math.round((boss.hp||10000)*.65),armor:250,phase:2,leaderboard:[{name:'Зритель',damage:1200}],curseActive:true,guards:1,requiredGuards:3}},location.origin);
}
function startDrag(e){if(e.target.closest('.design-inline-text'))return;const box=e.target.closest('.design-box');if(!box)return;e.preventDefault();const key=box.dataset.box;if(e.detail>=2){openInline(key);return}if(selected!==key)select(key);const edge=e.target.closest('.design-handle')?.dataset.edge||'move';drag={id:e.pointerId,key,edge,x:e.clientX,y:e.clientY,box:{...config.layout[key]}};$('designStage').setPointerCapture(e.pointerId)}
function moveDrag(e){if(!drag||e.pointerId!==drag.id)return;const scale=STAGE/($('designStage').clientWidth*sceneScale()),dx=Math.round((e.clientX-drag.x)*scale),dy=Math.round((e.clientY-drag.y)*scale),b=drag.box;let left=b.x,top=b.y,right=b.x+b.w,bottom=b.y+b.h;
 if(drag.edge==='move'){left=clamp(b.x+dx,0,STAGE-b.w);top=clamp(b.y+dy,0,STAGE-b.h);right=left+b.w;bottom=top+b.h}
 else{if(drag.edge.includes('w'))left=clamp(b.x+dx,0,right-MIN_W);if(drag.edge.includes('e'))right=clamp(b.x+b.w+dx,left+MIN_W,STAGE);if(drag.edge.includes('n'))top=clamp(b.y+dy,0,bottom-MIN_H);if(drag.edge.includes('s'))bottom=clamp(b.y+b.h+dy,top+MIN_H,STAGE)}
 config.layout[drag.key]=boundBox({x:left,y:top,w:right-left,h:bottom-top});updateInspectorValues();markChanged();}
function endDrag(e){if(drag?.id!==e.pointerId)return;drag=null;}
$('designStage').addEventListener('dblclick',e=>{const box=e.target.closest('.design-box');if(box)openInline(box.dataset.box)});$('designStage').addEventListener('pointerdown',startDrag);$('designStage').addEventListener('pointermove',moveDrag);$('designStage').addEventListener('pointerup',endDrag);$('designStage').addEventListener('pointercancel',endDrag);
$('designStage').tabIndex=0;$('designStage').addEventListener('keydown',e=>{const step=e.shiftKey?10:1,delta={ArrowLeft:[-step,0],ArrowRight:[step,0],ArrowUp:[0,-step],ArrowDown:[0,step]}[e.key];if(!delta)return;e.preventDefault();const b=config.layout[selected];config.layout[selected]=boundBox({...b,x:b.x+delta[0],y:b.y+delta[1]});updateInspectorValues();markChanged()});
if(window.ResizeObserver)new ResizeObserver(drawBoxes).observe($('designStage'));else window.addEventListener('resize',drawBoxes);
$('designPreview').addEventListener('load',preview);
$('previewBonusFlash').onclick=()=>{if(!previewConfig||!previewBossId)return;preview();const b=(previewConfig.bonuses||[]).find(x=>x.enabled!==false)||{id:'preview-bonus',name:'Бонус зрителя',icon:''};const boss=previewConfig.bosses.find(x=>x.id===previewBossId);$('designPreview').contentWindow?.postMessage({bs41:'battle',data:{kind:'boss-studio4',action:'bonus',bossId:boss.id,active:true,hp:boss.hp||10000,maxHp:boss.hp||10000,armor:250,phase:1,leaderboard:[],bonusId:b.id,bonusName:b.name,bonusIcon:b.icon,bonusAnimationMs:3000,player:'Тест'}},location.origin)};
async function save(){try{config.fontScale=config.typography.bossName.scale;for(const key of Object.keys(BOX_DEFAULTS))config.layout[key]=boundBox(config.layout[key]);
 const r=await fetch('/api/easy/overlay-style',{method:'POST',headers:{'Content-Type':'application/json','X-Boss-Studio-Token':token},body:JSON.stringify(config)});const j=await r.json();if(!r.ok||!j.ok)throw Error(j.error||'Ошибка');config=normalize(j.style);if(previewConfig)previewConfig.overlayStyle=config;dirty=false;drawInspector();drawLayerList();drawBoxes();preview();$('designMsg').textContent='✓ Оформление сохранено. OBS обновится автоматически.';}catch(e){$('designMsg').textContent='⚠ '+e.message}}
$('saveDesign').onclick=save;
$('resetDesign').onclick=()=>{config=normalize(defaults);draw();markChanged();save()};
(async()=>{try{const status=await(await fetch('/api/easy/status',{cache:'no-store'})).json();token=status.token;
 const [styleResult,liveResult]=await Promise.all([fetch('/api/easy/overlay-style',{cache:'no-store'}),fetch('/api/live-config',{cache:'no-store'})]);
 if(!styleResult.ok||!liveResult.ok)throw Error('База эфира недоступна');config=normalize((await styleResult.json()).style);previewConfig=await liveResult.json();previewBossId=status.live?.bossId||previewConfig.bosses.find(b=>b.enabled)?.id||previewConfig.bosses[0]?.id;
 draw();preview();}catch(e){$('designMsg').textContent='⚠ Не удалось получить предпросмотр: '+e.message;config=normalize(defaults);draw()}})();
})();
