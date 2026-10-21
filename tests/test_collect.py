import datetime as dt
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from scripts.collect import api_to_models, load_history, save, update_history


def at(day):
    return dt.datetime.fromisoformat(day + 'T02:23:00+00:00')


def example(id, all_time=100, last_30d=20):
    return {"id": id, "all_time": all_time, "last_30d": last_30d,
            "likes": 1, "pipeline": "other", "created_at": None}


class CollectorTests(unittest.TestCase):
    def test_only_account_public_models(self):
        models = api_to_models([
            SimpleNamespace(id='gatilin/A', downloads_all_time=80, downloads=22, likes=1, pipeline_tag='other', private=False, created_at=None),
            SimpleNamespace(id='other/B', downloads_all_time=10, downloads=5, private=False),
            SimpleNamespace(id='gatilin/private', downloads_all_time=10, downloads=5, private=True),
        ], 'gatilin')
        self.assertEqual(len(models), 1)
        self.assertEqual(models[0]['all_time'], 80)
        self.assertEqual(models[0]['last_30d'], 22)

    def test_same_day_replace_next_day_append_and_negative_preserved(self):
        base = {"schema_version": 1, "author": "gatilin", "updated_at": None, "snapshots": []}
        one = update_history(base, [example('gatilin/A', 100, 25)], at('2026-10-20'))
        replaced = update_history(one, [example('gatilin/A', 105, 27)], at('2026-10-20'))
        self.assertEqual(len(replaced['snapshots']), 1)
        self.assertEqual(replaced['snapshots'][0]['models']['gatilin/A'], [105, 27])
        later = update_history(replaced, [example('gatilin/A', 95, 21)], at('2026-10-21'))
        self.assertEqual(len(later['snapshots']), 2)
        self.assertEqual(later['snapshots'][-1]['models']['gatilin/A'], [95, 21])

    def test_null_is_not_zero(self):
        models = api_to_models([SimpleNamespace(id='gatilin/test', downloads_all_time=None, downloads=0, likes=None, pipeline_tag=None, private=False)], 'gatilin')
        self.assertIsNone(models[0]['all_time'])
        self.assertEqual(models[0]['last_30d'], 0)

    def test_large_drop_guard(self):
        h = update_history({"schema_version": 1, "author": "gatilin", "updated_at": None, "snapshots": []},
                           [example(f'gatilin/A{i}') for i in range(20)], at('2026-10-20'))
        with self.assertRaises(ValueError):
            update_history(h, [example('gatilin/A0')], at('2026-10-21'))

    def test_same_day_protection_and_out_of_order_protection(self):
        base = {"schema_version": 1, "author": "gatilin", "updated_at": None, "snapshots": []}
        h = update_history(base, [example(f'gatilin/A{i}') for i in range(20)], at('2026-10-20'))
        with self.assertRaises(ValueError):
            update_history(h, [example('gatilin/A0')], at('2026-10-20'))
        with self.assertRaises(ValueError):
            update_history(h, [example('gatilin/A0')], at('2026-10-19'))

    def test_write_and_read(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            save(p, 'gatilin', [example('gatilin/A', 10, 20)], at('2026-10-20'))
            obj = load_history(p/'history.json', 'gatilin')
            self.assertEqual(obj['snapshots'][0]['date'], '2026-10-20')
            self.assertEqual(obj['snapshots'][0]['models']['gatilin/A'], [10, 20])


if __name__ == '__main__':
    unittest.main()
