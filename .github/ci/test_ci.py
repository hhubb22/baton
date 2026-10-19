import unittest
import io
import json
import tempfile
import sys
from pathlib import Path
from changes import aggregate, classify
from run_tests import EventLog, partition, scrub, run_group


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

    def test_diagnostic_skip_fails(self):
        event = json.dumps({'Action': 'skip', 'Test': 'TestTarget'})
        with tempfile.TemporaryDirectory() as directory:
            command = [sys.executable, '-c', f'print({event!r})']
            result = run_group('diagnostic', command, Path(directory), 1, ['TestTarget'], True)
        self.assertNotEqual(result['exit_code'], 0)


if __name__ == '__main__':
    unittest.main()
