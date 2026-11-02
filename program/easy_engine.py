"""Standalone beginner boss engine. No Streamer.bot Actions/C# required.
Subscribe to documented Streamer.bot Twitch events via local WebSocket.
Game state belongs to this process and is saved locally, never writes Streamer.bot globals.
"""
import base64, collections, hashlib, json, os, random, socket, struct, threading, time, uuid
from datetime import datetime, timezone
from pathlib import Path

SUB_EVENTS={'Twitch':['ChatMessage','Follow','Cheer','Sub','ReSub','GiftSub','GiftBomb','RewardRedemption','StreamOnline','StreamOffline']}

def number(value, default=0):
    try: return float(value)
    except (TypeError,ValueError): return float(default)

def safe_int(v, default=0, low=0, high=10**9):return max(low,min(high,int(number(v,default))))

class EasyGame:
    def __init__(self, storage, config_file):
        self.storage=Path(storage); self.config_file=Path(config_file); self.lock=threading.RLock()
        self.connected=False; self.subscribed=False; self.twitch_connected=False; self.connect_error='Streamer.bot пока не подключён'; self.broadcaster=''; self.ws_port=8080
        self.activity=collections.deque(maxlen=15); self.last_event_at=0; self.last_response='';self.config={}
        self.claim_url='';self.viewer_verify=None;self.chat_status='Ожидание подключения Streamer.bot'
        self.load_config()
        self.sandbox=self._new_state()
        self.live=self._new_state()
        self._load_state()

    def _new_state(self):
        return dict(seq=0, action='sync', bossId='', hp=0,maxHp=1,armor=0,phase=1, active=False,participants={},players={},bossDefeats={}, seen=[],follows=[],lastBoss='',curseActive=False,curseEnds=0,guards=[],hitCount=0,eventTime=0,damage=0,player='',lastHitter='',bonusId='',bonusName='',bonusIcon='',bonusAnimationMs=1500,streamActive=False,streamStartedAt=0,spawnedThisStream=0,queueIndex=0,nextSpawnAt=0,payouts=[],chatOutbox=[])
    def load_config(self):
        try:
            cfg=json.loads(self.config_file.read_text(encoding='utf-8'))
            if isinstance(cfg.get('bosses'),list) and isinstance(cfg.get('economy'),dict):self.config=cfg
        except (OSError,ValueError):pass
    def _load_state(self):
        try:
            previous=json.loads((self.storage/'easy-save.json').read_text(encoding='utf8'))
            if isinstance(previous,dict):
                for k in self.live:
                    if k in previous:self.live[k]=previous[k]
                changed=False
                for job in self.live.get('payouts',[]):
                    if job.get('status') in ('pending','approved'):
                        job['status']='unclaimed';changed=True
                    elif job.get('status')=='sending':
                        job['status']='review'
                        job['error']='Возможна прежняя отправка; проверь баланс MemeAlerts перед закрытием заявки'
                        changed=True
                # Resume effects as a still frame; don't replay death/fade animations.
                self.live['action']='sync'
                legacy_fields=('souls','xp','level','chests','inventory','equipped','memcoins','trophyProgress')
                historical={uid:{k:p[k] for k in legacy_fields if k in p} for uid,p in self.live['players'].items()}
                historical={uid:p for uid,p in historical.items() if p}
                archive=self.storage/'legacy-rewards-before-trophies.json'
                if historical and not archive.exists():
                    archive.write_text(json.dumps(historical,ensure_ascii=False,indent=2),encoding='utf8')
                for p in self.live['players'].values():
                    for field in legacy_fields:p.pop(field,None)
                if historical or changed:self._save()
        except (OSError,ValueError):pass
    def _save(self):
        self.storage.mkdir(parents=True,exist_ok=True)
        dst=self.storage/'easy-save.json';tmp=self.storage/'.easy-save.tmp'
        tmp.write_text(json.dumps(self.live,ensure_ascii=False),encoding='utf8');os.replace(tmp,dst)
    def _economy(self):return self.config.get('economy',{})
    def _schedule(self):return self.config.get('schedule',{})
    def stream_start(self,started_at=None,stream_key=''):
        with self.lock:
            s=self.live
            if s.get('streamActive') and (not stream_key or stream_key==s.get('streamKey')):return self.schedule_status()
            now=int(time.time()*1000);begin=max(0,min(now,int(started_at or now)))
            s.update(streamActive=True,streamStartedAt=begin,streamKey=stream_key,spawnedThisStream=0,queueIndex=0,
                     nextSpawnAt=begin+safe_int(self._schedule().get('firstDelayMin',120),120,0,10080)*60000)
            self._save();self._log('▶ Начат отсчёт появления боссов')
            return self.schedule_status()
    def stream_stop(self):
        with self.lock:
            self.live.update(streamActive=False,nextSpawnAt=0,streamKey='')
            self._save();self._log('■ Расписание трансляции остановлено')
            return self.schedule_status()
    def schedule_updated(self):
        with self.lock:
            s=self.live;setting=self._schedule()
            if s.get('streamActive') and not s.get('spawnedThisStream'):
                s['nextSpawnAt']=s['streamStartedAt']+safe_int(setting.get('firstDelayMin',120),120,0,10080)*60000
            elif s.get('streamActive') and not s['active'] and s.get('spawnedThisStream',0)<safe_int(setting.get('maxBosses',3),3,1,100):
                s['nextSpawnAt']=int(time.time()*1000)+safe_int(setting.get('nextDelayMin',60),60,0,10080)*60000
            self._save()
    def _bonus(self, bid):return next((b for b in self.config.get('bonuses',[]) if b.get('id')==bid and b.get('enabled',True)),None)
    def _boss(self, state):return next((b for b in self.config.get('bosses',[]) if b.get('id')==state['bossId']),None)
    def _profile(self,s,uid,name):
        if uid not in s['players']:s['players'][uid]=dict(name=name,wins=0,totalDamage=0,hitAt=0,magicAt=0,guardAt=0,bonusesAt={},trophies=0,bossTrophies={})
        p=s['players'][uid]
        p['name']=name
        # Preserve historical trophy totals without replaying old local rewards.
        p.setdefault('trophies',0)
        p.setdefault('bossTrophies',{})
        p.setdefault('bonusesAt',{})
        for field in ('hitAt','magicAt','guardAt','totalDamage','wins'):p.setdefault(field,0)
        return p
    def _log(self,text):self.activity.appendleft(str(text)[:160])
    def _mark(self,s,action,who='',dmg=0):
        s['seq']+=1;s.update(action=action,player=who,damage=dmg,eventTime=int(time.time()*1000))
        return self.snapshot_from(s)
    def snapshot_from(self,s):
        lead=sorted(s['participants'].values(),key=lambda p:p['damage'],reverse=True)[:3]
        return dict(kind='boss-studio4',seq=s['seq'],action=s['action'],bossId=s['bossId'],active=s['active'],hp=s['hp'],maxHp=s['maxHp'],armor=s['armor'],phase=s['phase'],damage=s['damage'],player=s['player'],curseActive=s['curseActive'],guards=len(s['guards']),requiredGuards=safe_int(self._economy().get('guardRequired',3)),leaderboard=[{'name':p['name'],'damage':p['damage']}for p in lead],bonusId=s.get('bonusId',''),bonusName=s.get('bonusName',''),bonusIcon=s.get('bonusIcon',''),bonusAnimationMs=s.get('bonusAnimationMs',1500))
    def snapshot(self,mode='live'):
        with self.lock:return self.snapshot_from(self.sandbox if mode=='test' else self.live)
    def status(self):
        with self.lock:return dict(connected=self.connected,subscribed=self.subscribed,twitchConnected=self.twitch_connected,error=self.connect_error,broadcaster=self.broadcaster,bosses=len(self.config.get('bosses',[])),lastEvent=self.last_event_at,activity=list(self.activity),live=self.snapshot_from(self.live),test=self.snapshot_from(self.sandbox),schedule=self.schedule_status(),mode='БЕЗ C#')
    def schedule_status(self):
        s=self.live;return {key:s.get(key) for key in ('streamActive','streamStartedAt','spawnedThisStream','queueIndex','nextSpawnAt')}
    def _pick(self,s):
        bosses=[b for b in self.config.get('bosses',[]) if b.get('enabled',True) and safe_int(b.get('hp',0))>0 and number(b.get('weight',0))>0]
        if not bosses:return None
        weights=[number(b.get('weight',1))*(0.2 if len(bosses)>1 and b['id']==s['lastBoss'] else 1) for b in bosses]
        return random.choices(bosses,weights=weights,k=1)[0]
    def _record(self,s,uid,name,dmg):
        if not uid or uid=='anonymous':return
        p=s['participants'].setdefault(uid,dict(name=name,damage=0));p['damage']+=dmg
        self._profile(s,uid,name)['totalDamage']+=dmg
    def _reward(self,s):
        boss=self._boss(s)
        if not boss:return
        if s is self.live:s['bossDefeats'][boss['id']]=s['bossDefeats'].get(boss['id'],0)+1
        trophy=boss.get('trophy') or {}
        payout=safe_int(trophy.get('memcoins',100),100,1,1000)
        awarded=0
        for uid,pt in s['participants'].items():
            p=self._profile(s,uid,pt['name'])
            p['trophies']+=1
            p['bossTrophies'][boss['id']]=p['bossTrophies'].get(boss['id'],0)+1
            if s is self.live:
                s['payouts'].append(dict(id=uuid.uuid4().hex,twitchId=uid,name=p['name'],bossId=boss['id'],value=payout,status='unclaimed',error=''))
                awarded+=1
                self._log(f'🪙 {p["name"]}: {payout} мемкоинов в ожидании полной коллекции и заявки')
            self._log(f'🏆 {p["name"]}: {trophy.get("name") or boss["name"]}')
            p['wins']+=1
        if awarded and s is self.live and self.claim_url:
            s['chatOutbox'].append(dict(id=uuid.uuid4().hex,status='queued',message=f'🏆 Босс повержен! Трофеи и награды {awarded} участникам. Проверь коллекцию и запроси мемкоины: {self.claim_url}/claim'))
    def _hit(self,s,uid,name,value,what):
        if not s['active']:return self.snapshot_from(s)
        dmg=safe_int(value);block=min(s['armor'],dmg);s['armor']-=block;real=min(s['hp'],dmg-block);s['hp']-=real;total=block+real
        self._record(s,uid,name,total);s['lastHitter']=uid;s['hitCount']=s.get('hitCount',0)+1
        old=s['phase'];e=self._economy()
        if s['hp']<=0:
            s['active']=False;s['curseActive']=False;s['action']='death';self._reward(s);self._log('🏆 Босс повержен!')
            if s is self.live and s.get('streamActive') and self._schedule().get('enabled'):
                setting=self._schedule()
                s['nextSpawnAt']=(int(time.time()*1000)+safe_int(setting.get('nextDelayMin',60),60,0,10080)*60000) if s.get('spawnedThisStream',0)<safe_int(setting.get('maxBosses',3),3,1,100) and s.get('queueIndex',0)<len(setting.get('queue') or []) else 0
        else:
            if s['phase']==1 and s['hp']<=s['maxHp']*number(e.get('phase2Percent',70))/100:
                s['phase']=2;s['armor']+=safe_int(e.get('phase2Armor',900))
            if s['phase']==2 and s['hp']<=s['maxHp']*number(e.get('phase3Percent',30))/100:
                s['phase']=3;s['armor']+=safe_int(e.get('phase3Armor',1400))
            s['action']='phase' if old!=s['phase'] else 'hurt'
            if s['hitCount']%7==0 and not s['curseActive'] and old==s['phase']:
                s['curseActive']=True;s['curseEnds']=int(time.time()*1000)+safe_int(e.get('guardDurationSec',18))*1000;s['guards']=[]
                s['action']='curse';self._log('⚠ Проклятие: чат вводит !щит')
        self._log(f'{name}: {what} — {total} урона')
        return self._mark(s,s['action'],name,total)
    def apply(self,type_,uid='tester',name='Тестовый зритель',amount=1,event_id='',mode='test',boss_id='',command='',bonus_id=''):
        with self.lock:
            s=self.sandbox if mode=='test' else self.live
            e=self._economy();now=int(time.time()*1000)
            if event_id:
                marker=str(type_)+':'+str(event_id)
                if marker in s['seen']:return self.snapshot_from(s)
                s['seen'].append(marker);s['seen']=s['seen'][-600:]
            if type_ != 'bonus':s.update(bonusId='',bonusName='',bonusIcon='',bonusAnimationMs=1500)
            if type_=='reset':
                s.update(active=False, bossId='',hp=0,armor=0,phase=1,curseActive=False,participants={},guards=[])
                if s is self.live and s.get('streamActive') and self._schedule().get('enabled') and s.get('spawnedThisStream',0):
                    setting=self._schedule();s['nextSpawnAt']=now+safe_int(setting.get('nextDelayMin',60),60,0,10080)*60000 if s['spawnedThisStream']<safe_int(setting.get('maxBosses',3),3,1,100) and s.get('queueIndex',0)<len(setting.get('queue') or []) else 0
                result=self._mark(s,'reset',name)
            elif type_=='spawn':
                if s['active']:return self.snapshot_from(s)
                setting=self._schedule()
                if s is self.live and setting.get('enabled') and s.get('streamActive') and s.get('spawnedThisStream',0)>=safe_int(setting.get('maxBosses',3),3,1,100):return self.snapshot_from(s)
                if s is self.live and not boss_id and setting.get('enabled') and s.get('streamActive'):
                    queue=setting.get('queue') or []
                    if s.get('queueIndex',0)>=len(queue):return self.snapshot_from(s)
                    entry=queue[s['queueIndex']]
                    boss_id=entry.get('bossId','') if isinstance(entry,dict) else ''
                boss=next((b for b in self.config.get('bosses',[])if b.get('id')==boss_id and b.get('enabled',True)),None) if boss_id else self._pick(s)
                if not boss:return self.snapshot_from(s)
                s.update(bossId=boss['id'],lastBoss=boss['id'],hp=safe_int(boss['hp']),maxHp=safe_int(boss['hp']),armor=safe_int(boss.get('armor')),phase=1,active=True,curseActive=False,guards=[],hitCount=0,participants={},lastHitter='')
                if s is self.live and setting.get('enabled') and s.get('streamActive'):
                    s['spawnedThisStream']=s.get('spawnedThisStream',0)+1;s['queueIndex']=s.get('queueIndex',0)+1;s['nextSpawnAt']=0
                result=self._mark(s,'spawn',name)
                self._log('⚔ Появился '+boss.get('name','Босс'))
            elif type_=='bonus':
                b=self._bonus(bonus_id)
                if not b or not s['active']:return self.snapshot_from(s)
                p=self._profile(s,uid,name)
                if not isinstance(p.get('bonusesAt'),dict):p['bonusesAt']={}
                last=int(p['bonusesAt'].get(bonus_id,0))
                if now-last<safe_int(b.get('cooldownSec',0),0,0,3600)*1000:return self.snapshot_from(s)
                p['bonusesAt'][bonus_id]=now
                self._record(s,uid,name,0)
                s.update(bonusId=b['id'],bonusName=b['name'],bonusIcon=b.get('icon',''),bonusAnimationMs=safe_int(b.get('animationMs',1600),1600,300,10000))
                strength=safe_int(b.get('value',0),0,0,1000000)
                effect=b.get('effect','damage')
                if effect=='damage':
                    result=self._hit(s,uid,name,strength,b['name'])
                elif effect=='heal':
                    s['hp']=min(s['maxHp'],s['hp']+strength)
                    result=self._mark(s,'bonus',name)
                elif effect=='armor':
                    s['armor']=min(1000000,s['armor']+strength)
                    result=self._mark(s,'bonus',name)
                elif effect=='guard':
                    if s['curseActive'] and uid not in s['guards']:
                        self._record(s,uid,name,0)
                        s['guards'].append(uid)
                        if len(s['guards'])>=safe_int(e.get('guardRequired',3)):
                            s['curseActive']=False
                            result=self._mark(s,'guard_success',name)
                        else:result=self._mark(s,'bonus',name)
                    else:result=self._mark(s,'bonus',name)
                else:return self.snapshot_from(s)
                self._log('✨ '+name+' активировал '+b['name'])
            elif type_=='profile':
                p=self._profile(s,uid,name)
                self._log(f'{name}: трофеи {p["trophies"]}, победы {p["wins"]}. Выплаты MemeAlerts доступны во вкладке трофеев.')
                result=self._mark(s,'sync',name)
            elif type_=='guard':
                if not s['active'] or not s['curseActive']:return self.snapshot_from(s)
                p=self._profile(s,uid,name)
                if uid in s['guards'] or now-p['guardAt']<safe_int(e.get('guardCooldownSec',20))*1000:return self.snapshot_from(s)
                p['guardAt']=now;self._record(s,uid,name,0);s['guards'].append(uid)
                if len(s['guards'])>=safe_int(e.get('guardRequired',3)):
                    s['curseActive']=False;result=self._mark(s,'guard_success',name)
                else:result=self._mark(s,'guard',name)
            elif not s['active']:
                return self.snapshot_from(s)
            elif type_ in ('hit','magic'):
                p=self._profile(s,uid,name); key='hitAt' if type_=='hit' else 'magicAt'
                cooldown=safe_int(e.get('hitCooldownSec' if type_=='hit' else 'magicCooldownSec',25))*1000
                if now-p[key]<cooldown:return self.snapshot_from(s)
                p[key]=now
                result=self._hit(s,uid,name,e.get('hitDamage' if type_=='hit' else 'magicDamage',60),type_)
            elif type_=='follow':
                if not uid or uid=='anonymous' or uid in s['follows']:return self.snapshot_from(s)
                s['follows'].append(uid);s['follows']=s['follows'][-15000:]
                result=self._hit(s,uid,name,e.get('followDamage',80),type_)
            else:
                map_damage=dict(bits=safe_int(amount,0,0,safe_int(e.get('bitsDamageCap',2000)))*safe_int(e.get('bitsDamagePerBit',1)),sub=safe_int(e.get('subDamage',700)),resub=safe_int(e.get('resubDamage',700)),giftsub=safe_int(amount,1,0,safe_int(e.get('giftSubCap',10)))*safe_int(e.get('giftSubDamage',450)),reward=safe_int(e.get('rewardDamage',450)),donation=safe_int(amount,1,0,safe_int(e.get('donationAmountCap',100)))*safe_int(e.get('donationDamagePerUnit',90)))
                if type_ not in map_damage or map_damage[type_]<=0:return self.snapshot_from(s)
                result=self._hit(s,uid,name,map_damage[type_],type_)
            if mode=='live':self._save()
            return result
    def manual_action(self, action, mode='live', boss_id=''):
        """Manual dashboard controls; no fake Twitch viewer or player currency changes.

        Sandbox auto-spawns a copy of the currently live boss (or a random enabled boss).
        Live requires an active boss for combat actions, and never creates a viewer profile.
        """
        allowed={'spawn','reset','hit','bits','follow','sub','reward','phase','death'}
        if mode not in ('live','test') or action not in allowed:
            raise ValueError('Неверная команда управления')
        if action=='death' and mode=='live':
            raise ValueError('Смерть доступна только в тестовом режиме')
        with self.lock:
            s=self.live if mode=='live' else self.sandbox
            if action in ('spawn','reset'):
                chosen=boss_id if boss_id and any(b.get('id')==boss_id and b.get('enabled',True) for b in self.config.get('bosses',[])) else ''
                if action=='spawn' and not chosen and mode=='test' and self.live.get('bossId'):
                    chosen=self.live['bossId']
                return self.apply(action, uid='anonymous', name='Управление',mode=mode,boss_id=chosen)
            if not s['active']:
                if mode=='live':raise ValueError('Сначала нажми «Запустить босса» в управлении эфиром')
                current=self.live['bossId'] if self.live.get('bossId') else ''
                self.apply('spawn',uid='anonymous',name='Тест',mode='test',boss_id=current)
                if not s['active']:raise ValueError('Нет доступного босса — выбери его в редакторе')
            e=self._economy()
            if action=='phase':
                if s['phase']>=3:raise ValueError('Босс уже в третьей фазе')
                s['phase']+=1
                pct=number(e.get('phase2Percent',70) if s['phase']==2 else e.get('phase3Percent',30))
                s['hp']=min(s['hp'],max(1,int(s['maxHp']*pct/100)))
                s['armor']+=safe_int(e.get('phase2Armor',900) if s['phase']==2 else e.get('phase3Armor',1400))
                s['curseActive']=False
                result=self._mark(s,'phase','Управление')
            elif action=='death':
                s.update(hp=0,active=False,curseActive=False)
                result=self._mark(s,'death','Тест')
            else:
                damages={
                  'hit':safe_int(e.get('hitDamage',60)),
                  'bits':min(100,safe_int(e.get('bitsDamageCap',2000)))*safe_int(e.get('bitsDamagePerBit',1)),
                  'follow':safe_int(e.get('followDamage',80)),
                  'sub':safe_int(e.get('subDamage',700)),
                  'reward':safe_int(e.get('rewardDamage',450)),
                }
                # Administrator checks affect boss HP but never add a fake user to leaderboard.
                # If an admin demo kills the boss, do not attribute last hit to another viewer.
                previous_hitter=s.get('lastHitter','')
                result=self._hit(s,'anonymous','Ручная проверка',damages[action],action)
                if s['active']:
                    s['lastHitter']=previous_hitter
            self._log(('📺 Эфир: ' if mode=='live' else '🧪 Тест: ')+action)
            if mode=='live':self._save()
            return result

    def tick(self):
        with self.lock:
            s=self.live;setting=self._schedule();now=int(time.time()*1000)
            if setting.get('enabled') and s.get('streamActive') and not s['active'] and s.get('nextSpawnAt',0) and now>=s['nextSpawnAt'] and s.get('spawnedThisStream',0)<safe_int(setting.get('maxBosses',3),3,1,100):
                previous=s['seq'];self.apply('spawn',uid='anonymous',name='Расписание',mode='live')
                if s['seq']==previous:s['nextSpawnAt']=0;self._save();self._log('⚠ В очереди нет доступного босса')
            for s in (self.live,self.sandbox):
                if s['curseActive'] and s['active'] and time.time()*1000>=s['curseEnds']:
                    s['curseActive']=False;s['hp']=min(s['maxHp'],s['hp']+int(s['maxHp']*safe_int(self._economy().get('guardHealPercent',4))/100));self._mark(s,'sync');self._log('☠ Проклятие не отражено')
                    if s is self.live:self._save()
    def handle_twitch(self,message):
        event=message.get('event') or {};t=event.get('type');data=message.get('data') or {}
        if event.get('source','').lower()!='twitch':return
        self.last_event_at=int(time.time())
        # Ignore events explicitly flagged as simulated by Streamer.bot,
        # keeping the live economy separate from its built-in event tester.
        if data.get('isTest') is True:return
        if t=='StreamOnline':
            start=data.get('startedAt');begin=None
            if isinstance(start,str):
                try:begin=int(datetime.fromisoformat(start.replace('Z','+00:00')).timestamp()*1000)
                except ValueError:pass
            self.stream_start(begin,str(data.get('id') or ''));return
        if t=='StreamOffline':self.stream_stop();return
        if t=='ChatMessage':
            user=data.get('user') or {};uid=str(user.get('id',''));name=user.get('name') or user.get('login') or 'Зритель'
            txt=(data.get('text') or '').strip().lower();eid=data.get('messageId','')
            if txt.startswith('!профиль '):
                code=txt.split(' ',1)[1].strip()
                try:
                    if self.viewer_verify:
                        result=self.viewer_verify(code,uid,name)
                        with self.lock:
                            self._log('✓ '+result)
                except Exception as exc:self._log('⚠ Заявка '+name+': '+str(exc)[:100])
                return
            if txt in ('!босс','!боссгарант','!босссброс'):
                is_broadcaster=bool(data.get('broadcaster') and str((data['broadcaster'] or {}).get('id',''))==uid) or (self.broadcaster and str(user.get('login','')).lower()==self.broadcaster.lower())
                if is_broadcaster:self.apply('reset' if txt=='!босссброс' else 'spawn',uid,name,mode='live',event_id=eid)
            elif txt in ('!удар','!магия','!щит','!профиль'):
                self.apply({'!удар':'hit','!магия':'magic','!щит':'guard','!профиль':'profile'}[txt],uid,name,mode='live',event_id=eid)
            else:
                for bonus in self.config.get('bonuses',[]):
                    cmd=str(bonus.get('command','')).strip().casefold()
                    if bonus.get('enabled',True) and cmd and txt==cmd:
                        self.apply('bonus',uid,name,mode='live',event_id=eid,bonus_id=bonus['id'])
                        break
            return
        u=data.get('user') or data.get('gifter') or data.get('targetUser') or {}
        uid=str(u.get('id') or data.get('userId') or data.get('fromId') or '')
        name=str(u.get('name') or u.get('login') or data.get('userName') or 'Зритель')
        eid=str(data.get('id') or data.get('messageId') or data.get('eventId') or '')
        amounts={'Cheer':('bits',data.get('bits',0)), 'Follow':('follow',1), 'Sub':('sub',1), 'ReSub':('resub',1), 'GiftSub':('giftsub',1),'GiftBomb':('giftsub',data.get('total') or data.get('giftCount') or data.get('count') or 1),'RewardRedemption':('reward',1)}
        if t in amounts:
            # A community gift is counted by GiftBomb. Its individual GiftSub events
            # are skipped to avoid applying both the group and individual damage.
            if t=='GiftSub' and data.get('fromCommunitySubGift'):
                return
            typ,amt=amounts[t]
            if t=='RewardRedemption':
                reward=data.get('reward') or {}
                title=str(reward.get('title') or data.get('rewardName') or '').strip().casefold()
                reward_id=str(reward.get('id') or '')
                rid=str(data.get('redemptionId') or eid)
                for bonus in self.config.get('bonuses',[]):
                    if not bonus.get('enabled',True):continue
                    expected=str(bonus.get('rewardTitle') or bonus.get('name','')).strip().casefold()
                    expected_id=str(bonus.get('rewardId') or '')
                    match=bool(expected_id and reward_id==expected_id) or bool(expected and title==expected)
                    if match:
                        self.apply('bonus',uid or 'anonymous',name,event_id=rid,mode='live',bonus_id=bonus['id'])
                        return
                return  # never damage the boss for an unrelated channel-point redemption
            self.apply(typ,uid or 'anonymous',name,amt,event_id=eid,mode='live')

