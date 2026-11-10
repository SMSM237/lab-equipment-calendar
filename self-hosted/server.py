#!/usr/bin/env python3
"""Self-hosted equipment calendar; Python standard library only."""
import argparse
import base64
from contextlib import contextmanager
import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import socket
import sqlite3
import ssl
import sys
import threading
import time
import traceback
from datetime import datetime, timedelta
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
WEB = ROOT / 'web'
DATA = ROOT / 'data'
DATE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
DT = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$')
COLOR = re.compile(r'^#[0-9a-fA-F]{6}$')


class AppError(Exception):
    status = 400
class ValidationError(AppError):
    pass
class ForbiddenError(AppError):
    status = 403
class NotFoundError(AppError):
    status = 404
class ConflictError(AppError):
    status = 409
    def __init__(self, message, conflicting=None):
        super().__init__(message)
        self.conflicting = conflicting


def clean_text(value, label, limit, required=True):
    if not isinstance(value, str):
        raise ValidationError(f'{label}을(를) 확인해 주세요.')
    value = value.strip()
    if (required and not value) or len(value) > limit or any(ord(c) < 32 and c not in '\n\t' for c in value):
        raise ValidationError(f'{label}은(는) {limit}자 이내로 입력해 주세요.')
    return value


def checked_datetime(value):
    if not isinstance(value, str) or not DT.fullmatch(value):
        raise ValidationError('날짜와 시간을 확인해 주세요.')
    try:
        return datetime.strptime(value, '%Y-%m-%dT%H:%M')
    except ValueError as exc:
        raise ValidationError('날짜와 시간을 확인해 주세요.') from exc


def checked_date(value):
    if not isinstance(value, str) or not DATE.fullmatch(value):
        raise ValidationError('날짜를 확인해 주세요.')
    try:
        return datetime.strptime(value, '%Y-%m-%d')
    except ValueError as exc:
        raise ValidationError('날짜를 확인해 주세요.') from exc


def int_id(value):
    if isinstance(value, bool):
        raise ValidationError('잘못된 항목입니다.')
    try:
        number = int(value)
        if number <= 0 or str(number) != str(value):
            raise ValueError()
        return number
    except (TypeError, ValueError) as exc:
        raise ValidationError('잘못된 항목입니다.') from exc


