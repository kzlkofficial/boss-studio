#!/usr/bin/env python3
# Boss Studio 4.3 Local Bridge, Python 3.9+ stdlib only.
# All writes are restricted to ~/Documents/BossStudio4; bind only to 127.0.0.1.
import hashlib
import html
import io
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs
import zipfile
from easy_engine import EasyGame, WSClient, periodic
from viewer_rewards import ViewerRewards, RewardError

HOST = '127.0.0.1'
PORT = int(os.environ.get('BOSS_STUDIO_PORT', '8765'))
PUBLIC_PORT = int(os.environ.get('BOSS_STUDIO_PUBLIC_PORT', '8766'))
ROOT = Path(__file__).resolve().parent

def urllib_parse_query(path):return parse_qs(urlsplit(path).query)

def user_documents():
    # Match C# Environment.SpecialFolder.MyDocuments even if OneDrive moved Documents.
    if os.name == 'nt':
        try:
            import ctypes
            buf = ctypes.create_unicode_buffer(32768)
            # CSIDL_PERSONAL, current user, SHGFP_TYPE_CURRENT
            if ctypes.windll.shell32.SHGetFolderPathW(None, 5, None, 0, buf) == 0 and buf.value:
                return Path(buf.value)
        except (OSError, AttributeError, ValueError):
            pass
    return Path.home() / 'Documents'
USER_DIR = Path(os.environ.get('BOSS_STUDIO_DATA', str(user_documents() / 'BossStudio4'))).resolve()
LIVE = USER_DIR / 'live'
CONFIG = USER_DIR / 'boss-config.json'
TOKEN = secrets.token_urlsafe(24)
GUARD = threading.RLock()
MAX_BYTES = 125 * 1024 * 1024
MAX_SINGLE = 30 * 1024 * 1024
REQUIRED = {'boss-config.json', 'boss-config.js', 'overlay.html'}
ASSET = re.compile(r'^assets/[A-Za-z0-9_/-]+\.(?:png|gif)$')
ID = re.compile(r'^[a-z0-9][a-z0-9_-]{1,47}$')
STATIC = {'design-editor.js', 'visual-editor.js', 'bonus-editor.js', 'meme-editor.js', 'reward-queue.js', 'easy.html', 'BossStudio43_EDITOR.html', 'studio42.js', 'sync43.js', 'boss-config.js', 'battle-core.js', 'zip-store.js', 'assets-embedded.js', 'package-templates.js', 'overlay.html', 'README_RU.md'}

BONUS_ID = re.compile(r'^[a-z][a-z0-9_-]{1,39}$')
BONUS_EFFECTS = {'damage','heal','armor','guard'}

class DeployError(Exception):
    pass

GAME = None
REWARDS = ViewerRewards(USER_DIR)

def _init_game():
    global GAME
    if not CONFIG.exists():
        # First run: seed the two example bosses (without affecting any existing project).
        buffer=io.BytesIO()
        with zipfile.ZipFile(buffer,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=3) as z:
            for name in ('boss-config.json','boss-config.js','overlay.html'):
                z.write(ROOT/name,name)
            for img in (ROOT/'assets').rglob('*'):
                if img.is_file() and img.suffix.lower() in ('.png','.gif'):
                    z.write(img,img.relative_to(ROOT).as_posix())
        deploy(buffer.getvalue())
    # Compatible with earlier versions: the old overlay is missing Easy polling.
    # Preserve a copy, then install a dual-mode overlay (old C# mode still works without ?easy=1).
    LIVE.mkdir(parents=True,exist_ok=True)
    overlay_file=LIVE/'overlay.html'
    old_bytes=overlay_file.read_bytes() if overlay_file.exists() else b''
    new_bytes=(ROOT/'overlay.html').read_bytes()
    if old_bytes!=new_bytes:
        if old_bytes and not (USER_DIR/'overlay-before-easy.html').exists():
            _write(USER_DIR/'overlay-before-easy.html',old_bytes)
        _write(overlay_file,new_bytes)
    GAME=EasyGame(USER_DIR,CONFIG)
    GAME.claim_url=REWARDS.public_base
    GAME.viewer_verify=REWARDS.verify_viewer_session
    if ('items' in GAME.config or any(k not in COMBAT_FIELDS for k in GAME.config.get('economy',{})) or any('loot' in b or 'trophy' not in b or 'required' in (b.get('trophy') or {}) or (b.get('trophy') or {}).get('memcoins')==0 for b in GAME.config.get('bosses',[]))):
        migrate_trophies()
    threading.Thread(target=WSClient(GAME,password_provider=lambda:REWARDS.streamer_password).run,daemon=True,name='StreamerBot-Events').start()
    threading.Thread(target=periodic,args=(GAME,),daemon=True,name='BossTimers').start()

