"""Summarize the JSONL written by logged-server.mjs: requests, bytes, statuses,
HEAD probes, and how many times the file was read over."""

import collections
import json
import sys

rows = [json.loads(line) for line in open(sys.argv[1])]
size = int(sys.argv[2]) if len(sys.argv) > 2 else None
gets = [r for r in rows if r["method"] == "GET" and r["range"]]
print("requests", len(rows), "| ranged GETs", len(gets), "| bytes served", sum(r["bytes"] for r in rows))
print("status counts", dict(collections.Counter((r["method"], r["status"]) for r in rows)))
print("non-206 paths", dict(collections.Counter((r["method"], r["status"], r["path"]) for r in rows if r["status"] != 206)))
if size:
    print("file read over %.2fx" % (sum(r["bytes"] for r in gets) / size))
lens = collections.Counter(r["bytes"] for r in gets)
print("most common range sizes", lens.most_common(5))
multi = [r for r in rows if r["range"] and "," in r["range"]]
print("multi-range headers", len(multi))
