import http.client
import importlib.util
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('calendar_server_http', ROOT / 'self-hosted' / 'server.py')
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = app.CalendarStore(Path(self.tmp.name) / 'calendar.sqlite3')
        self.config = {'demo_mode': True, 'google_enabled': False, 'public_base_url': '',
                       'google_client_id': '', 'google_client_secret': '', 'allowed_emails': []}
        self.server = app.CalendarServer(('127.0.0.1', 0), self.store, self.config)
        self.port = self.server.server_port
        self.base = f'http://localhost:{self.port}'
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.tmp.cleanup()

    def call(self, method, path, body=None, cookie='', origin=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        headers = {'Host': f'localhost:{self.port}'}
        if cookie: headers['Cookie'] = cookie
        if body is not None:
            headers['Content-Type'] = 'application/json'
            headers['Origin'] = self.base if origin is None else origin
            body = json.dumps(body, ensure_ascii=False).encode('utf-8')
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        content = response.read()
        result = (response.status, dict(response.getheaders()), content)
        connection.close()
        return result

    def login(self, name):
        status, headers, payload = self.call('POST', '/api/demo/login', {'name': name})
        self.assertEqual(status, 200)
        return headers['Set-Cookie'].split(';', 1)[0]

    def test_multiuser_persistence_conflict_permissions_and_deletion(self):
        self.assertEqual(self.call('POST', '/api/equipment', {'name': '장비', 'color': '#123456'})[0], 401)
        alice = self.login('사용자 A')
        bob = self.login('사용자 B')
        self.assertEqual(self.call('POST', '/api/equipment', {'name': '장비', 'color': '#123456'}, alice, 'https://evil.example')[0], 403)
        status, _, data = self.call('POST', '/api/equipment', {'name': '장비', 'color': '#123456'}, alice)
        self.assertEqual(status, 200)
        equipment_id = json.loads(data)['equipment']['id']
        booking = {'equipment_id': equipment_id, 'start': '2026-11-09T22:00', 'end': '2026-11-10T09:00', 'note': '밤'}
        status, _, data = self.call('POST', '/api/bookings', booking, alice)
        self.assertEqual(status, 200)
        booking_id = json.loads(data)['booking']['id']
        status, _, data = self.call('POST', '/api/bookings', {**booking, 'start':'2026-11-10T08:00','end':'2026-11-10T09:30'}, bob)
        self.assertEqual(status, 409)
        self.assertEqual(json.loads(data)['conflicting']['end'], '2026-11-10T09:00')
        self.assertEqual(self.call('POST', '/api/bookings/delete', {'id': booking_id}, bob)[0], 403)
        self.assertEqual(self.call('POST', '/api/bookings', {**booking,'id':booking_id}, bob)[0], 403)
        status, _, data = self.call('GET', '/api/state?start=2026-11-10&end=2026-11-11', cookie=bob)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data)['bookings'][0]['note'], '밤')
        self.assertEqual(self.call('POST', '/api/bookings/delete', {'id': booking_id}, alice)[0], 200)
        self.assertEqual(self.call('POST', '/api/bookings', booking, bob)[0], 200)

    def test_google_flow_state_pkce_and_registration_with_stubbed_google_responses(self):
        self.config.update({'demo_mode': False, 'google_enabled': True, 'public_base_url': self.base,
                            'google_client_id': 'example-client', 'google_client_secret': 'example-secret'})
        status, headers, _ = self.call('GET', '/api/state?start=2026-11-10&end=2026-11-11')
        self.assertEqual(status, 200)
        status, headers, _ = self.call('GET', '/auth/google/start')
        self.assertEqual(status, 303)
        params = parse_qs(urlsplit(headers['Location']).query)
        self.assertEqual(params['code_challenge_method'], ['S256'])
        cookie = headers['Set-Cookie'].split(';', 1)[0]
        callback = '/auth/google/callback?state=' + params['state'][0] + '&code=example-code'
        self.assertEqual(self.call('GET', callback, cookie='calendar_oauth_state=wrong')[1]['Location'], '/?auth=state_error')
        fake = [{'access_token':'example-access'}, {'sub':'google-stable-id','email':'user@example.com','email_verified':True,'name':'프로필이름'}]
        with patch.object(app, 'request_json', side_effect=fake):
            status, headers, _ = self.call('GET', callback, cookie=cookie)
        self.assertEqual(status, 303)
        self.assertEqual(headers['Location'], '/')
        session = headers['Set-Cookie'].split(';', 1)[0]
        self.assertEqual(self.call('POST', '/api/equipment', {'name':'장비','color':'#123456'}, session)[0], 403)
        self.assertEqual(self.call('POST', '/api/profile', {'name':'실명입력'}, session)[0], 200)
        self.assertEqual(self.call('POST', '/api/equipment', {'name':'장비','color':'#123456'}, session)[0], 200)
        self.assertEqual(self.call('GET', callback, cookie=cookie)[1]['Location'], '/?auth=cancelled')

    def test_demo_session_is_invalid_after_disabling_demo(self):
        session = self.login('가상 계정')
        self.config['demo_mode'] = False
        self.assertEqual(self.call('POST', '/api/equipment', {'name':'장비','color':'#123456'}, session)[0], 401)

    def test_google_rejects_unverified_or_unlisted_email(self):
        self.config.update({'demo_mode': False, 'google_enabled': True, 'public_base_url': self.base,
                            'google_client_id': 'example-client', 'google_client_secret': 'example-secret',
                            'allowed_emails': ['permitted@example.com']})
        for verified, expected in [(False, '/?auth=failed'), (True, '/?auth=not_allowed')]:
            _, headers, _ = self.call('GET', '/auth/google/start')
            params = parse_qs(urlsplit(headers['Location']).query)
            cookie = headers['Set-Cookie'].split(';', 1)[0]
            callback = '/auth/google/callback?state=' + params['state'][0] + '&code=example-code'
            fake = [{'access_token':'example-access'}, {'sub':'different-id','email':'other@example.com','email_verified':verified,'name':'시험'}]
            with patch.object(app, 'request_json', side_effect=fake):
                status, reply, _ = self.call('GET', callback, cookie=cookie)
            self.assertEqual(status, 303)
            self.assertEqual(reply['Location'], expected)
            self.assertNotIn('Set-Cookie', reply)


if __name__ == '__main__':
    unittest.main()