def check_package(blob):
    if len(blob) > MAX_BYTES: raise DeployError('ZIP превышает лимит 125 МБ')
    out = {}
    try:
        with zipfile.ZipFile(io.BytesIO(blob)) as z:
            records = z.infolist()
            if not records or len(records) > 350: raise DeployError('Недопустимое количество файлов')
            if sum(x.file_size for x in records) > MAX_BYTES: raise DeployError('Содержимое слишком велико')
            for entry in records:
                name = entry.filename
                if entry.is_dir(): continue
                if name in out or name.startswith('/') or '\\' in name or '..' in name.split('/') or ':' in name or not name or any(not part for part in name.split('/')):
                    raise DeployError('Опасное имя файла в ZIP')
                if entry.file_size > MAX_SINGLE: raise DeployError('Отдельный файл превышает 30 МБ: ' + name)
                if name not in REQUIRED and name != 'project.json' and not ASSET.fullmatch(name):
                    # Ignore extra safe files from previous release (C#, README, core), never extract them.
                    continue
                data = z.read(entry)
                if name.startswith('assets/'):
                    if name.lower().endswith('.png') and not data.startswith(b'\x89PNG\r\n\x1a\n'):
                        raise DeployError('Неверный PNG: '+name)
                    if name.lower().endswith('.gif') and not data.startswith((b'GIF87a',b'GIF89a')):
                        raise DeployError('Неверный GIF: '+name)
                out[name] = data
    except (zipfile.BadZipFile, RuntimeError) as exc:
        raise DeployError('ZIP повреждён: ' + str(exc))
    if not REQUIRED.issubset(out): raise DeployError('В ZIP отсутствуют обязательные файлы')
    try: cfg = json.loads(out['boss-config.json'].decode('utf-8'))
    except Exception: raise DeployError('Невалидный JSON конфигурации')
    if cfg.get('version') != 4: raise DeployError('Поддерживается только конфигурация версии 4')
    bosses = cfg.get('bosses')
    if not isinstance(bosses, list) or not bosses: raise DeployError('Не выбраны боссы')
    if len(bosses) > 100: raise DeployError('Максимум 100 боссов')
    if any(not isinstance(b.get('name'),str) or not b['name'].strip() or len(b['name'])>32 for b in bosses): raise DeployError('Имя босса: от 1 до 32 символов')
    ids = set()
    for b in bosses:
        bid = b.get('id','')
        if not isinstance(bid,str) or not ID.fullmatch(bid) or bid in ids: raise DeployError('Повторяющийся или неверный ID босса')
        ids.add(bid)
        sprites = b.get('sprites') or {}
        if not isinstance(sprites, dict) or not sprites.get('idle'): raise DeployError('Отсутствует спрайт ожидания: '+bid)
        for path in sprites.values():
            if not isinstance(path,str) or not ASSET.fullmatch(path) or path not in out:
                raise DeployError('В ZIP не найден спрайт: '+str(path))
    if not isinstance(cfg.get('economy'),dict):raise DeployError('Неверные правила боя')
    previous=cfg['economy']
    cfg['economy']={k:v for k,v in previous.items() if k in COMBAT_FIELDS}
    cfg.pop('items',None)
    if isinstance(cfg.get('bonuses'),list):cfg['bonuses']=[b for b in cfg['bonuses'] if b.get('effect')!='souls']
    for boss in bosses:
        old=boss.get('trophy') if isinstance(boss.get('trophy'),dict) else {}
        name=old.get('name') or 'Трофей '+boss['name']
        image=old.get('image','')
        memcoins=old.get('memcoins',previous.get('memcoinsPerReward',100))
        if not isinstance(name,str) or not name.strip() or len(name)>60:raise DeployError('Название трофея: 1–60 символов')
        if image and (not isinstance(image,str) or not ASSET.fullmatch(image) or not image.lower().endswith('.png') or image not in out):raise DeployError('Не найден PNG трофея '+boss['id'])
        if isinstance(memcoins,bool) or not isinstance(memcoins,int) or not 1<=memcoins<=1000:raise DeployError('Награда трофея: от 1 до 1000')
        boss['trophy']={'name':name.strip(),'image':image,'memcoins':memcoins}
        boss.pop('loot',None)
    cfg['schedule']=validate_schedule(cfg.get('schedule'),ids)
    out['boss-config.json']=json.dumps(cfg,ensure_ascii=False).encode('utf8')
    out['boss-config.js']=('window.BOSS_STUDIO_4_CONFIG='+json.dumps(cfg,ensure_ascii=False)+';').encode('utf8')
    if b'window.BOSS_STUDIO_4_CONFIG=' not in out['boss-config.js'][:90]: raise DeployError('Неверный JS-конфиг')
    if b'boss-studio4' not in out['overlay.html']: raise DeployError('Неизвестный тип оверлея')
    # Use the Easy-capable live overlay even when the old editor exports its standard overlay.
    out['overlay.html']=(ROOT/'overlay.html').read_bytes()
    return cfg, out

def _write(path, data):
    path.parent.mkdir(parents=True,exist_ok=True)
    with open(path,'wb') as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())

