import importlib.util
import tempfile
import threading
import unittest
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[1] / 'self-hosted'
spec = importlib.util.spec_from_file_location('calendar_server', APP_DIR / 'server.py')
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)


class CalendarStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'calendar.sqlite3'
        self.store = app.CalendarStore(self.path)
        self.alice = self.store.upsert_demo_user('사용자 A')
        self.bob = self.store.upsert_demo_user('사용자 B')
        self.equipment = self.store.save_equipment(None, '현미경 1', '#e35d6a')

    def tearDown(self):
        self.tmp.cleanup()

    def test_overnight_overlap_and_adjacent_reservation(self):
        self.store.save_booking(None, self.alice['id'], self.equipment['id'],
                                '2026-11-09T22:00', '2026-11-10T09:00', '')
        with self.assertRaises(app.ConflictError):
            self.store.save_booking(None, self.bob['id'], self.equipment['id'],
                                    '2026-11-10T08:30', '2026-11-10T09:30', '')
        booking = self.store.save_booking(None, self.bob['id'], self.equipment['id'],
                                          '2026-11-10T09:00', '2026-11-10T10:00', '')
        self.assertEqual(booking['start'], '2026-11-10T09:00')

    def test_different_equipment_and_invalid_intervals(self):
        other = self.store.save_equipment(None, '현미경 2', '#4078df')
        self.store.save_booking(None, self.alice['id'], self.equipment['id'],
                                '2026-11-10T09:00', '2026-11-10T10:00', '')
        self.store.save_booking(None, self.bob['id'], other['id'],
                                '2026-11-10T09:00', '2026-11-10T10:00', '')
        for start, end in [('2026-11-10T10:00', '2026-11-10T10:00'),
                           ('2026-02-30T10:00', '2026-03-01T10:00'),
                           ('2026-11-10T11:00', '2026-11-10T10:00')]:
            with self.assertRaises(app.ValidationError):
                self.store.save_booking(None, self.bob['id'], other['id'], start, end, '')

    def test_ownership_and_edit_overlap(self):
        own = self.store.save_booking(None, self.alice['id'], self.equipment['id'],
                                      '2026-11-10T09:00', '2026-11-10T10:00', '')
        self.store.save_booking(None, self.bob['id'], self.equipment['id'],
                                '2026-11-10T11:00', '2026-11-10T12:00', '')
        with self.assertRaises(app.ForbiddenError):
            self.store.delete_booking(own['id'], self.bob['id'])
        with self.assertRaises(app.ForbiddenError):
            self.store.save_booking(own['id'], self.bob['id'], self.equipment['id'],
                                    '2026-11-10T08:00', '2026-11-10T10:00', '')
        with self.assertRaises(app.ConflictError):
            self.store.save_booking(own['id'], self.alice['id'], self.equipment['id'],
                                    '2026-11-10T09:00', '2026-11-10T11:30', '')

    def test_concurrent_collisions_only_one_wins(self):
        barrier = threading.Barrier(2)
        result = []
        def reserve(user):
            barrier.wait()
            try:
                self.store.save_booking(None, user['id'], self.equipment['id'],
                                        '2026-11-11T10:00', '2026-11-11T11:00', '')
                result.append('ok')
            except app.ConflictError:
                result.append('conflict')
        threads = [threading.Thread(target=reserve, args=(user,)) for user in (self.alice, self.bob)]
        for thread in threads: thread.start()
        for thread in threads: thread.join()
        self.assertCountEqual(result, ['ok', 'conflict'])

    def test_persistence_and_overlap_query(self):
        self.store.save_booking(None, self.alice['id'], self.equipment['id'],
                                '2026-11-09T22:00', '2026-11-10T09:00', '테스트')
        reopened = app.CalendarStore(self.path)
        result = reopened.state('2026-11-10', '2026-11-11')
        self.assertEqual(len(result['bookings']), 1)
        self.assertEqual(result['bookings'][0]['user_name'], '사용자 A')
        self.assertEqual(result['bookings'][0]['note'], '테스트')

    def test_equipment_validation(self):
        for name, color in [('', '#ffffff'), ('장비', 'red'), ('장비', '#fff')]:
            with self.assertRaises(app.ValidationError):
                self.store.save_equipment(None, name, color)


if __name__ == '__main__':
    unittest.main()
