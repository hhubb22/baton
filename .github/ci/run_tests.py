"""并行运行完整测试分组，保存脱敏材料和原始失败结论。"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
RELAY = 'baton/internal/relay'
RACE = ['./internal/agent/...', './internal/session', './internal/node',
        './internal/store', './internal/control']


def scrub(text):
    secrets = [v for k, v in os.environ.items() if v and any(
        word in k.upper() for word in ('TOKEN', 'SECRET', 'PASSWORD', 'CREDENTIAL', 'DATABASE_URL', 'API_KEY'))]
    for value in sorted(secrets, key=len, reverse=True):
        text = text.replace(value, '[已隐藏]')
    text = re.sub(r'(?i)(?:postgres(?:ql)?://)[^\s"\']+', '[数据库地址已隐藏]', text)
    text = re.sub(r'(?i)\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+', r'\1 [已隐藏]', text)
    text = re.sub(r'(?i)((?:token|secret|password|credential|cookie|api[_-]?key)["\']?\s*[:=]\s*)(?:"[^"\n]*"|\S+)', r'\1[已隐藏]', text)
    return text



class EventLog:
    """test2json 可把一行拆成多块，按包和用例恢复整行后脱敏。"""
    def __init__(self, file):
        self.file = file
        self.pending = {}

    def emit(self, event):
        safe = {k: scrub(v) if isinstance(v, str) else v for k, v in event.items()}
        self.file.write(json.dumps(safe, ensure_ascii=False) + '\n')
        self.file.flush()

    def write(self, event):
        key = (event.get('Package'), event.get('Test'))
        if 'Output' in event:
            text = self.pending.pop(key, '') + event['Output']
            lines = text.split('\n')
            self.pending[key] = lines.pop()
            for line in lines:
                self.emit(dict(event, Output=line + '\n'))
        else:
            self.flush(key)
            self.emit(event)

    def flush(self, key=None):
        keys = list(self.pending) if key is None else [key]
        for item in keys:
            text = self.pending.pop(item, '')
            if text:
                self.emit({'Package': item[0], 'Test': item[1], 'Action': 'output', 'Output': text})

def partition(names, weights, count):
    groups, totals = [[] for _ in range(count)], [0.0] * count
    for name in sorted(names, key=lambda n: (-weights.get(n, 3.0), n)):
        index = min(range(count), key=lambda i: (totals[i], i))
        groups[index].append(name)
        totals[index] += weights.get(name, 3.0)
    flat = sum(groups, [])
    if len(flat) != len(set(flat)) or sorted(flat) != sorted(names):
        raise RuntimeError('测试分组未完整覆盖清单')
    return [sorted(group) for group in groups if group]


def output(command):
    return subprocess.check_output(command, cwd=ROOT, text=True, encoding='utf-8', errors='replace')


def snapshot(destination):
    if os.name == 'nt':
        command = ['powershell', '-NoProfile', '-Command',
                   'Get-Process | Select-Object Id,ProcessName,CPU,StartTime | ConvertTo-Json']
    else:
        command = ['ps', '-eo', 'pid,ppid,stat,etime,comm']
    try:
        destination.write_text(scrub(output(command)), encoding='utf-8')
    except Exception as error:
        destination.write_text(scrub(str(error)), encoding='utf-8')


def run_group(name, command, out, count, expected=None, strict=False):
    started = time.monotonic()
    directory = out / name
    directory.mkdir()
    env = dict(os.environ, BATON_TEST_DIAGNOSTICS_DIR=str(directory / 'processes'))
    failures, outcomes = [], {}
    code = 1
    snapshot(directory / 'processes-before.json')
    try:
        with (directory / 'tests.jsonl').open('w', encoding='utf-8') as log:
            events = EventLog(log)
            proc = subprocess.Popen(command, cwd=ROOT, env=env, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace')
            for line in proc.stdout:
                try:
                    event = json.loads(line)
                except ValueError:
                    events.write({'Output': line})
                    continue
                events.write(event)
                action, test = event.get('Action'), event.get('Test')
                if action in ('pass', 'skip', 'fail') and test:
                    key = test.split('/')[0]
                    if '/' not in test:
                        outcomes.setdefault(key, []).append(action)
                    if action == 'fail':
                        failures.append(test)
            events.flush()
            proc.stdout.close()
            code = proc.wait()
        # 原生重复诊断要求疑点用例真正执行，意外跳过同样失败。
        if expected is not None:
            for test in expected:
                actual = outcomes.get(test, [])
                if len(actual) != count or (strict and any(a != 'pass' for a in actual)):
                    failures.append(f'{test}: 预期 {count} 次，实际 {actual}')
                    code = code or 1
    except Exception as error:
        failures.append(scrub(str(error)))
    finally:
        snapshot(directory / 'processes-after.json')
    result = {'group': name, 'exit_code': code, 'seconds': round(time.monotonic() - started, 2),
              'failures': failures, 'outcomes': outcomes}
    (directory / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({k: v for k, v in result.items() if k != 'outcomes'}, ensure_ascii=False), flush=True)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--race', action='store_true')
    parser.add_argument('--package', help='诊断包，默认运行完整测试')
    parser.add_argument('--run', default='.')
    parser.add_argument('--count', type=int, default=1)
    parser.add_argument('--shards', type=int, default=3)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    if args.count < 1 or args.count > 100 or args.shards < 1 or args.shards > 8:
        parser.error('count 范围 1..100，shards 范围 1..8')
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=False)
    started = time.monotonic()
    results = []
    try:
        bins = out / 'bin'
        bins.mkdir()
        suffix = '.exe' if os.name == 'nt' else ''
        for name in ['coordinator', 'relay', 'batond']:
            subprocess.run(['go', 'build', '-o', str(bins / (name + suffix)), './cmd/' + name], cwd=ROOT, check=True)
        os.environ['BATON_TEST_BIN_DIR'] = str(bins)
        common = ['go', 'test', '-json', '-timeout=12m', f'-count={args.count}']
        if args.race:
            common.append('-race')
        list_common = ['go', 'test', '-list=.'] + (['-race'] if args.race else [])
        groups = []
        if args.package:
            names = [n for n in output(['go', 'test', '-list=' + args.run] + (['-race'] if args.race else []) + [args.package]).splitlines()
                     if re.match(r'^(Test|Example|Fuzz)\w*$', n)]
            if not names:
                raise RuntimeError('诊断选择没有匹配测试')
            groups.append(('diagnostic', common + ['-run=' + args.run, args.package], names))
        else:
            packages = output(['go', 'list'] + (RACE if args.race else ['./...'])).splitlines()
            others = [p for p in packages if p != RELAY]
            groups.append(('packages', common + others, None))
            names = [n for n in output(list_common + [RELAY]).splitlines() if re.match(r'^(Test|Example|Fuzz)\w*$', n)]
            weights = json.loads((ROOT / '.github/ci/relay-times.json').read_text())
            shards = partition(names, weights, args.shards)
            (out / 'coverage.json').write_text(json.dumps({'package': RELAY, 'all': names, 'shards': shards}, indent=2))
            for i, tests in enumerate(shards):
                groups.append((f'relay-{i + 1}', common + ['-run=^(' + '|'.join(tests) + ')$', RELAY], tests))
        with ThreadPoolExecutor(max_workers=len(groups)) as executor:
            futures = [executor.submit(run_group, name, command, out, args.count, expected, bool(args.package))
                       for name, command, expected in groups]
            results = [f.result() for f in futures]
    except Exception as error:
        results.append({'group': 'preparation', 'exit_code': 1, 'failures': [scrub(str(error))]})
    failed = any(r['exit_code'] for r in results) or not results
    summary = {'failed': failed, 'seconds': round(time.monotonic() - started, 2), 'groups': results}
    (out / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
    report = '\n'.join(['## Go 测试结果', '', f'结论：{"失败" if failed else "通过"}；耗时 {summary["seconds"]} 秒。', '',
                        '| 分组 | 退出码 | 秒数 | 失败 |', '|---|---:|---:|---|'] +
                       [f'| {r["group"]} | {r["exit_code"]} | {r.get("seconds", "")} | {scrub(str(r["failures"]))} |' for r in results])
    (out / 'summary.md').write_text(report, encoding='utf-8')
    if os.getenv('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as f:
            f.write(report + '\n')
    return int(failed)


if __name__ == '__main__':
    sys.exit(main())