def deploy(blob):
    cfg, files = check_package(blob)
    with GUARD:
        # Old visual editor has no bonus/theme controls; preserve both on sync.
        if 'bonuses' not in cfg and CONFIG.exists():
            try:
                retained=json.loads(CONFIG.read_text(encoding='utf-8')).get('bonuses',[])
                cfg['bonuses']=[b for b in retained if b.get('effect')!='souls']
                files['boss-config.json']=json.dumps(cfg,ensure_ascii=False).encode('utf8')
                files['boss-config.js']=('window.BOSS_STUDIO_4_CONFIG='+json.dumps(cfg,ensure_ascii=False)+';').encode('utf8')
            except (OSError,ValueError,TypeError): pass
        if CONFIG.exists():
            try:
                old_bosses={b['id']:b for b in json.loads(CONFIG.read_text(encoding='utf8')).get('bosses',[])}
                modified=False
                for b in cfg['bosses']:
                    prior=old_bosses.get(b['id'],{})
                    for key in ('spriteScales','visualTransitions'):
                        if key not in b and key in prior:
                            b[key]=prior[key];modified=True
                    if 'animations' not in b and 'animations' in prior:
                        b['animations']=prior['animations'];modified=True
                if modified:
                    files['boss-config.json']=json.dumps(cfg,ensure_ascii=False).encode('utf8')
                    files['boss-config.js']=('window.BOSS_STUDIO_4_CONFIG='+json.dumps(cfg,ensure_ascii=False)+';').encode('utf8')
            except (ValueError,TypeError,KeyError):pass
        if 'overlayStyle' not in cfg and CONFIG.exists():
            try:
                cfg['overlayStyle']=json.loads(CONFIG.read_text(encoding='utf8')).get('overlayStyle',{})
                files['boss-config.json']=json.dumps(cfg,ensure_ascii=False).encode('utf8')
                files['boss-config.js']=('window.BOSS_STUDIO_4_CONFIG='+json.dumps(cfg,ensure_ascii=False)+';').encode('utf8')
            except (OSError,ValueError,TypeError):pass
        # Old editor may include overlayStyle without the new typography options.
        if CONFIG.exists() and isinstance(cfg.get('overlayStyle'),dict) and 'typography' not in cfg['overlayStyle']:
            try:
                previous_style=json.loads(CONFIG.read_text(encoding='utf8')).get('overlayStyle',{})
                if isinstance(previous_style.get('typography'),dict):
                    cfg['overlayStyle']['typography']=previous_style['typography']
                    files['boss-config.json']=json.dumps(cfg,ensure_ascii=False).encode('utf8')
                    files['boss-config.js']=('window.BOSS_STUDIO_4_CONFIG='+json.dumps(cfg,ensure_ascii=False)+';').encode('utf8')
            except (OSError,ValueError,TypeError):pass
        # Preserve bonus icon images when syncing sprites via old editor.
        old_bonus_files={}
        for bonus in cfg.get('bonuses',[]):
            icon=str(bonus.get('icon',''))
            if icon and ASSET.fullmatch(icon) and icon not in files and (LIVE/icon).is_file():
                old_bonus_files[icon]=(LIVE/icon).read_bytes()
        files.update(old_bonus_files)
        USER_DIR.mkdir(parents=True,exist_ok=True)
        # Entire live directory is built outside its destination; flip with two renames.
        stage = Path(tempfile.mkdtemp(prefix='.bs43_new_',dir=str(USER_DIR)))
        old = USER_DIR / '.bs43_previous_live'
        backup_cfg = USER_DIR / 'boss-config.previous.json'
        previous_config = CONFIG.read_bytes() if CONFIG.exists() else None
        try:
            for path, data in files.items():
                if path in ('project.json','boss-config.json') or path.startswith('assets/') or path in ('boss-config.js','overlay.html'):
                    _write(stage / path, data)
            _write(stage / 'boss-config.json',files['boss-config.json'])
            if old.exists(): shutil.rmtree(old)
            if LIVE.exists(): LIVE.replace(old)
            try:
                stage.replace(LIVE)
                # Write engine config atomically; its reader uses this exact location.
                cfg_tmp = USER_DIR / '.boss-config.new'
                _write(cfg_tmp,files['boss-config.json'])
                cfg_tmp.replace(CONFIG)
            except Exception:
                if LIVE.exists(): shutil.rmtree(LIVE)
                if old.exists(): old.replace(LIVE)
                if previous_config is not None: _write(CONFIG,previous_config)
                raise
            if previous_config is not None: _write(backup_cfg,previous_config)
            manifest = {'version':hashlib.sha256(files['boss-config.json']+b'\x00'+hashlib.sha256(blob).digest()).hexdigest()[:18], 'bosses':len(cfg['bosses']), 'enabled':sum(1 for b in cfg['bosses'] if b.get('enabled',True)), 'sprites':len([x for x in files if x.startswith('assets/')]), 'names':[b['name'] for b in cfg['bosses']]}
            _write(LIVE/'manifest.json',json.dumps(manifest,ensure_ascii=False).encode('utf-8'))
            # Old live stays in a backup folder. It isn't served on the network.
            if GAME is not None:
                GAME.load_config()
                if previous_config is None or json.loads(previous_config).get('schedule')!=cfg.get('schedule'):GAME.schedule_updated()
            return manifest
        finally:
            if stage.exists(): shutil.rmtree(stage)

def bonus_catalog():
    return GAME.config.get('bonuses',[]) if GAME else []

def save_bonuses(raw):
    if not isinstance(raw,list) or len(raw)>30:raise DeployError('Не более 30 бонусов')
    validated=[];ids=set();titles=set();commands=set()
    for b in raw:
        if not isinstance(b,dict):raise DeployError('Неверные данные бонуса')
        ident=str(b.get('id','')).strip()
        if not BONUS_ID.fullmatch(ident) or ident in ids:raise DeployError('Недопустимый или повторный ID бонуса')
        ids.add(ident)
        name=str(b.get('name','')).strip()[:60]
        title=str(b.get('rewardTitle','')).strip()
        effect=str(b.get('effect','damage'))
        command=str(b.get('command','')).strip().casefold()
        if not name or not title or len(title)>45 or effect not in BONUS_EFFECTS:raise DeployError('Проверь название, награду Twitch и действие')
        if title.casefold() in titles:raise DeployError('Названия наград Twitch должны быть уникальными')
        titles.add(title.casefold())
        if command and (not re.fullmatch(r'![\w-]{2,30}',command,flags=re.UNICODE) or command in commands or command in ('!удар','!магия','!щит','!профиль','!босс','!босссброс')):
            raise DeployError('Недопустимая или повторная команда чата')
        if command:commands.add(command)
        icon=str(b.get('icon',''))
        if icon and (not re.fullmatch(r'assets/bonuses/'+re.escape(ident)+r'\.(?:png|gif)',icon) or not (LIVE/icon).is_file()):
            raise DeployError('Не найден значок для '+name)
        validated.append(dict(id=ident,name=name,rewardTitle=title,rewardId=str(b.get('rewardId','')).strip()[:80],command=command,effect=effect,
            value=safe_int_api(b.get('value',450)),cost=max(1,safe_int_api(b.get('cost',300))),cooldownSec=min(3600,safe_int_api(b.get('cooldownSec',0))),
            animationMs=max(300,min(10000,safe_int_api(b.get('animationMs',1600)))),iconSize=max(24,min(160,safe_int_api(b.get('iconSize',68)))),
            enabled=bool(b.get('enabled',True)),icon=icon))
    with GUARD:
        config=json.loads(CONFIG.read_text(encoding='utf8'))
        config['bonuses']=validated
        body=json.dumps(config,ensure_ascii=False).encode('utf8')
        tmp=USER_DIR/'.bonuses-config-new.json';_write(tmp,body);tmp.replace(CONFIG)
        tmpjs=LIVE/'.bonuses-config-new.js';_write(tmpjs,('window.BOSS_STUDIO_4_CONFIG='+body.decode('utf8')+';').encode('utf8'));tmpjs.replace(LIVE/'boss-config.js')
        version=hashlib.sha256(body+str(__import__('time').time_ns()).encode()).hexdigest()[:18]
        current=read_manifest();current['version']=version;current['bonuses']=len(validated)
        _write(LIVE/'manifest.json',json.dumps(current,ensure_ascii=False).encode('utf8'))
        if GAME:GAME.load_config()
    return validated