class CalendarStore:
    def __init__(self, path):
        self.path = str(path)
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as conn:
            conn.executescript('''
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY, provider TEXT NOT NULL, provider_id TEXT NOT NULL,
                    email TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, name_confirmed INTEGER NOT NULL DEFAULT 0,
                    UNIQUE(provider, provider_id));
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS equipment (
                    id INTEGER PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS bookings (
                    id INTEGER PRIMARY KEY, equipment_id INTEGER NOT NULL REFERENCES equipment(id),
                    user_id INTEGER NOT NULL REFERENCES users(id), start TEXT NOT NULL, end TEXT NOT NULL,
                    note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
                CREATE INDEX IF NOT EXISTS bookings_equipment_time ON bookings(equipment_id,start,end);
                CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires);
            ''')
            if 'name_confirmed' not in {row['name'] for row in conn.execute('PRAGMA table_info(users)')}:
                conn.execute('ALTER TABLE users ADD COLUMN name_confirmed INTEGER NOT NULL DEFAULT 0')
                conn.execute("UPDATE users SET name_confirmed=1 WHERE provider='demo'")

    @contextmanager
    def connect(self):
        conn = sqlite3.connect(self.path, timeout=15, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA foreign_keys=ON')
        conn.execute('PRAGMA busy_timeout=15000')
        try:
            yield conn
        finally:
            conn.close()

    @staticmethod
    def _row(row):
        return dict(row) if row is not None else None

    def upsert_user(self, provider, provider_id, email, name):
        name = clean_text(name, '이름', 40)
        with self.connect() as conn:
            conn.execute('INSERT INTO users(provider,provider_id,email,name,name_confirmed) VALUES(?,?,?,?,?) '
                         'ON CONFLICT(provider,provider_id) DO UPDATE SET email=excluded.email',
                         (provider, provider_id, email, name, int(provider == 'demo')))
            return self._row(conn.execute('SELECT id,provider,email,name,name_confirmed FROM users WHERE provider=? AND provider_id=?',
                                          (provider, provider_id)).fetchone())

    def upsert_demo_user(self, name):
        name = clean_text(name, '이름', 40)
        return self.upsert_user('demo', name, '', name)

    def update_name(self, user_id, name):
        name = clean_text(name, '이름', 40)
        with self.connect() as conn:
            conn.execute('UPDATE users SET name=?,name_confirmed=1 WHERE id=?', (name, user_id))

    def create_session(self, user_id):
        token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        now = int(time.time())
        with self.connect() as conn:
            conn.execute('DELETE FROM sessions WHERE expires < ?', (now,))
            conn.execute('INSERT INTO sessions(token_hash,user_id,expires) VALUES(?,?,?)', (token_hash, user_id, now + 86400 * 14))
        return token

    def session_user(self, token):
        if not token or len(token) > 128:
            return None
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        with self.connect() as conn:
            row = conn.execute('SELECT users.id,users.provider,users.email,users.name,users.name_confirmed FROM sessions '
                               'JOIN users ON users.id=sessions.user_id WHERE token_hash=? AND expires>?',
                               (token_hash, int(time.time()))).fetchone()
            return self._row(row)

    def delete_session(self, token):
        if token:
            with self.connect() as conn:
                conn.execute('DELETE FROM sessions WHERE token_hash=?', (hashlib.sha256(token.encode()).hexdigest(),))

    def save_equipment(self, equipment_id, name, color):
        name = clean_text(name, '장비명', 60)
        if not isinstance(color, str) or not COLOR.fullmatch(color):
            raise ValidationError('장비 색상을 선택해 주세요.')
        color = color.lower()
        with self.connect() as conn:
            if equipment_id is None:
                cursor = conn.execute('INSERT INTO equipment(name,color) VALUES(?,?)', (name, color))
                equipment_id = cursor.lastrowid
            else:
                equipment_id = int_id(equipment_id)
                cursor = conn.execute('UPDATE equipment SET name=?,color=? WHERE id=?', (name, color, equipment_id))
                if cursor.rowcount == 0:
                    raise NotFoundError('장비를 찾을 수 없습니다.')
            return self._row(conn.execute('SELECT id,name,color FROM equipment WHERE id=?', (equipment_id,)).fetchone())

    def save_booking(self, booking_id, user_id, equipment_id, start, end, note):
        equipment_id = int_id(equipment_id)
        start_dt = checked_datetime(start)
        end_dt = checked_datetime(end)
        note = clean_text(note, '메모', 160, required=False)
        if end_dt <= start_dt:
            raise ValidationError('종료 시간은 시작 시간보다 늦어야 합니다.')
        if end_dt - start_dt > timedelta(days=365):
            raise ValidationError('한 번에 최대 365일까지 예약할 수 있습니다.')
        with self.connect() as conn:
            conn.execute('BEGIN IMMEDIATE')
            try:
                if not conn.execute('SELECT id FROM equipment WHERE id=?', (equipment_id,)).fetchone():
                    raise NotFoundError('장비를 찾을 수 없습니다.')
                if booking_id is not None:
                    booking_id = int_id(booking_id)
                    old = conn.execute('SELECT user_id FROM bookings WHERE id=?', (booking_id,)).fetchone()
                    if old is None:
                        raise NotFoundError('예약을 찾을 수 없습니다.')
                    if old['user_id'] != user_id:
                        raise ForbiddenError('본인의 예약만 변경할 수 있습니다.')
                overlap = conn.execute('''SELECT b.id,b.start,b.end,u.name AS user_name
                                          FROM bookings b JOIN users u ON u.id=b.user_id
                                          WHERE b.equipment_id=? AND b.start<? AND b.end>?
                                          AND b.id != ? ORDER BY b.start LIMIT 1''',
                                       (equipment_id, end, start, booking_id or 0)).fetchone()
                if overlap:
                    raise ConflictError('이미 예약된 시간과 겹칩니다. 다른 시간을 선택해 주세요.', dict(overlap))
                if booking_id is None:
                    cursor = conn.execute('INSERT INTO bookings(equipment_id,user_id,start,end,note) VALUES(?,?,?,?,?)',
                                          (equipment_id, user_id, start, end, note))
                    booking_id = cursor.lastrowid
                else:
                    conn.execute('UPDATE bookings SET equipment_id=?,start=?,end=?,note=? WHERE id=?',
                                 (equipment_id, start, end, note, booking_id))
                result = self._row(conn.execute('SELECT * FROM bookings WHERE id=?', (booking_id,)).fetchone())
                conn.execute('COMMIT')
                return result
            except Exception:
                conn.execute('ROLLBACK')
                raise

    def delete_booking(self, booking_id, user_id):
        booking_id = int_id(booking_id)
        with self.connect() as conn:
            conn.execute('BEGIN IMMEDIATE')
            try:
                old = conn.execute('SELECT user_id FROM bookings WHERE id=?', (booking_id,)).fetchone()
                if old is None:
                    raise NotFoundError('예약을 찾을 수 없습니다.')
                if old['user_id'] != user_id:
                    raise ForbiddenError('본인의 예약만 삭제할 수 있습니다.')
                conn.execute('DELETE FROM bookings WHERE id=?', (booking_id,))
                conn.execute('COMMIT')
            except Exception:
                conn.execute('ROLLBACK')
                raise

    def state(self, start_date, end_date):
        start = checked_date(start_date)
        end = checked_date(end_date)
        if end <= start or end - start > timedelta(days=100):
            raise ValidationError('조회 기간을 확인해 주세요.')
        with self.connect() as conn:
            equipment = [dict(row) for row in conn.execute('SELECT id,name,color FROM equipment ORDER BY id')]
            bookings = [dict(row) for row in conn.execute('''SELECT b.id,b.equipment_id,b.user_id,b.start,b.end,b.note,
                        u.name AS user_name FROM bookings b JOIN users u ON u.id=b.user_id
                        WHERE b.start<? AND b.end>? ORDER BY b.start,b.id''',
                        (end_date + 'T00:00', start_date + 'T00:00'))]
        return {'equipment': equipment, 'bookings': bookings}


def load_config(path):
    config = {'demo_mode': True, 'public_base_url': '', 'google_client_id': '',
              'google_client_secret': '', 'allowed_emails': []}
    if path.exists():
        with path.open(encoding='utf-8') as source:
            supplied = json.load(source)
        if not isinstance(supplied, dict):
            raise ValueError('config.local.json must contain an object')
        config.update(supplied)
    config['demo_mode'] = config.get('demo_mode') is True
    config['public_base_url'] = str(config.get('public_base_url') or '').rstrip('/')
    config['google_enabled'] = bool(config.get('google_client_id') and config.get('google_client_secret') and config['public_base_url'])
    if not config['demo_mode'] and not config['google_enabled']:
        raise ValueError('Google login is not configured and demo mode is disabled.')
    if config['google_enabled']:
        parsed = urlsplit(config['public_base_url'])
        if parsed.path or parsed.query or parsed.fragment or parsed.username or parsed.password or not parsed.hostname:
            raise ValueError('public_base_url must be an origin, for example https://calendar.example.com')
        if parsed.scheme != 'https' and not (parsed.scheme == 'http' and parsed.hostname in ('localhost', '127.0.0.1', '::1')):
            raise ValueError('Google login requires HTTPS except on localhost.')
    if not isinstance(config.get('allowed_emails'), list):
        raise ValueError('allowed_emails must be a list.')
    config['allowed_emails'] = [str(x).strip().lower() for x in config['allowed_emails'] if str(x).strip()]
    return config


def request_json(url, data=None, headers=None):
    req = Request(url, data=data, headers=headers or {}, method='POST' if data is not None else 'GET')
    with urlopen(req, timeout=12) as response:
        if response.status != 200:
            raise RuntimeError('Google authentication failed')
        return json.loads(response.read(100000).decode('utf-8'))


class CalendarServer(ThreadingHTTPServer):
    daemon_threads = True
    def __init__(self, server_address, store, config):
        super().__init__(server_address, CalendarHandler)
        self.store = store
        self.config = config
        self.pending = {}
        self.pending_lock = threading.Lock()


class CalendarHandler(BaseHTTPRequestHandler):
    server_version = 'EquipmentCalendar/1.0'
    def log_message(self, fmt, *args):
        # URLs can contain OAuth codes; never put them in access logs.
        pass

    def _headers(self, status=200, content_type='application/json; charset=utf-8', cookie=None, location=None):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
        if cookie:
            self.send_header('Set-Cookie', cookie)
        if location:
            self.send_header('Location', location)
        self.end_headers()

    def _json(self, status, value, cookie=None):
        data = json.dumps(value, ensure_ascii=False).encode('utf-8')
        self._headers(status, cookie=cookie)
        self.wfile.write(data)

    def _redirect(self, path, cookie=None):
        self._headers(303, content_type='text/plain; charset=utf-8', cookie=cookie, location=path)

    def _cookie_value(self, name):
        try:
            jar = cookies.SimpleCookie(self.headers.get('Cookie', ''))
            return jar[name].value if name in jar else ''
        except cookies.CookieError:
            return ''

    def _session_cookie(self, token, clear=False):
        secure = '; Secure' if self.server.config['public_base_url'].startswith('https://') else ''
        age = 0 if clear else 86400 * 14
        return f'calendar_session={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={age}{secure}'

    def _user(self):
        user = self.server.store.session_user(self._cookie_value('calendar_session'))
        if user and user['provider'] == 'demo' and not self.server.config['demo_mode']:
            return None
        return user

    def _require_user(self, require_name=True):
        user = self._user()
        if not user:
            error = AppError('로그인 후 이용해 주세요.')
            error.status = 401
            raise error
        if require_name and not user['name_confirmed']:
            raise ForbiddenError('예약에 표시할 실명을 먼저 등록해 주세요.')
        return user

    def _check_origin(self):
        origin = self.headers.get('Origin', '')
        if not origin:
            raise ForbiddenError('요청 출처를 확인할 수 없습니다. 페이지를 새로고침해 주세요.')
        base = self.server.config['public_base_url']
        if not base:
            scheme = 'https' if isinstance(self.connection, ssl.SSLSocket) else 'http'
            base = f'{scheme}://{self.headers.get("Host", "")}'
        if not hmac.compare_digest(origin, base):
            raise ForbiddenError('허용되지 않은 요청입니다.')

    def _body(self):
        self._check_origin()
        if self.headers.get_content_type() != 'application/json':
            raise ValidationError('요청 형식이 올바르지 않습니다.')
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if length < 1 or length > 32768:
                raise ValueError()
            value = json.loads(self.rfile.read(length).decode('utf-8'))
            if not isinstance(value, dict):
                raise ValueError()
            return value
        except (ValueError, UnicodeError, json.JSONDecodeError) as exc:
            raise ValidationError('요청 내용을 확인해 주세요.') from exc

    def do_GET(self):
        try:
            parsed = urlsplit(self.path)
            if parsed.path == '/api/state':
                params = parse_qs(parsed.query)
                user = self._user()
                config = self.server.config
                if not user and not config['demo_mode']:
                    result = {'equipment': [], 'bookings': []}
                else:
                    result = self.server.store.state(params.get('start', [''])[0], params.get('end', [''])[0])
                result.update({'user': user, 'demo_mode': config['demo_mode'],
                               'google_enabled': config['google_enabled'], 'timezone': 'Asia/Seoul'})
                self._json(200, result)
            elif parsed.path == '/auth/google/start':
                self._google_start()
            elif parsed.path == '/auth/google/callback':
                self._google_callback(parse_qs(parsed.query))
            else:
                self._static(parsed.path)
        except AppError as exc:
            self._json(exc.status, {'error': str(exc)})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            traceback.print_exc(file=sys.stderr)
            self._json(500, {'error': '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.'})

    def do_POST(self):
        try:
            path = urlsplit(self.path).path
            body = self._body()
            store = self.server.store
            if path == '/api/demo/login':
                if not self.server.config['demo_mode']:
                    raise ForbiddenError('시험 모드가 꺼져 있습니다.')
                user = store.upsert_demo_user(body.get('name', ''))
                self._json(200, {'user': user}, cookie=self._session_cookie(store.create_session(user['id'])))
            elif path == '/api/logout':
                store.delete_session(self._cookie_value('calendar_session'))
                self._json(200, {'ok': True}, cookie=self._session_cookie('', clear=True))
            elif path == '/api/profile':
                user = self._require_user(require_name=False)
                store.update_name(user['id'], body.get('name', ''))
                self._json(200, {'ok': True})
            elif path == '/api/equipment':
                self._require_user()
                item = store.save_equipment(body.get('id'), body.get('name', ''), body.get('color', ''))
                self._json(200, {'equipment': item})
            elif path == '/api/bookings':
                user = self._require_user()
                item = store.save_booking(body.get('id'), user['id'], body.get('equipment_id'),
                                          body.get('start'), body.get('end'), body.get('note', ''))
                self._json(200, {'booking': item})
            elif path == '/api/bookings/delete':
                user = self._require_user()
                store.delete_booking(body.get('id'), user['id'])
                self._json(200, {'ok': True})
            else:
                raise NotFoundError('요청한 항목을 찾을 수 없습니다.')
        except AppError as exc:
            result = {'error': str(exc)}
            if isinstance(exc, ConflictError) and exc.conflicting:
                result['conflicting'] = exc.conflicting
            self._json(exc.status, result)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            traceback.print_exc(file=sys.stderr)
            self._json(500, {'error': '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.'})

    def _static(self, requested):
        allowed = {'/': ('index.html', 'text/html; charset=utf-8'),
                   '/app.js': ('app.js', 'application/javascript; charset=utf-8'),
                   '/styles.css': ('styles.css', 'text/css; charset=utf-8'),
                   '/WantedSans-Regular.woff': ('WantedSans-Regular.woff', 'font/woff'),
                   '/WantedSans-Bold.woff': ('WantedSans-Bold.woff', 'font/woff'),
                   '/favicon.svg': ('favicon.svg', 'image/svg+xml')}
        if requested not in allowed:
            raise NotFoundError('페이지를 찾을 수 없습니다.')
        name, kind = allowed[requested]
        data = (WEB / name).read_bytes()
        self._headers(200, kind)
        self.wfile.write(data)

    def _google_start(self):
        cfg = self.server.config
        if not cfg['google_enabled']:
            self._redirect('/?auth=unconfigured')
            return
        state = secrets.token_urlsafe(32)
        verifier = secrets.token_urlsafe(64)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
        with self.server.pending_lock:
            now = time.time()
            self.server.pending = {k: v for k, v in self.server.pending.items() if v['time'] > now - 600}
            self.server.pending[state] = {'time': now, 'verifier': verifier}
        query = urlencode({'client_id': cfg['google_client_id'], 'redirect_uri': cfg['public_base_url'] + '/auth/google/callback',
                           'response_type': 'code', 'scope': 'openid email profile', 'state': state,
                           'code_challenge': challenge, 'code_challenge_method': 'S256', 'prompt': 'select_account'})
        secure = '; Secure' if cfg['public_base_url'].startswith('https://') else ''
        self._redirect('https://accounts.google.com/o/oauth2/v2/auth?' + query,
                       cookie=f'calendar_oauth_state={state}; Path=/auth/google/callback; HttpOnly; SameSite=Lax; Max-Age=600{secure}')

    def _google_callback(self, query):
        state = query.get('state', [''])[0]
        cookie_state = self._cookie_value('calendar_oauth_state')
        if not state or not cookie_state or not hmac.compare_digest(state, cookie_state):
            self._redirect('/?auth=state_error')
            return
        with self.server.pending_lock:
            pending = self.server.pending.pop(state, None)
        if not pending or pending['time'] < time.time() - 600 or not query.get('code'):
            self._redirect('/?auth=cancelled')
            return
        cfg = self.server.config
        try:
            payload = urlencode({'code': query['code'][0], 'client_id': cfg['google_client_id'],
                                 'client_secret': cfg['google_client_secret'], 'code_verifier': pending['verifier'],
                                 'redirect_uri': cfg['public_base_url'] + '/auth/google/callback',
                                 'grant_type': 'authorization_code'}).encode('utf-8')
            tokens = request_json('https://oauth2.googleapis.com/token', payload,
                                  {'Content-Type': 'application/x-www-form-urlencoded'})
            info = request_json('https://openidconnect.googleapis.com/v1/userinfo', headers={'Authorization': 'Bearer ' + tokens['access_token']})
            if not info.get('sub') or info.get('email_verified') is not True or not info.get('email'):
                raise ValueError('Missing or unverified Google identity')
            email = info['email'].lower()
            if cfg['allowed_emails'] and email not in cfg['allowed_emails']:
                self._redirect('/?auth=not_allowed')
                return
            name = str(info.get('name') or '').strip()[:40]
            if not name:
                name = email.split('@')[0][:40]
            user = self.server.store.upsert_user('google', str(info['sub']), email, name)
            self._redirect('/', cookie=self._session_cookie(self.server.store.create_session(user['id'])))
        except (HTTPError, URLError, ValueError, KeyError, TimeoutError):
            self._redirect('/?auth=failed')


def main():
    parser = argparse.ArgumentParser(description='장비 예약 캘린더 서버')
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--config', type=Path, default=DATA / 'config.local.json')
    parser.add_argument('--db', type=Path, default=DATA / 'calendar.sqlite3')
    parser.add_argument('--cert', type=Path, help='HTTPS certificate PEM')
    parser.add_argument('--key', type=Path, help='HTTPS private key PEM')
    args = parser.parse_args()
    try:
        if bool(args.cert) != bool(args.key):
            parser.error('--cert and --key must be used together')
        config = load_config(args.config)
        server = CalendarServer((args.host, args.port), CalendarStore(args.db), config)
        if args.cert:
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(str(args.cert), str(args.key))
            server.socket = context.wrap_socket(server.socket, server_side=True)
        scheme = 'https' if args.cert else 'http'
        display_host = 'localhost' if args.host in ('0.0.0.0', '127.0.0.1') else args.host
        print(f'장비 예약 캘린더 실행 중: {scheme}://{display_host}:{server.server_port}', flush=True)
        print('시험 모드: ' + ('켜짐 (이름만으로 로그인)' if config['demo_mode'] else '꺼짐'), flush=True)
        print('내부망에 공유하려면 서버를 해당 네트워크의 IPv4 주소로 실행하세요.', flush=True)
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n서버를 종료합니다.', flush=True)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f'서버를 시작하지 못했습니다: {exc}', file=sys.stderr, flush=True)
        sys.exit(1)


if __name__ == '__main__':
    main()
