"""Local viewer identity and manual MemeAlerts reward requests.

The app never calls MemeAlerts APIs. The streamer grants coins on its website.
"""
import json
import os
import re
import secrets
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit


class RewardError(Exception):
    pass


class ViewerRewards:
    def __init__(self, folder):
        self.path = Path(folder) / 'viewer-config.json'
        self.lock = threading.RLock()
        self.sessions = {}
        self.config = self._read(self.path)
        # Migrate only the public URL and Streamer.bot password. OAuth credentials
        # stay in the old local file and are never loaded into this workflow.
        if not self.path.exists():
            old = self._read(Path(folder) / 'meme-auth.json')
            self.config = {k: old[k] for k in ('publicBaseUrl', 'streamerPassword') if isinstance(old.get(k), str)}
            if self.config:
                self._write()

    @staticmethod
    def _read(path):
        try:
            data = json.loads(path.read_text(encoding='utf8'))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _write(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix('.tmp')
        with open(tmp, 'w', encoding='utf8') as file:
            if os.name != 'nt':
                os.chmod(tmp, 0o600)
            json.dump(self.config, file, ensure_ascii=False)
            file.flush()
            os.fsync(file.fileno())
        os.replace(tmp, self.path)

    def configure(self, public_url, password):
        public_url = public_url.rstrip('/')
        if public_url:
            parsed = urlsplit(public_url)
            if (len(public_url) > 250 or parsed.scheme != 'https' or not parsed.hostname
                    or parsed.path or parsed.query or parsed.fragment or parsed.username or parsed.password):
                raise RewardError('Нужен публичный HTTPS-адрес без пути, например https://example.com')
        if len(password) > 200:
            raise RewardError('Пароль Streamer.bot слишком длинный')
        with self.lock:
            self.config['publicBaseUrl'] = public_url
            if password:
                self.config['streamerPassword'] = password
            self._write()

    @property
    def public_base(self):
        return self.config.get('publicBaseUrl', '')

    @property
    def streamer_password(self):
        return self.config.get('streamerPassword', '')

    def status(self):
        return {'publicBaseUrl': self.public_base, 'streamerPasswordSet': bool(self.streamer_password)}

    def create_viewer_session(self):
        with self.lock:
            now = time.time()
            self.sessions = {k: v for k, v in self.sessions.items() if v['expires'] > now}
            if len(self.sessions) >= 500:
                raise RewardError('Слишком много открытых страниц, попробуй позже')
            token = secrets.token_urlsafe(32)
            code = secrets.token_urlsafe(10).lower()
            self.sessions[token] = {'code': code, 'verifyExpires': now + 900,
                                    'expires': now + 86400, 'twitchId': '', 'name': ''}
            return {'token': token, 'command': '!профиль ' + code}

    def _session(self, token):
        session = self.sessions.get(token)
        if not session or session['expires'] < time.time():
            raise RewardError('Сессия истекла; подтверди Twitch-аккаунт снова')
        return session

    def verify_viewer_session(self, code, twitch_id, name):
        if not twitch_id or not twitch_id.isdigit():
            raise RewardError('Не получен Twitch ID зрителя')
        with self.lock:
            session = next((s for s in self.sessions.values() if s['code'] == code and s['verifyExpires'] > time.time()), None)
            if not session:
                raise RewardError('Код не найден или истёк')
            session.update(twitchId=twitch_id, name=name, code='')
            return f'{name}: просмотр трофеев подтверждён'

    def viewer_status(self, token, game):
        with self.lock:
            session = self._session(token)
            uid = session['twitchId']
            with game.lock:
                bosses = game.config.get('bosses', [])
                profile = game.live.get('players', {}).get(uid, {}) if uid else {}
                earned = profile.get('bossTrophies') or {}
                defeated = game.live.get('bossDefeats') or {}
                catalog = []
                for boss in bosses:
                    trophy = boss.get('trophy') or {}
                    bid = boss['id']
                    won = bool(defeated.get(bid)) or any((p.get('bossTrophies') or {}).get(bid, 0) > 0 for p in game.live.get('players', {}).values())
                    catalog.append({'id': bid, 'boss': boss.get('name', bid),
                                    'trophy': trophy.get('name') or 'Трофей ' + boss.get('name', bid),
                                    'image': bool(trophy.get('image')), 'active': bool(boss.get('enabled', True)),
                                    'defeated': won, 'earned': int(earned.get(bid, 0)) if uid else None})
                active = [b for b in catalog if b['active']]
                jobs = [j for j in game.live.get('payouts', []) if j.get('twitchId') == uid] if uid else []
                unclaimed = [j for j in jobs if j.get('status') == 'unclaimed']
                waiting = [j for j in jobs if j.get('status') == 'requested']
                return {'verified': bool(uid), 'viewerName': session['name'] if uid else '',
                        'command': '!профиль ' + session['code'] if not uid and session['code'] else '',
                        'bosses': catalog, 'required': len(active),
                        'collected': sum(bool(b['earned']) for b in active) if uid else 0,
                        'ready': bool(uid and active and all(b['earned'] > 0 for b in active) and unclaimed),
                        'pendingCount': len(unclaimed), 'pendingCoins': sum(j['value'] for j in unclaimed),
                        'waitingCount': len(waiting), 'waitingCoins': sum(j['value'] for j in waiting),
                        'paidCount': sum(j.get('status') == 'paid' for j in jobs)}

    def request_reward(self, nickname, token, game):
        name = nickname.strip().lstrip('@')
        if not re.fullmatch(r'[^<>\x00-\x1f\x7f]{2,60}', name):
            raise RewardError('Укажи ник MemeAlerts (2–60 символов)')
        with self.lock:
            session = self._session(token)
            with game.lock:
                if not self.viewer_status(token, game)['ready']:
                    raise RewardError('Сначала подтверди Twitch и собери трофеи всех активных боссов')
                jobs = [j for j in game.live.get('payouts', []) if j.get('twitchId') == session['twitchId'] and j.get('status') == 'unclaimed']
                if not jobs:
                    raise RewardError('Доступная награда уже запрошена')
                request_id = secrets.token_hex(16)
                requested_at = int(time.time())
                for job in jobs:
                    job.update(status='requested', requestId=request_id, memeNick=name, requestedAt=requested_at, error='')
                game._save()
                return {'requestId': request_id, 'count': len(jobs), 'coins': sum(j['value'] for j in jobs)}

    def queue(self, game):
        with game.lock:
            groups = {}
            for job in game.live.get('payouts', []):
                if job.get('status') not in ('requested', 'review'):
                    continue
                rid = job.get('requestId') or job['id']
                group = groups.setdefault(rid, {'requestId': rid, 'status': job['status'],
                    'twitchName': job.get('name', ''), 'memeNick': job.get('memeNick', ''),
                    'coins': 0, 'count': 0, 'requestedAt': job.get('requestedAt', 0)})
                group['coins'] += job.get('value', 0)
                group['count'] += 1
            return sorted(groups.values(), key=lambda g: g['requestedAt'])

    def mark_paid(self, request_id, game):
        with game.lock:
            jobs = [j for j in game.live.get('payouts', []) if (j.get('requestId') or j['id']) == request_id and j.get('status') in ('requested', 'review')]
            if not jobs or len(jobs) > 1000:
                raise RewardError('Заявка не найдена или уже закрыта')
            for job in jobs:
                job.update(status='paid', paidAt=int(time.time()), error='')
            game._save()
            return {'count': len(jobs), 'coins': sum(j['value'] for j in jobs)}