TYPE_KEYS=('bossName','phase','topTitle','hp','notice','topRows','armor','bonusText','bonusCost')
TYPE_FONTS={'Georgia','Segoe UI','Arial','Verdana','Trebuchet MS','Tahoma','Impact','Courier New','Times New Roman'}
TYPE_DEFAULTS={
 'bossName':('Georgia',True,'#f9f0df'),
 'phase':('Segoe UI',False,'#dcc79e'),
 'topTitle':('Segoe UI',True,'#e8c18a'),
 'hp':('Arial',True,'#ffffff'),
 'notice':('Georgia',True,'#f9f0df'),
 'topRows':('Segoe UI',False,'#f9f0df'),
 'armor':('Segoe UI',True,'#b7d6e7'),
 'bonusText':('Segoe UI',True,'#ffe2c3'),
 'bonusCost':('Segoe UI',False,'#efd1a7'),
}

def save_overlay_style(raw):
    if not isinstance(raw,dict):raise DeployError('Неверные настройки оформления')
    def hexcolor(v,default):
        v=str(v)
        return v if re.fullmatch(r'#[0-9A-Fa-f]{6}',v) else default
    style=dict(backgroundColor=hexcolor(raw.get('backgroundColor'),'#16131e'),backgroundOpacity=min(100,safe_int_api(raw.get('backgroundOpacity',0))),
       hpColor=hexcolor(raw.get('hpColor'),'#e45a67'),topTitle=str(raw.get('topTitle','⚔ Топ урона')).strip()[:50],topVisible=bool(raw.get('topVisible',True)),
       topOpacity=min(100,safe_int_api(raw.get('topOpacity',82))),topX=min(50,safe_int_api(raw.get('topX',2))),topY=min(85,safe_int_api(raw.get('topY',35))),
       topWidth=max(12,min(45,safe_int_api(raw.get('topWidth',20)))),fontScale=max(60,min(160,safe_int_api(raw.get('fontScale',100)))),overallScale=max(50,min(100,safe_int_api(raw.get('overallScale',100)))),hpBarScale=max(50,min(400,safe_int_api(raw.get('hpBarScale',100)))),bonusIconScale=max(50,min(800,safe_int_api(raw.get('bonusIconScale',100)))),bonusFlashScale=max(50,min(800,safe_int_api(raw.get('bonusFlashScale',100)))))
    typography={}
    raw_types=raw.get('typography') if isinstance(raw.get('typography'),dict) else {}
    for key in TYPE_KEYS:
        item=raw_types.get(key,{})
        if not isinstance(item,dict):item={}
        default_font,default_bold,default_color=TYPE_DEFAULTS[key]
        chosen_font=str(item.get('font',default_font))
        if chosen_font not in TYPE_FONTS:chosen_font=default_font
        fallback_scale=style['fontScale'] if key=='bossName' else 100
        typography[key]=dict(font=chosen_font,scale=max(10,min(10000,safe_int_api(item.get('scale',fallback_scale)))),
            bold=bool(item.get('bold',default_bold)),italic=bool(item.get('italic',False)),underline=bool(item.get('underline',False)),
            color=hexcolor(item.get('color',default_color),default_color))
    style['typography']=typography
    layout={};raw_layout=raw.get('layout') if isinstance(raw.get('layout'),dict) else {}
    old_heading=raw_layout.get('heading',{}) if isinstance(raw_layout.get('heading',{}),dict) else {}
    old_health=raw_layout.get('health',{}) if isinstance(raw_layout.get('health',{}),dict) else {}
    defaults={
      'boss':(690,450,1620,2220),'bossName':(450,60,2100,120),'phase':(450,180,2100,70),
      'health':(720,2760,1560,50),'hpText':(720,2760,1560,50),'armor':(720,2650,900,70),
      'top':(2340,1050,600,600),'topTitle':(2356,1060,568,75),'notice':(810,600,1380,180),'bonusDock':(60,2100,360,600)}
    for key,default in defaults.items():
        item=raw_layout.get(key,{}) if isinstance(raw_layout.get(key,{}),dict) else {}
        if key=='bossName' and not item and old_heading:item=old_heading
        if key=='phase' and not item and old_heading:item={**old_heading,'y':safe_int_api(old_heading.get('y',60))+120}
        if key=='hpText' and not item and old_health:item=old_health
        if key=='topTitle' and not item and isinstance(raw_layout.get('top'),dict):
            old_top=raw_layout['top'];item={'x':safe_int_api(old_top.get('x',2340))+16,'y':safe_int_api(old_top.get('y',1050))+10,'w':max(120,safe_int_api(old_top.get('w',600))-32),'h':75}
        w=max(120,min(3000,safe_int_api(item.get('w',default[2]))))
        h=max(30,min(3000,safe_int_api(item.get('h',round(50*style['hpBarScale']/100) if key in ('health','hpText') else default[3]))))
        layout[key]={'x':min(3000-w,safe_int_api(item.get('x',default[0]))),'y':min(3000-h,safe_int_api(item.get('y',default[1]))),'w':w,'h':h}
    style['layout']=layout
    keys=list(defaults)
    incoming=raw.get('layerOrder') if isinstance(raw.get('layerOrder'),list) else []
    order=[]
    for key in incoming:
        if isinstance(key,str) and key in defaults and key not in order:order.append(key)
    style['layerOrder']=order+[key for key in keys if key not in order]
    raw_text=raw.get('textTemplates') if isinstance(raw.get('textTemplates'),dict) else {}
    templates={'bossName':'{boss}','phase':'ФАЗА {phase} · {rarity}','hpText':'{hp} / {maxHp} HP',
               'armor':'🛡 Броня {armor}','notice':'⚠ ПРОКЛЯТИЕ — !щит ({guards}/{requiredGuards})'}
    style['textTemplates']={key:re.sub(r'[\x00-\x1f\x7f]', ' ',raw_text.get(key,default))[:120] if isinstance(raw_text.get(key,default),str) else default for key,default in templates.items()}
    with GUARD:
        config=json.loads(CONFIG.read_text(encoding='utf8'))
        config['overlayStyle']=style
        body=json.dumps(config,ensure_ascii=False).encode('utf8')
        tmp=USER_DIR/'.style-config-new.json';_write(tmp,body);tmp.replace(CONFIG)
        tmpjs=LIVE/'.style-config-new.js';_write(tmpjs,('window.BOSS_STUDIO_4_CONFIG='+body.decode('utf8')+';').encode('utf8'));tmpjs.replace(LIVE/'boss-config.js')
        current=read_manifest();current['version']=hashlib.sha256(body+str(__import__('time').time_ns()).encode()).hexdigest()[:18]
        _write(LIVE/'manifest.json',json.dumps(current,ensure_ascii=False).encode('utf8'))
        if GAME:GAME.load_config()
    return style

