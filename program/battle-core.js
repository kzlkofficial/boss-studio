/* Boss Studio 4.1 offline battle simulator. NO Twitch or Streamer.bot writes. */
(function (root, factory) { const api=factory(); if(typeof module==='object'&&module.exports)module.exports=api; else root.BattleCore=api; })(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const cap=(v,a,b)=>Math.max(a,Math.min(b,Number(v)||0));
const slots=['idle','attack','hurt','phase_change','phase_2','phase_3','death'];
function randomSeeded(seed=123456789){let s=(Number(seed)>>>0)||123456789;return ()=>{s=(Math.imul(1664525,s)+1013904223)>>>0;return s/4294967296;};}
function pickBoss(cfg,last,rand){const b=(cfg.bosses||[]).filter(x=>x.enabled&&x.hp>0&&x.weight>0);if(!b.length)return null;let sum=b.reduce((s,x)=>s+x.weight*(b.length>1&&x.id===last?.2:1),0),r=rand()*sum;for(let x of b){r-=x.weight*(b.length>1&&x.id===last?.2:1);if(r<0)return x;}return b.at(-1)}
function make(cfg,seed){return {cfg,rand:randomSeeded(seed),time:0,active:false,bossId:null,hp:0,maxHp:1,armor:0,phase:1,hitCount:0,curseActive:false,curseEnds:0,guards:0,guardIds:[],lastBoss:null,participants:{},players:{},seenEvents:new Set(),seenFollow:new Set(),log:[],seq:0};}
function getPlayer(s,id,name){id=String(id||name||'tester');if(!s.players[id])s.players[id]={id,name:name||id,totalDamage:0,wins:0,trophies:0,bossTrophies:{},lastHit:-1e9,lastMagic:-1e9,lastGuard:-1e9};s.players[id].name=name||id;return s.players[id]}
function line(s,msg){s.log.unshift({step:++s.seq,ms:s.time,text:msg});s.log=s.log.slice(0,120);return msg;}
function recordDamage(s,id,name,credited){if(!s.participants[id])s.participants[id]={id,name,damage:0};s.participants[id].damage+=credited;s.participants[id].name=name;getPlayer(s,id,name).totalDamage+=credited;}
function rewardVictory(s){const trophy=s.cfg.bosses.find(b=>b.id===s.bossId)?.trophy||{};for(const pt of Object.values(s.participants)){const p=getPlayer(s,pt.id,pt.name);p.trophies++;p.wins++;p.bossTrophies[s.bossId]=(p.bossTrophies[s.bossId]||0)+1;line(s,`🏆 ${p.name}: ${trophy.name||s.bossId} · ${trophy.memcoins||0} мемкоинов после сбора коллекции`);}}
function phase(s){const e=s.cfg.economy;let old=s.phase; if(s.phase===1&&s.hp<=Math.floor(s.maxHp*e.phase2Percent/100)){s.phase=2;s.armor+=e.phase2Armor;}if(s.phase===2&&s.hp<=Math.floor(s.maxHp*e.phase3Percent/100)){s.phase=3;s.armor+=e.phase3Armor;}return s.phase!==old;}
function hit(s,id,name,damage,type){if(!s.active)return {ok:false,reason:'Босс ещё не появился',action:'none'};let absorb=Math.min(s.armor,Math.max(0,damage));s.armor-=absorb;let actual=Math.min(s.hp,Math.max(0,damage-absorb));s.hp-=actual;let credit=absorb+actual;recordDamage(s,id,name,credit);s.hitCount++;let action='hurt';let changed=false;
 if(s.hp<=0){s.active=false;s.curseActive=false;action='death';rewardVictory(s,id);line(s,'🏆 Босс повержен!');}
 else {changed=phase(s);if(changed){action='phase';line(s,`⚡ Началась фаза ${s.phase}`);}else if(s.hitCount%7===0&&!s.curseActive){s.curseActive=true;s.curseEnds=s.time+s.cfg.economy.guardDurationSec*1000;s.guards=0;s.guardIds=[];action='curse';line(s,'⚠ Проклятие: требуются щиты');}}
 line(s,`${name}: ${type} — ${credit} урона`);return {ok:true,action,damage:credit,changedPhase:changed};}
function apply(s,ev){const e=s.cfg.economy,t=ev.type,id=String(ev.userId||ev.user||'viewer'),name=ev.user||'Зритель',value=Number(ev.amount||0);let res={ok:true,action:'sync',damage:0};
 if(ev.eventId){let key=t+':'+ev.eventId;if(s.seenEvents.has(key))return {ok:false,reason:'Повторное событие',action:'none'};s.seenEvents.add(key);}
 if(t==='reset'){s.active=false;s.hp=0;s.armor=0;s.participants={};s.curseActive=false;line(s,'Бой сброшен');return {ok:true,action:'reset'};}
 if(t==='spawn'){if(s.active)return {ok:false,reason:'Босс уже активен',action:'none'};let b=ev.bossId?s.cfg.bosses.find(b=>b.id===ev.bossId&&b.enabled):pickBoss(s.cfg,s.lastBoss,s.rand);if(!b)return {ok:false,reason:'Нет доступных боссов',action:'none'};s.bossId=b.id;s.lastBoss=b.id;s.hp=s.maxHp=b.hp;s.armor=b.armor;s.phase=1;s.hitCount=0;s.curseActive=false;s.guards=0;s.guardIds=[];s.participants={};s.active=true;line(s,'⚔ Появился '+b.name);return {ok:true,action:'spawn'};}
 if(t==='tick'){s.time+=Math.max(0,value)*1000;if(s.curseActive&&s.time>=s.curseEnds){s.curseActive=false;s.hp=Math.min(s.maxHp,s.hp+Math.floor(s.maxHp*e.guardHealPercent/100));line(s,'☠ Защита не удалась: босс восстановил HP');return {ok:true,action:'curse_fail'};}return {ok:true,action:'sync'};}
 if(!s.active)return {ok:false,reason:'Босс не активен',action:'none'};
 const p=getPlayer(s,id,name);
 if(t==='guard'){if(!s.curseActive)return {ok:false,reason:'Проклятие не активно',action:'none'};if(s.time-p.lastGuard<e.guardCooldownSec*1000||s.guardIds.includes(id))return {ok:false,reason:'Щит на перезарядке или уже учтён',action:'none'};p.lastGuard=s.time;s.guardIds.push(id);s.guards++;if(!s.participants[id])s.participants[id]={id,name,damage:0};if(s.guards>=e.guardRequired){s.curseActive=false;line(s,'🛡 Чат отразил проклятие');return {ok:true,action:'guard_success'};}return {ok:true,action:'guard'};}
 if(t==='hit'||t==='magic'){let last=t==='hit'?p.lastHit:p.lastMagic,cd=t==='hit'?e.hitCooldownSec:e.magicCooldownSec;if(s.time-last<cd*1000)return {ok:false,reason:'Перезарядка',action:'none'};if(t==='magic')p.lastMagic=s.time;else p.lastHit=s.time;return hit(s,id,name,t==='hit'?e.hitDamage:e.magicDamage,t);}
 if(t==='follow'){if(s.seenFollow.has(id))return {ok:false,reason:'Фоллов уже учтён',action:'none'};s.seenFollow.add(id);return hit(s,id,name,Math.max(0,e.followDamage),'follow');}
 const ext={bits:Math.min(Math.max(0,value),e.bitsDamageCap)*e.bitsDamagePerBit,sub:e.subDamage,resub:e.resubDamage,giftsub:Math.min(Math.max(0,value),e.giftSubCap)*e.giftSubDamage,donation:Math.min(Math.max(0,value),e.donationAmountCap)*e.donationDamagePerUnit,reward:e.rewardDamage};
 if(Object.prototype.hasOwnProperty.call(ext,t)){const dmg=Math.max(0,Math.floor(ext[t]));if(!dmg)return {ok:false,reason:'Нулевое значение события',action:'none'};return hit(s,id,name,dmg,t);}
 return {ok:false,reason:'Неизвестный тип события',action:'none'};
}
function snapshot(s,result){const b=s.cfg.bosses.find(b=>b.id===s.bossId);return {kind:'boss-studio4',action:result.action||'sync',active:s.active,bossId:s.bossId,bossName:b?.name||'',hp:s.hp,maxHp:s.maxHp,armor:s.armor,phase:s.phase,damage:result.damage||0,player:result.player||'Тестер',curseActive:s.curseActive,guards:s.guards,requiredGuards:s.cfg.economy.guardRequired,leaderboard:Object.values(s.participants).sort((a,b)=>b.damage-a.damage).slice(0,3).map(x=>({name:x.name,damage:x.damage}))};}
return {make,apply,snapshot,pickBoss,slots,randomSeeded};
});
