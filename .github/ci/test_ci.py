import unittest
from unittest.mock import patch
import io
import json
import tempfile
import sys
from pathlib import Path
from changes import aggregate, classify
from run_tests import EventLog, partition, scrub, run_group, port_floor, port_ranges, collect_postgres_log


class ContractTests(unittest.TestCase):
    def test_paths(self):
        for paths in [['README.md'], ['specs/baton/TECH.md', '.agents/PROJECT.md']]:
            self.assertEqual(classify(paths), 'docs')
        for paths in [[], ['go.mod'], ['go.sum'], ['internal/a.go'], ['internal/a_test.go'],
                      ['web/README.md'], ['internal/webui/dist/help.md'],
                      ['migrations/note.md'], ['.github/workflows/ci.yml'],
                      ['unknown.md'], ['README.md', 'cmd/baton/main.go']]:
            self.assertEqual(classify(paths), 'full', paths)

    def test_gate(self):
        self.assertTrue(aggregate('docs', ['skipped', 'skipped']))
        self.assertTrue(aggregate('full', ['success', 'success']))
        for scope, results in [('docs', ['success']), ('full', ['skipped']),
                               ('full', ['success', 'cancelled']), ('full', ['failure']),
                               ('docs', ['failure']), ('invalid', ['skipped']), ('full', [])]:
            self.assertFalse(aggregate(scope, results))

    def test_partition(self):
        names = ['TestSlow', 'TestNew', 'TestMedium', 'ExampleHello', 'FuzzParse']
        groups = partition(names, {'TestSlow': 30, 'TestMedium': 10}, 3)
        self.assertEqual(sorted(sum(groups, [])), sorted(names))
        self.assertEqual(len(sum(groups, [])), len(set(sum(groups, []))))

    def test_scrub(self):
        text = 'postgres://user:secret@localhost/db token=abc Authorization: Bearer def'
        result = scrub(text)
        for secret in ['secret', 'abc', 'def']:
            self.assertNotIn(secret, result)

    def test_split_json_output(self):
        file = io.StringIO()
        log = EventLog(file)
        for part in ['token=example-private-', 'token-abcdef012345\n']:
            log.write({'Package': 'p', 'Test': 'TestA', 'Output': part})
        log.flush()
        result = file.getvalue()
        self.assertNotIn('abcdef012345', result)
        for line in result.splitlines():
            json.loads(line)

    def test_postgres_log_is_scrubbed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'server.log'
            source.write_text('PANIC postgres://user:secret@localhost/db token=abc', encoding='utf-8')
            with patch.dict('os.environ', {'BATON_TEST_POSTGRES_LOG': str(source)}):
                collect_postgres_log(root)
            result = (root / 'postgres.log').read_text(encoding='utf-8')
            self.assertIn('PANIC', result)
            for secret in ['secret', 'abc']:
                self.assertNotIn(secret, result)

    def test_postgres_log_without_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict('os.environ', {}, clear=True):
                collect_postgres_log(Path(directory))
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_diagnostic_skip_fails(self):
        event = json.dumps({'Action': 'skip', 'Test': 'TestTarget'})
        with tempfile.TemporaryDirectory() as directory:
            command = [sys.executable, '-c', f'print({event!r})']
            console = io.TextIOWrapper(io.BytesIO(), encoding='ascii')
            with patch('sys.stdout', console):
                result = run_group('diagnostic', command, Path(directory), 1, ['TestTarget'], True)
        self.assertNotEqual(result['exit_code'], 0)

    def test_port_ranges(self):
        ranges = port_ranges(8, 32768)
        ports = [port for low, high in ranges for port in range(low, high + 1)]
        self.assertEqual(len(ports), len(set(ports)))
        self.assertLess(max(ports), 30000)
        for count, floor in [(0, 32768), (9, 32768), (3, 20000)]:
            with self.assertRaises(RuntimeError):
                port_ranges(count, floor)

    def test_native_port_floor(self):
        with patch('run_tests.sys.platform', 'linux'), patch('run_tests.Path.read_text', return_value='32768 60999'):
            self.assertEqual(port_floor(), 32768)
        with patch('run_tests.sys.platform', 'darwin'), patch('run_tests.output', return_value='49152'):
            self.assertEqual(port_floor(), 49152)
        with patch('run_tests.sys.platform', 'win32'), patch('run_tests.output', return_value='Start Port : 49152\nNumber of Ports : 16384'):
            self.assertEqual(port_floor(), 49152)
        with patch('run_tests.sys.platform', 'win32'), patch('run_tests.output', return_value='invalid'):
            with self.assertRaises(RuntimeError):
                port_floor()


if __name__ == '__main__':
    unittest.main()
