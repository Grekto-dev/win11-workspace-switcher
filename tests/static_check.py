#!/usr/bin/env python3
"""Static checks for Win11-Like Workspace Switcher: JS syntax, JSON, settings bindings, translations."""
import json, pathlib, re, subprocess, sys

root = pathlib.Path(__file__).resolve().parent.parent
errors = []

def err(msg):
    errors.append(msg)
    print("FAIL:", msg)

def ok(msg):
    print("ok  :", msg)

# 1. JS syntax via node --check
js_files = sorted(root.glob("*.js"))
for f in js_files:
    r = subprocess.run(["node", "--check", str(f)], capture_output=True, text=True)
    if r.returncode != 0:
        err(f"syntax {f.name}: {r.stderr.strip()}")
ok(f"node --check passed on {len(js_files)} files")

# 2. JSON files
meta = json.loads((root / "metadata.json").read_text())
schema = json.loads((root / "settings-schema.json").read_text())
for k in ("uuid", "name", "description", "max-instances"):
    if k not in meta:
        err(f"metadata.json missing {k}")
ok("metadata.json and settings-schema.json parse cleanly")

# 3. Settings key consistency between applet.js and settings-schema.json
src = (root / "applet.js").read_text()
bound = set(re.findall(r"bindProperty\((?:IN|BOTH),\s*'([a-z0-9-]+)'", src))
keys = {
    k for k, v in schema.items()
    if isinstance(v, dict) and "type" in v and v["type"] not in ("page", "section", "layout")
}
for k in sorted(bound - keys):
    err("bound in applet.js but missing from schema: " + k)
for k in sorted(keys - bound):
    err("in schema but never bound in applet.js: " + k)
ok(f"{len(bound)} settings keys consistent between applet.js and schema")

# 4. Layout resolution
layout = schema["layout1"]
for pg in layout["pages"]:
    if pg not in layout:
        err("missing page: " + pg)
        continue
    for sec in layout[pg]["sections"]:
        if sec not in layout:
            err("missing section: " + sec)
            continue
        for k in layout[sec]["keys"]:
            if k not in schema:
                err("layout key missing in schema: " + k)
ok("layout pages/sections/keys resolve")

# 5. Combobox defaults & dependencies
for k, v in schema.items():
    if not isinstance(v, dict):
        continue
    if v.get("type") == "combobox" and v["default"] not in v["options"].values():
        err("combobox default not in options: " + k)
    dep = v.get("dependency")
    if dep:
        name = re.sub(r"^!", "", dep).split("=")[0]
        if name not in schema:
            err(f"dependency missing: {k} -> {dep}")
ok("combobox defaults and dependencies valid")

# 6. PO compilation check
r = subprocess.run(
    ["msgfmt", "--check", "-o", "/tmp/_ws_check.mo", str(root / "po/pt_BR.po")],
    capture_output=True, text=True
)
if r.returncode != 0:
    err("msgfmt failed: " + r.stderr.strip())
else:
    ok("pt_BR.po compiles cleanly")

if errors:
    sys.exit(1)
print("ALL STATIC CHECKS PASSED")