TRANSITION_EFFECTS={'none','fade','fade-up','crossfade','zoom','zoom-out','slide-left','slide-right','shake','pulse','blur','spin','lunge','sink','flash','wipe'}
VISUAL_SLOTS=('idle','attack','hurt','phase_change','phase_2','phase_3','death')
VISUAL_EVENTS=('spawn','attack','hurt','phase','idle','death')
VISUAL_DEFAULTS={
  'spawn':('fade-up',900,30),'attack':('lunge',520,34),
  'hurt':('shake',350,24),'phase':('pulse',1900,40),
  'idle':('crossfade',250,20),'death':('fade',1100,25),
}

def get_boss_visuals(b):
    return {
      'id':b['id'], 'name':b.get('name',b['id']),
      'spriteScales':{k:int(max(30,min(250,(b.get('spriteScales') or {}).get(k,100)))) for k in VISUAL_SLOTS},
      'visualTransitions':{k:{'effect':(b.get('visualTransitions') or {}).get(k,{}).get('effect',d[0]),
         'durationMs':(b.get('visualTransitions') or {}).get(k,{}).get('durationMs',d[1]),
         'intensity':(b.get('visualTransitions') or {}).get(k,{}).get('intensity',d[2])}
         for k,d in VISUAL_DEFAULTS.items()},
      'deathHoldMs':(b.get('animations') or {}).get('deathHoldMs',1700)
    }

def save_boss_visuals(raw):
    if not isinstance(raw,dict):raise DeployError('Неверные параметры спрайтов')
    bid=raw.get('id','')
    if not isinstance(bid,str) or not ID.fullmatch(bid):raise DeployError('Неверный ID босса')
    scales=raw.get('spriteScales',{})
    transitions=raw.get('visualTransitions',{})
    if not isinstance(scales,dict) or not isinstance(transitions,dict):raise DeployError('Неверная структура анимаций')
    new_scales={}
    for k in VISUAL_SLOTS:
        v=scales.get(k,100)
        if isinstance(v,bool):raise DeployError('Неверный масштаб')
        new_scales[k]=max(30,min(250,safe_int_api(v)))
    new_transitions={}
    for k,(default_effect,default_duration,default_intensity) in VISUAL_DEFAULTS.items():
        item=transitions.get(k,{})
        if not isinstance(item,dict):raise DeployError('Неверный переход: '+k)
        effect=item.get('effect',default_effect)
        if effect not in TRANSITION_EFFECTS:raise DeployError('Неверный эффект: '+str(effect))
        new_transitions[k]={
          'effect':effect,
          'durationMs':max(0,min(6000,safe_int_api(item.get('durationMs',default_duration)))),
          'intensity':max(0,min(100,safe_int_api(item.get('intensity',default_intensity))))
        }
    hold=max(0,min(10000,safe_int_api(raw.get('deathHoldMs',1700))))
    with GUARD:
        config=json.loads(CONFIG.read_text(encoding='utf8'))
        boss=next((x for x in config.get('bosses',[]) if x.get('id')==bid),None)
        if boss is None:raise DeployError('Босс не найден')
        boss['spriteScales']=new_scales
        boss['visualTransitions']=new_transitions
        animations=boss.setdefault('animations',{})
        animations['deathHoldMs']=hold
        # Old event time fields retained for older preview/editors.
        animations['spawnFadeMs']=new_transitions['spawn']['durationMs']
        animations['hurtMs']=new_transitions['hurt']['durationMs']
        animations['phaseMs']=new_transitions['phase']['durationMs']
        animations['deathFadeMs']=new_transitions['death']['durationMs']
        body=json.dumps(config,ensure_ascii=False).encode('utf8')
        tmp=USER_DIR/'.visual-config-new.json';_write(tmp,body);tmp.replace(CONFIG)
        tmpjs=LIVE/'.visual-config-new.js';_write(tmpjs,('window.BOSS_STUDIO_4_CONFIG='+body.decode('utf8')+';').encode('utf8'));tmpjs.replace(LIVE/'boss-config.js')
        current=read_manifest();current['version']=hashlib.sha256(body+str(__import__('time').time_ns()).encode()).hexdigest()[:18]
        _write(LIVE/'manifest.json',json.dumps(current,ensure_ascii=False).encode('utf8'))
        if GAME:GAME.load_config()
    return get_boss_visuals(boss)

COMBAT_FIELDS={'spawnChance','hitDamage','magicDamage','hitCooldownSec','magicCooldownSec','guardCooldownSec','phase2Percent','phase3Percent','phase2Armor','phase3Armor','guardRequired','guardHealPercent','guardDurationSec','followDamage','bitsDamagePerBit','bitsDamageCap','subDamage','resubDamage','giftSubDamage','giftSubCap','donationDamagePerUnit','donationAmountCap','rewardDamage'}
DEFAULT_SCHEDULE={'enabled':False,'firstDelayMin':120,'nextDelayMin':60,'maxBosses':3,'queue':[{'kind':'random'}]}
def validate_schedule(raw,ids):
    raw=raw if isinstance(raw,dict) else DEFAULT_SCHEDULE
    if not isinstance(raw.get('enabled',False),bool):raise DeployError('Неверный переключатель расписания')
    result={'enabled':raw.get('enabled',False)}
    for field,default,low,high in (('firstDelayMin',120,0,10080),('nextDelayMin',60,0,10080),('maxBosses',3,1,100)):
        value=raw.get(field,default)
        if isinstance(value,bool) or not isinstance(value,int) or not low<=value<=high:raise DeployError('Неверное значение '+field)
        result[field]=value
    queue=raw.get('queue',[{'kind':'random'}])
    if not isinstance(queue,list) or not 1<=len(queue)<=100:raise DeployError('Очередь: от 1 до 100 записей')
    result['queue']=[]
    for entry in queue:
        if not isinstance(entry,dict) or entry.get('kind') not in ('random','boss'):raise DeployError('Неверная запись очереди')
        if entry['kind']=='boss':
            if entry.get('bossId') not in ids:raise DeployError('Босс в очереди не найден')
            result['queue'].append({'kind':'boss','bossId':entry['bossId']})
        else:result['queue'].append({'kind':'random'})
    return result

