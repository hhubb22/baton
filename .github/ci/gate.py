"""汇总检查必须区分有意跳过和异常缺失。"""
import argparse
import json
from changes import aggregate

parser = argparse.ArgumentParser()
parser.add_argument('scope')
parser.add_argument('changes_result')
parser.add_argument('results', nargs='+')
args = parser.parse_args()
print(json.dumps(vars(args), ensure_ascii=False))
raise SystemExit(0 if args.changes_result == 'success' and aggregate(args.scope, args.results) else 1)
