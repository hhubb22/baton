"""只允许明确的说明文档跳过重检查，未知路径执行全部检查。"""
import argparse
import json
import os
from pathlib import PurePosixPath
import subprocess


def documentation(path):
    p = PurePosixPath(path)
    return (path in {'README.md', 'AGENTS.md', '.agents/PROJECT.md'}
            or (p.suffix == '.md' and p.parts[0] in {'specs', '.agents'}))


def classify(paths):
    return 'docs' if paths and all(documentation(p) for p in paths) else 'full'


def aggregate(scope, results):
    expected = 'skipped' if scope == 'docs' else 'success'
    return scope in {'docs', 'full'} and bool(results) and all(result == expected for result in results)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('base')
    parser.add_argument('head')
    args = parser.parse_args()
    # --no-renames 同时检查移动前后的路径，避免把代码移动到说明目录后误跳过。
    raw = subprocess.check_output(['git', 'diff', '--no-renames', '--name-only', '-z', args.base, args.head])
    paths = [p.decode('utf-8', errors='replace') for p in raw.split(b'\0') if p]
    scope = classify(paths)
    print(json.dumps({'scope': scope, 'paths': paths}, ensure_ascii=False))
    with open(os.environ['GITHUB_OUTPUT'], 'a') as f:
        f.write(f'scope={scope}\n')