def persist_config(config):
    body=json.dumps(config,ensure_ascii=False).encode('utf8')
    tmp=USER_DIR/'.config-new.json';_write(tmp,body);tmp.replace(CONFIG)
    tmpjs=LIVE/'.config-new.js';_write(tmpjs,('window.BOSS_STUDIO_4_CONFIG='+body.decode('utf8')+';').encode('utf8'));tmpjs.replace(LIVE/'boss-config.js')
    manifest=read_manifest();manifest['version']=hashlib.sha256(body).hexdigest()[:18]
    _write(LIVE/'manifest.json',json.dumps(manifest,ensure_ascii=False).encode('utf8'))
    if GAME:
        GAME.load_config()

def save_schedule(raw):
    with GUARD:
        config=json.loads(CONFIG.read_text(encoding='utf8'))
        setting=validate_schedule(raw,{b['id'] for b in config['bosses']})
        config['schedule']=setting;persist_config(config)
        if GAME:GAME.schedule_updated()
        return setting

def migrate_trophies():
    with GUARD:
        config=json.loads(CONFIG.read_text(encoding='utf8'))
        old=config['economy'];config['economy']={k:v for k,v in old.items() if k in COMBAT_FIELDS}
        config.pop('items',None)
        if isinstance(config.get('bonuses'),list):config['bonuses']=[b for b in config['bonuses'] if b.get('effect')!='souls']
        for b in config['bosses']:
            b.setdefault('trophy',{'name':'Трофей '+b['name'],'image':'','memcoins':max(1,min(1000,old.get('memcoinsPerReward',100)))})
            b['trophy'].pop('required',None)
            if b['trophy'].get('memcoins')==0:b['trophy']['memcoins']=1
            b.pop('loot',None)
        config.setdefault('schedule',DEFAULT_SCHEDULE)
        persist_config(config)