class WSClient:
    def __init__(self,game,host='127.0.0.1',port=8080,password_provider=None):self.game=game;self.host=host;self.port=port;self.stop=False;self.password_provider=password_provider or (lambda:'')
    @staticmethod
    def authentication(password,salt,challenge):
        secret=base64.b64encode(hashlib.sha256((password+salt).encode('utf8')).digest()).decode('ascii')
        return base64.b64encode(hashlib.sha256((secret+challenge).encode('utf8')).digest()).decode('ascii')
    def send_chat_pending(self,sock,authenticated):
        if not authenticated:return
        with self.game.lock:
            entry=next((x for x in self.game.live.get('chatOutbox',[]) if x.get('status')=='queued'),None)
            if not entry:return
            entry['status']='sending';self.game._save()
            request={'request':'SendMessage','id':'chat-'+entry['id'],'platform':'twitch','bot':False,'internal':False,'message':entry['message']}
        sock.sendall(self.frame(json.dumps(request,ensure_ascii=False)))
    @staticmethod
    def frame(payload, opcode=1):
        if isinstance(payload,str):payload=payload.encode('utf8')
        size=len(payload);header=bytearray([0x80|opcode]);mask=os.urandom(4)
        if size<126:header.append(0x80|size)
        elif size<65536:header.append(0x80|126);header+=struct.pack('!H',size)
        else:header.append(0x80|127);header+=struct.pack('!Q',size)
        header+=mask
        return bytes(header)+bytes(b^mask[i%4] for i,b in enumerate(payload))
    @staticmethod
    def recv_frame(sock):
        def exact(n):
            result=b''
            while len(result)<n:
                chunk=sock.recv(n-len(result))
                if not chunk:raise ConnectionError('WebSocket закрыт')
                result+=chunk
            return result
        h=exact(2);op=h[0]&15;n=h[1]&127;masked=bool(h[1]&128)
        if n==126:n=struct.unpack('!H',exact(2))[0]
        elif n==127:n=struct.unpack('!Q',exact(8))[0]
        if n>5_000_000:raise ConnectionError('Слишком большое событие')
        mask=exact(4) if masked else None;data=exact(n)
        if mask:data=bytes(c^mask[i%4] for i,c in enumerate(data))
        return op,data
    def once(self):
        with socket.create_connection((self.host,self.port),timeout=3) as s:
            s.settimeout(2)
            key=base64.b64encode(os.urandom(16)).decode('ascii')
            req=f'GET / HTTP/1.1\r\nHost: {self.host}:{self.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: {key}\r\n\r\n'
            s.sendall(req.encode('ascii'))
            response=b''
            while b'\r\n\r\n' not in response:
                response+=s.recv(1)
                if len(response)>16_384:raise ConnectionError('Неверный WebSocket ответ')
            headers,extra=response.split(b'\r\n\r\n',1)
            if b' 101 ' not in headers.split(b'\r\n')[0]:raise ConnectionError('Включи WebSocket Server без пароля в Streamer.bot')
            expected=base64.b64encode(hashlib.sha1((key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
            if ('Sec-WebSocket-Accept: '+expected).lower().encode() not in headers.lower():raise ConnectionError('Неверный ответ Streamer.bot')
            # Handshake was read one byte at a time, so no event bytes are lost.
            s.sendall(self.frame(json.dumps({'request':'Subscribe','id':'easy-sub','events':SUB_EVENTS})))
            s.sendall(self.frame(json.dumps({'request':'GetBroadcaster','id':'easy-broadcaster'})))
            self.game.connected=True;self.game.subscribed=False;self.game.twitch_connected=False;self.game.broadcaster='';self.game.connect_error=''
            self.game._log('● Streamer.bot подключён')
            with self.game.lock:
                for entry in self.game.live.get('chatOutbox',[]):
                    if entry.get('status')=='sending':entry['status']='queued'
                self.game._save()
            authenticated=False;last_ping=time.time();auth_challenge=None;last_auth_password=None
            while not self.stop:
                try:op,data=self.recv_frame(s)
                except socket.timeout:
                    if time.time()-last_ping>15:s.sendall(self.frame(b'keepalive',opcode=9));last_ping=time.time()
                    password=self.password_provider()
                    if auth_challenge and password and password!=last_auth_password and not authenticated:
                        s.sendall(self.frame(json.dumps({'request':'Authenticate','id':'easy-auth','authentication':self.authentication(password,auth_challenge['salt'],auth_challenge['challenge'])})))
                        last_auth_password=password
                    self.send_chat_pending(s,authenticated);continue
                if op==8:raise ConnectionError('Streamer.bot отключился')
                if op==9:s.sendall(self.frame(data,opcode=10));continue
                if op!=1:continue
                try:msg=json.loads(data.decode('utf8'))
                except (ValueError,UnicodeDecodeError):continue
                if msg.get('request')=='Hello':
                    challenge=msg.get('authentication') or {}
                    if challenge.get('salt') and challenge.get('challenge'):
                        auth_challenge=challenge
                        password=self.password_provider()
                        if password:
                            s.sendall(self.frame(json.dumps({'request':'Authenticate','id':'easy-auth','authentication':self.authentication(password,challenge['salt'],challenge['challenge'])})))
                            last_auth_password=password
                        else:self.game.chat_status='Для отправки ссылки задай пароль WebSocket Streamer.bot в редакторе'
                    else:self.game.chat_status='Включи Authentication и пароль в WebSocket Server Streamer.bot для отправки ссылки'
                elif msg.get('id')=='easy-auth':
                    authenticated=msg.get('status')=='ok'
                    self.game.chat_status='✓ Отправка ссылок в Twitch-чат готова' if authenticated else '⚠ Пароль WebSocket Streamer.bot не подошёл'
                elif str(msg.get('id','')).startswith('chat-'):
                    with self.game.lock:
                        entry=next((x for x in self.game.live.get('chatOutbox',[]) if 'chat-'+x['id']==msg['id']),None)
                        if entry:
                            entry['status']='sent' if msg.get('status')=='ok' else 'failed';self.game._save()
                            self.game.chat_status='✓ Ссылка на награду отправлена в чат' if entry['status']=='sent' else '⚠ Streamer.bot отклонил отправку ссылки: '+str(msg.get('error',''))[:90]
                elif msg.get('id')=='easy-broadcaster':
                    info=((msg.get('platforms') or {}).get('twitch') or {})
                    self.game.broadcaster=info.get('broadcastUserName') or info.get('broadcastUser') or ''
                    self.game.twitch_connected=bool(self.game.broadcaster or 'twitch' in (msg.get('connected') or []))
                elif msg.get('id')=='easy-sub':
                    if msg.get('status')=='error':raise ConnectionError('Streamer.bot отказал в подписке на события')
                    self.game.subscribed=msg.get('status')=='ok'
                elif msg.get('event'):self.game.handle_twitch(msg)
                self.send_chat_pending(s,authenticated)
    def run(self):
        while not self.stop:
            try:self.once()
            except Exception as exc:
                self.game.connected=False;self.game.subscribed=False;self.game.twitch_connected=False;self.game.connect_error=str(exc)[:150]
                self.game.chat_status='⚠ Streamer.bot отключён: ссылка в чате ожидает подключения'
            for _ in range(30):
                if self.stop:break
                time.sleep(0.1)

def periodic(game):
    while True:
        try:game.tick()
        except Exception:pass
        time.sleep(0.5)
