"""Run the real commands and save their output as terminal sessions for term.js.
python3 docs/figures/src/capture.py <scratch dir>"""
import json, os, re, subprocess, sys, shutil
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../.."))
SP = sys.argv[1]
NOISE = re.compile(r"polyfill|Require stack|^- /|canvas'|Seeded default users", re.I)
def run(cmd, env=None):
    e = dict(os.environ, FORCE_COLOR="1", **(env or {}))
    out = subprocess.run(cmd, shell=True, cwd=ROOT, env=e, capture_output=True, text=True).stdout
    return "\n".join(l for l in out.splitlines() if not NOISE.search(l))

# --- session A: tests + evaluation ---
tests = run("node --test --test-reporter=spec tests/*.test.js")
tests = re.sub(r"\x1b\[90m\(\d+\.\d+ms\)\x1b\[39m", "", tests)
tests = "\n".join(l for l in tests.splitlines() if not re.search(r"suites|cancelled|skipped|todo", l))
ev = run("node eval/run.js && python3 eval/report.py")
ev = "\n".join(l for l in ev.splitlines() if l.strip() != "wrote REPORT.md + 3 charts")
json.dump({"title": "Tests and the v1-vs-v2 evaluation — real output", "blocks": [
    {"cmd": "npm test", "out": tests},
    {"cmd": "npm run eval", "out": ev}]}, open(os.path.join(SP, "sessA.json"), "w"))

# --- session B: audit trace ---
db = os.path.join(SP, "tracedb"); shutil.rmtree(db, ignore_errors=True)
env = {"DATA_DIR": db}
run("node scripts/seed.js", env); run(f"node docs/figures/src/demo_trace.js {SP}/ids.json", env)
json.dump({"title": "Audit trail — every stock figure traces back to a file, a line and a person", "blocks": [
    {"cmd": "node scripts/trace.js --batch 1", "out": run("node scripts/trace.js --batch 1", env)},
    {"cmd": "node scripts/trace.js --batch 2      # supplier re-sent the same file", "out": run("node scripts/trace.js --batch 2", env)},
    {"cmd": "node scripts/trace.js BA325MT1GCM12X035F", "out": run("node scripts/trace.js BA325MT1GCM12X035F", env)}]},
    open(os.path.join(SP, "sessB.json"), "w"))
print("captured")