class Handler(BaseHTTPRequestHandler):
    server_version = 'BossStudioBridge/4.8'
    def safe_host(self):
        return self.headers.get('Host','').lower() in ('127.0.0.1:'+str(PORT),'localhost:'+str(PORT))
    def claim_host(self):
        host=self.headers.get('Host','').lower()
        return host in ('127.0.0.1:'+str(PUBLIC_PORT),'localhost:'+str(PUBLIC_PORT)) or bool(REWARDS.public_base) and host==urlsplit(REWARDS.public_base).netloc.lower()
    def viewer_origin(self):
        return REWARDS.public_base if REWARDS.public_base and self.headers.get('Host','').lower()==urlsplit(REWARDS.public_base).netloc.lower() else 'http://'+self.headers.get('Host','')
    def viewer_token(self):
        authorization=self.headers.get('Authorization','')
        return authorization[7:] if authorization.startswith('Bearer ') else ''
    def _header(self, code, mime, data, cache=False):
        self.send_response(code)
        self.send_header('Content-Type',mime)
        self.send_header('Content-Length',str(len(data)))
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Cache-Control','public, max-age=3600' if cache else 'no-store')
        self.send_header('X-Frame-Options','SAMEORIGIN')
        self.send_header('Referrer-Policy','no-referrer')
        self.end_headers()
        self.wfile.write(data)
    def json(self, code, obj):
        self._header(code,'application/json; charset=utf-8',json.dumps(obj,ensure_ascii=False).encode('utf-8'))
    def do_GET(self):
        path=urlsplit(self.path).path
        if getattr(self.server,'public',False) and self.claim_host() and path=='/api/viewer/state':
            try:self.json(200,{'ok':True,**REWARDS.viewer_status(self.viewer_token(),GAME)})
            except RewardError as exc:self.json(401,{'ok':False,'error':str(exc)})
            return
        if getattr(self.server,'public',False) and self.claim_host() and path.startswith('/api/viewer/trophy/'):
            bid=path.removeprefix('/api/viewer/trophy/')
            boss=next((b for b in GAME.config.get('bosses',[]) if b.get('id')==bid),None) if ID.fullmatch(bid) else None
            image=(boss.get('trophy') or {}).get('image','') if boss else ''
            if image and ASSET.fullmatch(image) and image.endswith('.png') and (LIVE/image).is_file():
                self._header(200,'image/png',(LIVE/image).read_bytes());return
            self.json(404,{'error':'Трофей не найден'});return
        if path=='/claim' and getattr(self.server,'public',False) and self.claim_host():
            self._header(200,'text/html; charset=utf-8',(ROOT/'claim.html').read_bytes());return
        if not self.safe_host():self.json(403,{'error':'Только localhost'});return
        if path in ('/','/easy'):
            self.send_response(302);self.send_header('Location','/easy.html');self.end_headers();return
        if path=='/api/easy/status':
            self.json(200,{'ok':True,'token':TOKEN,**GAME.status()});return
        if path=='/api/easy/state':
            self.json(200,GAME.snapshot());return
        if path=='/api/easy/test-state':
            self.json(200,GAME.snapshot('test'));return
        if path=='/api/easy/boss-visuals':
            self.json(200,{'bosses':[get_boss_visuals(b) for b in GAME.config.get('bosses',[])]});return
        if path=='/api/easy/overlay-style':
            self.json(200,{'style':GAME.config.get('overlayStyle',{})});return
        if path=='/api/easy/bonuses':
            self.json(200,{'bonuses':bonus_catalog()});return
        if path in ('/api/schedule','/api/easy/schedule'):self.json(200,{'ok':True,'settings':GAME.config.get('schedule',DEFAULT_SCHEDULE),'state':GAME.schedule_status()});return
        if path=='/api/rewards/status':
            self.json(200,{'ok':True,**REWARDS.status(),'localViewerUrl':f'http://127.0.0.1:{PUBLIC_PORT}/claim','chatStatus':GAME.chat_status,'queue':REWARDS.queue(GAME)});return
        if path=='/api/easy/config':
            self.json(200,{'bosses':[{'id':b['id'],'name':b.get('name',b['id']),'enabled':b.get('enabled',True)} for b in GAME.config.get('bosses',[])]});return
        if path in ('/','/editor'):

            self.send_response(302);self.send_header('Location','/BossStudio43_EDITOR.html');self.end_headers();return
        if path=='/api/status':
            self.json(200,{'ok':True,'token':TOKEN,'dataDir':str(USER_DIR),'overlayUrl':f'http://{HOST}:{PORT}/live/overlay.html','hasLive':CONFIG.exists() and (LIVE/'overlay.html').exists(),'version':read_manifest().get('version')});return
        if path=='/api/version': self.json(200,read_manifest());return
        if path=='/api/live-config':
            if not CONFIG.exists():self.json(404,{'error':'Конфиг ещё не выгружен'});return
            try:self.json(200,json.loads(CONFIG.read_text(encoding='utf8')))
            except Exception:self.json(500,{'error':'Конфиг повреждён'})
            return
        if path.startswith('/live/'):
            rel=path[len('/live/'):]
            if rel and (rel in ('overlay.html','boss-config.js') or ASSET.fullmatch(rel)):
                f=LIVE/rel
                if f.is_file():
                    mime='text/html; charset=utf-8' if rel.endswith('.html') else 'text/javascript; charset=utf-8' if rel.endswith('.js') else 'image/gif' if rel.endswith('.gif') else 'image/png'
                    self._header(200,mime,f.read_bytes());return
        elif path.startswith('/') and path[1:] in STATIC:
            f=ROOT/path[1:]
            if f.is_file():
                mime='text/html; charset=utf-8' if f.suffix=='.html' else 'text/javascript; charset=utf-8' if f.suffix=='.js' else 'text/plain; charset=utf-8'
                self._header(200,mime,f.read_bytes());return
        self.json(404,{'error':'Ресурс не найден'})
    def do_POST(self):
        path=urlsplit(self.path).path
        if path in ('/api/viewer/request','/api/viewer/session') and getattr(self.server,'public',False) and self.claim_host():
            if self.headers.get('Origin')!=self.viewer_origin() or self.headers.get('Content-Type','').split(';')[0].strip()!='application/json':self.json(403,{'ok':False,'error':'Доступ запрещён'});return
            try:
                n=int(self.headers.get('Content-Length','0'))
                if not 1<=n<=2048:raise RewardError('Неверный размер заявки')
                data=json.loads(self.rfile.read(n).decode('utf8'))
                if path=='/api/viewer/session':self.json(200,{'ok':True,**REWARDS.create_viewer_session()})
                else:self.json(200,{'ok':True,**REWARDS.request_reward(str(data.get('nickname','')),self.viewer_token(),GAME)})
            except (RewardError,ValueError,TypeError) as exc:self.json(400,{'ok':False,'error':str(exc)})
            return
        if not self.safe_host():self.json(403,{'error':'Только localhost'});return
        if path not in ('/api/deploy','/api/easy/action','/api/easy/manual','/api/easy/select','/api/easy/bonuses','/api/easy/bonus-icon','/api/easy/overlay-style','/api/easy/boss-visuals','/api/schedule','/api/stream','/api/easy/stream','/api/rewards/setup','/api/rewards/mark-paid'):self.json(404,{'error':'Ресурс не найден'});return
        origin=self.headers.get('Origin','')
        if origin not in ('http://127.0.0.1:'+str(PORT),'http://localhost:'+str(PORT)) or self.headers.get('X-Boss-Studio-Token')!=TOKEN:
            self.json(403,{'error':'Доступ запрещён'});return
        try:n=int(self.headers.get('Content-Length','0'))
        except ValueError:n=0
        if n<1 or n>(MAX_BYTES if path=='/api/deploy' else 5*1024*1024 if path=='/api/easy/bonus-icon' else 65536):self.json(413,{'error':'Размер файла не поддерживается'});return
        if path in ('/api/schedule','/api/stream','/api/easy/stream','/api/rewards/setup','/api/rewards/mark-paid'):
            try:
                if self.headers.get('Content-Type','').split(';')[0].strip()!='application/json':raise DeployError('Нужен JSON')
                data=json.loads(self.rfile.read(n).decode('utf8'))
                if path=='/api/schedule':result={'settings':save_schedule(data)}
                elif path in ('/api/stream','/api/easy/stream'):
                    action=data.get('action')
                    if action not in ('start','stop'):raise DeployError('Неверная команда')
                    result={'state':GAME.stream_start() if action=='start' else GAME.stream_stop()}
                elif path=='/api/rewards/setup':
                    REWARDS.configure(str(data.get('publicBaseUrl','')).strip(),str(data.get('streamerPassword','')))
                    GAME.claim_url=REWARDS.public_base;result=REWARDS.status()
                else:
                    result=REWARDS.mark_paid(str(data.get('requestId','')),GAME)
                self.json(200,{'ok':True,**result})
            except (ValueError,TypeError,DeployError,RewardError,OSError) as exc:self.json(400,{'ok':False,'error':str(exc)})
            return
        if path=='/api/easy/boss-visuals':
            try:
                value=save_boss_visuals(json.loads(self.rfile.read(n).decode('utf8')))
                self.json(200,{'ok':True,'boss':value})
            except (ValueError,TypeError,DeployError,OSError) as exc:self.json(400,{'ok':False,'error':str(exc)})
            return
        if path=='/api/easy/overlay-style':
            try:
                style=save_overlay_style(json.loads(self.rfile.read(n).decode('utf8')))
                self.json(200,{'ok':True,'style':style})
            except (ValueError,TypeError,DeployError,OSError) as exc:self.json(400,{'ok':False,'error':str(exc)})
            return
        if path=='/api/easy/bonus-icon':
            bid=self.headers.get('X-Bonus-Id','')
            mime=self.headers.get('Content-Type','').split(';')[0].strip().lower()
            if not BONUS_ID.fullmatch(bid) or mime not in ('image/png','image/gif'):
                self.json(400,{'error':'Нужен PNG или GIF'});return
            data=self.rfile.read(n)
            if not (data.startswith(b'\x89PNG\r\n\x1a\n') if mime=='image/png' else data.startswith((b'GIF87a',b'GIF89a'))):
                self.json(400,{'error':'Изображение повреждено или неподдерживаемого типа'});return
            ext='png' if mime=='image/png' else 'gif'
            rel=f'assets/bonuses/{bid}.{ext}'
            with GUARD:_write(LIVE/rel,data)
            self.json(200,{'ok':True,'icon':rel});return
        if path=='/api/easy/bonuses':
            if self.headers.get('Content-Type','').split(';')[0].strip()!='application/json':self.json(415,{'error':'Нужен JSON'});return
            try:
                value=json.loads(self.rfile.read(n).decode('utf8'))
                updated=save_bonuses(value.get('bonuses'))
                self.json(200,{'ok':True,'count':len(updated)})
            except (ValueError,TypeError,DeployError,OSError) as exc:self.json(400,{'ok':False,'error':str(exc)})
            return
        if path in ('/api/easy/action','/api/easy/manual','/api/easy/select'):
            if self.headers.get('Content-Type','').split(';')[0].strip()!='application/json':self.json(415,{'error':'Нужен JSON'});return
            try:
                data=json.loads(self.rfile.read(n).decode('utf8'))
                if path=='/api/easy/manual':
                    typ=str(data.get('type',''))
                    mode=str(data.get('mode','test'))
                    result=GAME.manual_action(typ,mode=mode,boss_id=str(data.get('bossId','')))
                    self.json(200,{'ok':True,'state':result,'mode':mode});return
                if path=='/api/easy/action':
                    typ=data.get('type',''); mode=data.get('mode','test')
                    if mode not in ('test','live') or typ not in ('bonus','spawn','reset','hit','magic','guard','bits','follow','sub','resub','giftsub','donation','reward','profile'):
                        raise DeployError('Неверный тип события')
                    result=GAME.apply(typ, str(data.get('userId','demo'))[:90],str(data.get('user','Тестовый зритель'))[:70], safe_int_api(data.get('amount',1)),mode=mode,boss_id=str(data.get('bossId','')),bonus_id=str(data.get('bonusId','')))
                    self.json(200,{'ok':True,'state':result});return
                selected=data.get('ids',[])
                if not isinstance(selected,list) or not selected or len(selected)>100 or not all(isinstance(i,str) for i in selected):raise DeployError('Выбери боссов')
                current=json.loads(CONFIG.read_text(encoding='utf8'))
                if not any(b['id'] in selected for b in current.get('bosses',[])):raise DeployError('Выбери хотя бы одного босса')
                for b in current['bosses']:b['enabled']=b['id'] in selected
                content=io.BytesIO()
                with zipfile.ZipFile(content,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=3) as z:
                    z.writestr('boss-config.json',json.dumps(current,ensure_ascii=False))
                    z.writestr('boss-config.js','window.BOSS_STUDIO_4_CONFIG='+json.dumps(current,ensure_ascii=False)+';')
                    z.write(ROOT/'overlay.html','overlay.html')
                    for b in current['bosses']:
                        for img in [*b.get('sprites',{}).values(),(b.get('trophy') or {}).get('image','')]:
                            if not img:continue
                            source=LIVE/img
                            if not source.exists():raise DeployError('Нет изображения '+img)
                            z.write(source,img)
                result=deploy(content.getvalue())
                self.json(200,{'ok':True,**result});return
            except (ValueError,KeyError,DeployError) as exc:
                self.json(400,{'ok':False,'error':str(exc)});return
            except Exception as exc:self.json(500,{'ok':False,'error':str(exc)});return
        if self.headers.get('Content-Type','').split(';')[0].strip()!='application/zip':self.json(415,{'error':'Нужен ZIP'});return
        try:
            data=self.rfile.read(n)
            result=deploy(data)
            self.json(200,{'ok':True,**result})
        except DeployError as exc:self.json(400,{'ok':False,'error':str(exc)})
        except Exception as exc:self.json(500,{'ok':False,'error':'Ошибка записи: '+str(exc)})
    def log_message(self,fmt,*args):
        if not self.path.startswith('/api/version'): print('[Bridge]',fmt%args)

