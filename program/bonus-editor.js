(()=>{'use strict';
const $=id=>document.getElementById(id), base='/api/easy/';
let token='',bonuses=[],current=null;
const defaults=[
{id:'strong_strike',name:'Мощный удар',rewardTitle:'Мощный удар',command:'',effect:'damage',value:450,cost:300,cooldownSec:0,animationMs:1700,iconSize:72,icon:'',enabled:true},
{id:'dark_magic',name:'Теневая магия',rewardTitle:'Теневая магия',command:'',effect:'damage',value:850,cost:650,cooldownSec:0,animationMs:2200,iconSize:80,icon:'',enabled:true},
{id:'protect_chat',name:'Защитить чат',rewardTitle:'Защитить чат',command:'',effect:'guard',value:1,cost:180,cooldownSec:0,animationMs:1600,iconSize:64,icon:'',enabled:false}
];
const names={damage:'⚔ Урон боссу',heal:'💚 Лечение босса',armor:'🛡 Броня боссу',guard:'🛡 Защитить от проклятия'};
function escape(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function msg(t,bad=false){$('bonusMsg').textContent=t;$('bonusMsg').style.color=bad?'#ffacac':'#b9ffd3'}
async function post(path,payload,raw=false,headers={}){
 const h={'X-Boss-Studio-Token':token,'Content-Type':raw?'image/png':'application/json',...headers};
 const r=await fetch(base+path,{method:'POST',headers:h,body:raw?payload:JSON.stringify(payload)});
 const data=await r.json();if(!r.ok||!data.ok)throw Error(data.error||'Ошибка сохранения');return data;
}
function card(){const b=bonuses.find(x=>x.id===current);return b||null}
function renderList(){
 $('bonusList').innerHTML=bonuses.map(b=>`<button class="bonus-item ${b.id===current?'on':''}" data-bid="${escape(b.id)}">${b.icon?`<img class="bonus-icon" alt="" src="/live/${escape(b.icon)}?v=${Date.now()}">`:`<span class="bonus-icon" style="display:grid;place-items:center;font-size:25px">✨</span>`}<span><strong>${escape(b.name)}</strong><br><small>${escape(names[b.effect]||b.effect)} · ${b.cost} баллов</small></span></button>`).join('');
 $('bonusList').querySelectorAll('[data-bid]').forEach(x=>x.addEventListener('click',()=>{current=x.dataset.bid;render()}));
}
function range(key,label,min,max,step=1,suffix=''){
 const b=card();return `<div class="bonus-field"><label for="bb_${key}">${label}<output id="out_${key}">${b[key]}${suffix}</output></label><input id="bb_${key}" type="range" min="${min}" max="${max}" step="${step}" value="${b[key]}"></div>`;
}
function renderFields(){const b=card();if(!b){$('bonusFields').innerHTML='<p>Нажми «+ Новый бонус»</p>';return}
 $('bonusFields').innerHTML=`<div class="bonus-fields">
 <div class="bonus-field"><label>Название для OBS</label><input id="bb_name" maxlength="60" value="${escape(b.name)}"></div>
 <div class="bonus-field"><label>Название кнопки Twitch (точно такое же)</label><input id="bb_rewardTitle" maxlength="45" value="${escape(b.rewardTitle)}"></div>
 <div class="bonus-field"><label>Что делает бонус?</label><select id="bb_effect">${Object.entries(names).map(([v,n])=>`<option value="${v}" ${b.effect===v?'selected':''}>${n}</option>`).join('')}</select></div>
 <div class="bonus-field"><label>Команда чата (необязательно)</label><input id="bb_command" placeholder="Можно оставить пустым" value="${escape(b.command)}"></div>
 ${range('value','Сила бонуса',1,2500,1,'')}
 ${range('cost','Цена в баллах Twitch',1,10000,1,'')}
 ${range('cooldownSec','Перезарядка',0,300,5,' сек')}
 ${range('animationMs','Длительность анимации',300,6000,100,' мс')}
 ${range('iconSize','Размер значка',24,140,2,' px')}
 <div class="bonus-field"><label><input type="checkbox" id="bb_enabled" ${b.enabled?'checked':''}> Бонус включён</label></div></div>
 <div class="bonus-preview">${b.icon?`<img class="bonus-icon" id="bonusImage" alt="Значок бонуса" style="width:${b.iconSize}px;height:${b.iconSize}px" src="/live/${escape(b.icon)}?v=${Date.now()}">`:`<span class="bonus-icon" id="bonusImage" style="width:${b.iconSize}px;height:${b.iconSize}px;display:grid;place-items:center;font-size:30px">✨</span>`}<div><strong>${escape(b.name)}</strong><p class="bonus-very-small" style="margin:3px 0 10px">Загрузи PNG или GIF до 5 МБ</p><label class="btn btn-sm" style="cursor:pointer;display:inline-block;margin:0">↑ Выбрать PNG/GIF<input id="bonusFile" type="file" accept="image/png,image/gif,.png,.gif" hidden></label><p id="bonusUploadMsg" class="bonus-very-small"></p></div></div>
 <div class="help">Стоимость и время ожидания на Twitch нужно выставить такими же, как здесь. <button id="copyBonusName" class="btn-sm">Скопировать название для Twitch</button></div>`;
 for(const key of ['name','rewardTitle','command','effect'])$('bb_'+key).addEventListener('input',e=>{b[key]=e.target.value;if(key==='name')renderList()});
 for(const key of ['value','cost','cooldownSec','animationMs','iconSize'])$('bb_'+key).addEventListener('input',e=>{b[key]=+e.target.value;$('out_'+key).textContent=b[key]+({cooldownSec:' сек',animationMs:' мс',iconSize:' px'}[key]||'');if(key==='iconSize')$('bonusImage').style.width=b[key]+'px'});
 $('bb_enabled').addEventListener('change',e=>b.enabled=e.target.checked);
 $('bonusFile').addEventListener('change',upload);
 $('copyBonusName').onclick=()=>{navigator.clipboard.writeText(b.rewardTitle).then(()=>msg('Название для награды Twitch скопировано.')).catch(()=>msg('Выдели название и скопируй Ctrl+C.',true))};
}
function render(){renderList();renderFields()}
function fresh(){let n=1;while(bonuses.some(b=>b.id==='bonus_'+n))n++;return {id:'bonus_'+n,name:'Новый бонус '+n,rewardTitle:'Бонус '+n,command:'',effect:'damage',value:450,cost:300,cooldownSec:0,animationMs:1600,iconSize:68,icon:'',enabled:true}}
async function upload(e){const b=card(),file=e.target.files?.[0];if(!b||!file)return;
 if(file.size>5*1024*1024){msg('Файл больше 5 МБ',true);return}const ext=file.name.toLowerCase().split('.').pop();if(!['png','gif'].includes(ext)){msg('Нужен PNG или GIF',true);return}
 try{const r=await post('bonus-icon',await file.arrayBuffer(),true,{'Content-Type':ext==='gif'?'image/gif':'image/png','X-Bonus-Id':b.id});b.icon=r.icon;renderFields();msg('✓ Значок загружен. Нажми «Сохранить в эфир».')}catch(err){msg(err.message,true)}
}
async function save(){try{const r=await post('bonuses',{bonuses});msg('✓ Сохранено: '+r.count+' бонусов. OBS обновится автоматически.');render()}catch(e){msg('⚠ '+e.message,true)}}
async function test(mode){const b=card();if(!b)return;try{await save();const old=await (await fetch(base+(mode==='test'?'test-state':'state'))).json();const result=await post('action',{type:'bonus',bonusId:b.id,mode,user:mode==='test'?'Тест бонуса':'Стример',userId:'demo_'+b.id});if(!result.state.active&&old.seq===result.state.seq)throw Error('Сначала запусти босса в режиме '+(mode==='test'?'проверки':'эфира'));
 if(old.seq===result.state.seq)throw Error('Бонус не сработал: проверь, включён ли он и завершилась ли перезарядка.');
 msg('✓ '+b.name+' · осталось HP '+result.state.hp+' / '+result.state.maxHp+'. Открой окно OBS для просмотра анимации.');}catch(e){msg('⚠ '+e.message,true)}}
async function load(){try{const info=await (await fetch(base+'status')).json();token=info.token;
 const r=await (await fetch(base+'bonuses',{cache:'no-store'})).json();bonuses=r.bonuses?.length?r.bonuses:structuredClone(defaults);current=bonuses[0]?.id;render();if(!r.bonuses?.length)msg('Есть 3 примера. Отредактируй их и нажми «Сохранить в эфир».');
 }catch(e){msg('Ошибка подключения: '+e.message,true)}}
$('addBonus').onclick=()=>{if(bonuses.length>=30)return msg('Максимум 30 бонусов',true);const b=fresh();bonuses.push(b);current=b.id;render();msg('Создан новый бонус. Настрой и сохрани.')};
$('deleteBonus').onclick=()=>{const b=card();if(!b)return;if(!confirm('Удалить «'+b.name+'» из списка бонусов?'))return;bonuses=bonuses.filter(x=>x!==b);current=bonuses[0]?.id||null;render();msg('Бонус удалён из редактора. Нажми «Сохранить в эфир».')};
$('saveBonuses').onclick=save;$('tryBonus').onclick=()=>test('test');$('liveBonus').onclick=()=>{if(confirm('Применить бонус к НАСТОЯЩЕМУ боссу на стриме?'))test('live')};
load();
})();
