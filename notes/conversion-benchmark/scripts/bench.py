#!/usr/bin/env python3
"""Run one GDAL command under /usr/bin/time -v with a memory/disk/time watchdog.

usage: bench.py <label> <final_output_path> -- <cmd...>
Env for the command is inherited (set GDAL_CACHEMAX, CPL_TMPDIR, ... outside).
Appends one JSON line per run to logs/results.jsonl.
"""
import json, os, signal, subprocess, sys, time

W = os.path.dirname(os.path.abspath(__file__))
OUT, TMP, LOGS = (os.path.join(W, d) for d in ("out", "tmp", "logs"))
GiB = 1024 ** 3
RSS_KILL = 6 * GiB          # coordinator rule: kill above 6 GiB RSS
AVAIL_START = 8 * GiB        # only start with >= 8 GiB MemAvailable
AVAIL_FLOOR = int(1.5 * GiB) # emergency stop if the host runs low
TIME_KILL = 40 * 60          # brief: stop runs that pass ~40 min


def mem_available():
    with open("/proc/meminfo") as f:
        for line in f:
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) * 1024


def tree_rss(root):
    """Sum VmRSS over root and all descendants."""
    kids = {}
    for p in os.listdir("/proc"):
        if not p.isdigit():
            continue
        try:
            with open(f"/proc/{p}/stat") as f:
                ppid = int(f.read().rsplit(")", 1)[1].split()[1])
            kids.setdefault(ppid, []).append(int(p))
        except Exception:
            pass
    total, stack = 0, [root]
    while stack:
        pid = stack.pop()
        try:
            with open(f"/proc/{pid}/status") as f:
                for line in f:
                    if line.startswith("VmRSS:"):
                        total += int(line.split()[1]) * 1024
        except Exception:
            pass
        stack.extend(kids.get(pid, []))
    return total


def alloc(path, exclude=None):
    """Allocated bytes (st_blocks) under path, optionally skipping one file."""
    total = 0
    for root, _, files in os.walk(path):
        for n in files:
            fp = os.path.join(root, n)
            if exclude and os.path.abspath(fp) == os.path.abspath(exclude):
                continue
            try:
                total += os.stat(fp).st_blocks * 512
            except FileNotFoundError:
                pass
    return total


def main():
    label, final = sys.argv[1], sys.argv[2]
    cmd = sys.argv[sys.argv.index("--") + 1:]
    waited = 0
    while mem_available() < AVAIL_START:
        if waited >= 600:
            rec = {"label": label, "result": "SKIPPED: MemAvailable < 8 GiB for 10 min",
                   "mem_available_gib": round(mem_available() / GiB, 2)}
            print(json.dumps(rec))
            open(os.path.join(LOGS, "results.jsonl"), "a").write(json.dumps(rec) + "\n")
            return
        time.sleep(10); waited += 10
    avail0 = mem_available()
    timef = os.path.join(LOGS, f"{label}.time")
    errf = open(os.path.join(LOGS, f"{label}.stderr"), "w")
    t0 = time.time()
    p = subprocess.Popen(["/usr/bin/time", "-v", "-o", timef] + cmd,
                         stdout=errf, stderr=errf, start_new_session=True)
    peak_rss = peak_total = peak_temp = 0
    min_avail = avail0
    result = "ok"
    while p.poll() is None:
        rss = tree_rss(p.pid)
        av = mem_available()
        tot = alloc(OUT) + alloc(TMP)
        tmp_only = alloc(TMP) + alloc(OUT, exclude=final)
        peak_rss, peak_total = max(peak_rss, rss), max(peak_total, tot)
        peak_temp, min_avail = max(peak_temp, tmp_only), min(min_avail, av)
        el = time.time() - t0
        reason = None
        if rss > RSS_KILL:
            reason = f"KILLED: RSS {rss / GiB:.2f} GiB > 6 GiB at {el:.0f}s"
        elif av < AVAIL_FLOOR:
            reason = f"KILLED: MemAvailable {av / GiB:.2f} GiB < 1.5 GiB at {el:.0f}s"
        elif el > TIME_KILL:
            reason = f"KILLED: wall > 40 min"
        if reason:
            os.killpg(p.pid, signal.SIGKILL)
            p.wait()
            result = reason
            break
        time.sleep(1)
    wall = time.time() - t0
    errf.close()
    tv = {}
    if os.path.exists(timef):
        for line in open(timef):
            if ":" in line:
                k, v = line.strip().rsplit(":", 1) if "Elapsed" not in line else (line.strip().split(": ", 1))
                tv[k.strip()] = v.strip()
    out_size = os.path.getsize(final) if os.path.exists(final) else None
    rec = {
        "label": label,
        "result": result if result != "ok" or p.returncode == 0 else f"exit {p.returncode}",
        "wall_s": round(wall, 1),
        "time_elapsed": tv.get("Elapsed (wall clock) time (h:mm:ss or m:ss)"),
        "user_s": float(tv.get("User time (seconds)", "nan")),
        "sys_s": float(tv.get("System time (seconds)", "nan")),
        "cpu_pct": tv.get("Percent of CPU this job got"),
        "maxrss_gib": round(int(tv.get("Maximum resident set size (kbytes)", "0")) * 1024 / GiB, 3),
        "poll_peak_rss_gib": round(peak_rss / GiB, 3),
        "peak_temp_gib": round(peak_temp / GiB, 3),
        "peak_out_plus_tmp_gib": round(peak_total / GiB, 3),
        "out_bytes": out_size,
        "out_gib": round(out_size / GiB, 3) if out_size else None,
        "mem_available_start_gib": round(avail0 / GiB, 2),
        "mem_available_min_gib": round(min_avail / GiB, 2),
        "fs_inputs": tv.get("File system inputs"),
        "fs_outputs": tv.get("File system outputs"),
        "cmd": " ".join(cmd),
        "env": {k: os.environ[k] for k in ("GDAL_CACHEMAX", "CPL_TMPDIR", "GDAL_NUM_THREADS",
                                           "GDAL_PAM_ENABLED") if k in os.environ},
    }
    print(json.dumps(rec, indent=1))
    with open(os.path.join(LOGS, "results.jsonl"), "a") as f:
        f.write(json.dumps(rec) + "\n")


if __name__ == "__main__":
    main()