class PublicHandler(Handler):
    """Dedicated tunnel target: admin routes never run on this listener."""
    def do_GET(self):
        path=urlsplit(self.path).path
        if path not in ('/claim','/api/viewer/state') and not path.startswith('/api/viewer/trophy/'):
            self.json(404,{'error':'Ресурс не найден'});return
        super().do_GET()
    def do_POST(self):
        if urlsplit(self.path).path not in ('/api/viewer/request','/api/viewer/session'):
            self.json(404,{'error':'Ресурс не найден'});return
        super().do_POST()

def safe_int_api(x):
    try:return max(0,min(1000000,int(float(x))))
    except (ValueError,TypeError):return 0

def read_manifest():
    try:return json.loads((LIVE/'manifest.json').read_text(encoding='utf-8'))
    except Exception:return {'version':None}

if __name__=='__main__':
    if PUBLIC_PORT==PORT:raise SystemExit('Публичный и административный порт должны различаться')
    _init_game()
    print('Boss Studio 4.9 — сервер и авто-подключение к Twitch через Streamer.bot')
    print('ОТКРЫТЬ: http://127.0.0.1:%d/easy'%PORT)
    print('Редактор расширенный: http://127.0.0.1:%d/editor'%PORT)
    print('OBS: http://127.0.0.1:%d/live/overlay.html'%PORT)
    print('Публичная страница: защищённый HTTPS-туннель к 127.0.0.1:%d'%PUBLIC_PORT)
    print('C# config:',CONFIG)
    print('Не закрывайте это окно во время стрима. Остановка: Ctrl+C.')
    try:
        import webbrowser
        threading.Timer(1.3,lambda:webbrowser.open(f'http://{HOST}:{PORT}/easy')).start()
        public_server=ThreadingHTTPServer((HOST,PUBLIC_PORT),PublicHandler)
        public_server.public=True
        threading.Thread(target=public_server.serve_forever,daemon=True,name='Viewer-Claims').start()
        ThreadingHTTPServer((HOST,PORT),Handler).serve_forever()
    except KeyboardInterrupt: print('Мост остановлен.')
