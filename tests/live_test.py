#!/usr/bin/env python3
"""Live integration tests for Win11-Like Workspace Switcher in running Cinnamon."""
import ast, json, os, pathlib, re, subprocess, sys, time

UUID = "win11-workspace-switcher@cinnamon"
A = f"imports.ui.appletManager.getRunningInstancesForUuid('{UUID}')[0]"
ERRLOG = pathlib.Path.home() / ".xsession-errors"
SHOTS = pathlib.Path(os.environ.get("WIN11_WS_SHOTS", "/tmp/win11-ws-shots"))
SHOTS.mkdir(parents=True, exist_ok=True)

results = []

def ev(js):
    r = subprocess.run(
        ["gdbus", "call", "--session", "--dest", "org.Cinnamon",
         "--object-path", "/org/Cinnamon", "--method", "org.Cinnamon.Eval", js],
        capture_output=True, text=True, check=True
    )
    return r.stdout.strip()

def evj(js):
    raw = ev(f"JSON.stringify({js})")
    m = re.match(r"^\((\w+),\s*(.*)\)$", raw, re.S)
    if not m or m.group(1) != "true":
        raise RuntimeError(f"Eval failed: {raw}")
    val = ast.literal_eval(m.group(2))
    val = json.loads(val)
    return json.loads(val) if isinstance(val, str) else val

def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + (f" -- {detail}" if detail and not cond else ""))
    return cond

def shot(name):
    p = SHOTS / f"{name}.png"
    if p.exists():
        p.unlink()
    subprocess.run(
        ["gnome-screenshot", "-f", str(p)],
        env={"DISPLAY": ":0", "DBUS_SESSION_BUS_ADDRESS": f"unix:path=/run/user/{subprocess.os.getuid()}/bus", "PATH": "/usr/bin:/bin"},
        capture_output=True, check=False
    )
    return p if p.exists() else None

err_start = ERRLOG.stat().st_size if ERRLOG.exists() else 0

# 1. Applet instance & button metrics
info = evj(f"(() => {{ const a = {A}; if (!a) return null; const [x,y]=a.buttonActor.get_transformed_position(); const [w,h]=a.buttonActor.get_transformed_size(); const [,py]=a.panel.actor.get_transformed_position(); const [,ph]=a.panel.actor.get_transformed_size(); return {{x,y,w,h,py,panelH:ph,ph:a._panelHeight,dark:a.isDark,nWs:global.workspace_manager.n_workspaces}}; }})()")
check("applet_loaded", info is not None, str(info))
check("button_40x40_at_48px_panel", info and round(info["w"]) == 40 and round(info["h"]) == 40, str(info))
check("button_vertically_centered", info and abs((info["y"] + info["h"] / 2) - (info["py"] + info["panelH"] / 2)) <= 1.0, str(info))

# 2. Hover Flyout
ev(f"{A}.flyout.open(true)")
time.sleep(0.45)
fl = evj(f"(() => {{ const a={A}; const f=a.flyout; const c=f.strip && f.strip.cards[0]; const [fx,fy]=f.actor.get_transformed_position(); const [fw,fh]=f.actor.get_transformed_size(); const [cw,ch]=c.actor.get_transformed_size(); return {{open:f.isOpen, cards:f.strip.cards.length, hasAdd:!!f.strip.addCard, fx, fy, fw, fh, cw, ch}}; }})()")
check("flyout_opens", fl["open"] and fl["cards"] == info["nWs"] and fl["hasAdd"], str(fl))
check("card_size_240x164", round(fl["cw"]) == 240 and round(fl["ch"]) == 164, str(fl))
shot("c01_flyout")

# 3. Context Menu inside flyout
ev(f"(() => {{ const a={A}; const c=a.flyout.strip.cards[0]; const [x,y]=c.actor.get_transformed_position(); c._openContextMenu(x+40, y+40); }})()")
time.sleep(0.3)
cm = evj(f"(() => {{ const m={A}.contextMenu; return {{open:m.isOpen, rows:m._rows.length}}; }})()")
check("context_menu_opens", cm["open"] and cm["rows"] == (3 if info["nWs"] > 1 else 1), str(cm))
shot("c02_context_menu")
ev(f"{A}.contextMenu.close(true); {A}.flyout.close(true)")
time.sleep(0.15)

# 4. Full Task View overlay
ev(f"{A}.taskView.open()")
time.sleep(0.75)
tv = evj(f"(() => {{ const tv={A}.taskView; const [dx,dy]=tv._dock.get_transformed_position(); const [dw,dh]=tv._dock.get_transformed_size(); return {{open:tv.isOpen, hasBackdrop:!!tv._backdrop, cards:tv._strip.cards.length, winCards:tv._winCards.length, dx, dy, dw, dh, dockTy:tv._dock.translation_y}}; }})()")
check("taskview_opens", tv["open"] and tv["hasBackdrop"] and tv["cards"] == info["nWs"], str(tv))
check("taskview_dock_176px_8px_margin", round(tv["dh"]) == 176 and round(tv["dx"]) == 8 and round(tv["dockTy"]) == 0, str(tv))
shot("c03_taskview")
ev(f"{A}.taskView.close(true)")
time.sleep(0.25)
check("taskview_closes", not evj(f"{A}.taskView.isOpen"))

# 5. Workspace add / rename / reorder (via real context menu callback) / close round-trip
orig_n = info["nWs"]
ev("imports.ui.main._addWorkspace()")
time.sleep(0.25)
check("ws_added", evj("global.workspace_manager.n_workspaces") == orig_n + 1)
ev(f"imports.ui.main.setWorkspaceName({orig_n}, 'TempTestWS')")
check("ws_renamed", evj(f"imports.ui.main.getWorkspaceName({orig_n})") == "TempTestWS")

# Trigger "Move left" via real card context menu callback on the new last card, then close it
ev(f"{A}.flyout.open(true)")
time.sleep(0.2)
ev(f"(() => {{ const a={A}; const c=a.flyout.strip.cards[{orig_n}]; const [x,y]=c.actor.get_transformed_position(); c._openContextMenu(x+10, y+10); a.contextMenu._callbacks[1](); a.contextMenu.close(true); }})()")
time.sleep(0.2)
check("ws_reordered_with_name", evj(f"imports.ui.main.getWorkspaceName({orig_n - 1})") == "TempTestWS")

ev(f"(() => {{ const a={A}; const c=a.flyout.strip.cards[{orig_n - 1}]; const [x,y]=c.actor.get_transformed_position(); c._openContextMenu(x+10, y+10); a.contextMenu._callbacks[a.contextMenu._callbacks.length - 1](); a.contextMenu.close(true); a.flyout.close(true); }})()")
time.sleep(0.25)
check("ws_closed_cleanly", evj("global.workspace_manager.n_workspaces") == orig_n)

# 6. Check .xsession-errors for any new errors
new_err = ""
if ERRLOG.exists():
    with open(ERRLOG, "r", errors="replace") as f:
        f.seek(err_start)
        new_err = f.read()
bad = [l for l in new_err.splitlines() if "win11-workspace-switcher" in l or "JS ERROR" in l or "TypeError" in l or "ReferenceError" in l or "cr_parser_new_from_buf" in l]
check("no_js_or_st_errors", len(bad) == 0, "\n".join(bad))

failed = [n for n, ok in results if not ok]
print(f"\nSummary: {len(results)-len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
