#!/usr/bin/env python3
"""Comprehensive debugging, DnD, reorganization, stress & performance test battery."""
import ast
import json
import os
import pathlib
import re
import subprocess
import sys
import time

from Xlib import X, XK, display as xdisplay
from Xlib.ext import xtest

UUID = "win11-workspace-switcher@cinnamon"
A = f"imports.ui.appletManager.getRunningInstancesForUuid('{UUID}')[0]"
ERRLOG = pathlib.Path.home() / ".xsession-errors"

dpy = xdisplay.Display(":0")
root = dpy.screen().root
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
    status = "PASS" if cond else "FAIL"
    print(f"{status} {name}" + (f" -- {detail}" if detail and (not cond or status == "PASS") else ""))
    return cond


def move(x, y):
    xtest.fake_input(dpy, X.MotionNotify, x=int(x), y=int(y))
    dpy.sync()


def drag(x0, y0, x1, y1, steps=14, step_sleep=0.018):
    move(x0, y0)
    time.sleep(0.08)
    xtest.fake_input(dpy, X.ButtonPress, 1)
    dpy.sync()
    time.sleep(0.04)
    for i in range(1, steps + 1):
        t = i / steps
        move(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)
        time.sleep(step_sleep)
    time.sleep(0.06)
    xtest.fake_input(dpy, X.ButtonRelease, 1)
    dpy.sync()
    time.sleep(0.18)


def press_key(keysym, shift=False, alt=False):
    kc = dpy.keysym_to_keycode(keysym)
    mods = []
    if shift:
        mods.append(dpy.keysym_to_keycode(XK.XK_Shift_L))
    if alt:
        mods.append(dpy.keysym_to_keycode(XK.XK_Alt_L))
    for m in mods:
        xtest.fake_input(dpy, X.KeyPress, m)
    xtest.fake_input(dpy, X.KeyPress, kc)
    dpy.sync()
    time.sleep(0.03)
    xtest.fake_input(dpy, X.KeyRelease, kc)
    for m in reversed(mods):
        xtest.fake_input(dpy, X.KeyRelease, m)
    dpy.sync()
    time.sleep(0.12)


def spawn_test_window(title="Win11DndTestWin"):
    code = (
        "import gi; gi.require_version('Gtk','3.0'); from gi.repository import Gtk; "
        f"w=Gtk.Window(title='{title}'); w.set_default_size(480,320); "
        "w.connect('destroy',Gtk.main_quit); w.show_all(); Gtk.main()"
    )
    proc = subprocess.Popen(
        [sys.executable, "-c", code],
        env={**os.environ, "DISPLAY": ":0"},
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    for _ in range(30):
        time.sleep(0.1)
        found = evj(
            f"global.get_window_actors().some(a => a.meta_window && a.meta_window.get_title() === '{title}')"
        )
        if found:
            return proc
    raise RuntimeError("Timed out waiting for test window")


def cinnamon_rss_kb():
    pid = int(subprocess.check_output(["pgrep", "-xo", "cinnamon"]).decode().strip())
    with open(f"/proc/{pid}/status") as f:
        for line in f:
            if line.startswith("VmRSS:"):
                return int(line.split()[1])
    return 0


err_start = ERRLOG.stat().st_size if ERRLOG.exists() else 0
orig_state = evj(
    "({n: global.workspace_manager.n_workspaces, active: global.workspace_manager.get_active_workspace_index(), "
    "names: imports.ui.main.wmSettings.get_strv('workspace-names')})"
)

win_proc = None
try:
    # Ensure at least 2 workspaces for DnD & reorder tests
    ev(
        "(() => { const wm = global.workspace_manager; "
        "while (wm.n_workspaces < 2) imports.ui.main._addWorkspace(); "
        "imports.ui.main.wmSettings.set_strv('workspace-names', ['AlphaWS', 'BetaWS']); })()"
    )
    time.sleep(0.2)

    # 1. Button vertical/horizontal centering & zero idle tile texture
    btn_info = evj(
        f"(() => {{ const a={A}; const [bx,by]=a.buttonActor.get_transformed_position(); "
        "const [bw,bh]=a.buttonActor.get_transformed_size(); "
        "const [px,py]=a.panel.actor.get_transformed_position(); "
        "const [pw,ph]=a.panel.actor.get_transformed_size(); "
        "return {bx,by,bw,bh,px,py,pw,ph,tileVisible:a.button._tileActor.visible,cachedDark:a._cachedIsDark}; })()"
    )
    check(
        "idle_tile_hidden_and_centered",
        abs((btn_info["by"] + btn_info["bh"] / 2) - (btn_info["py"] + btn_info["ph"] / 2)) <= 1.0
        and not btn_info["tileVisible"]
        and isinstance(btn_info["cachedDark"], bool),
        str(btn_info),
    )

    # 2. Real X11 hover over panel button -> flyout opens -> mouse leaves -> closes
    bx_mid = btn_info["bx"] + btn_info["bw"] / 2
    by_mid = btn_info["py"] + btn_info["ph"] / 2
    move(bx_mid, by_mid)
    hover_open = False
    for _ in range(18):
        time.sleep(0.05)
        if evj(f"{A}.flyout.isOpen"):
            hover_open = True
            break
    check("x11_hover_opens_flyout", hover_open)
    move(20, 20)
    hover_closed = False
    for _ in range(16):
        time.sleep(0.05)
        if not evj(f"{A}.flyout.isOpen"):
            hover_closed = True
            break
    check("x11_leave_closes_flyout", hover_closed)

    # 3. Desktop card drag-and-drop reorder inside flyout (AlphaWS -> slot 1, then back)
    ev(f"{A}.flyout.open(true)")
    time.sleep(0.35)
    c_pos = evj(
        f"(() => {{ const s={A}.flyout.strip; const [x0,y0]=s.cards[0].actor.get_transformed_position(); "
        "const [w0,h0]=s.cards[0].actor.get_transformed_size(); "
        "const [x1,y1]=s.cards[1].actor.get_transformed_position(); "
        "return {x0:x0+w0/2, y0:y0+h0/2, x1:x1+w0/2, y1:y1+h0/2}; })()"
    )
    drag(c_pos["x0"], c_pos["y0"], c_pos["x1"] + 30, c_pos["y1"])
    names_after_drag = evj("[0,1].map(i => imports.ui.main.getWorkspaceName(i))")
    check("desktop_dnd_reorder_forward", names_after_drag == ["BetaWS", "AlphaWS"], str(names_after_drag))

    # Drag BetaWS back to slot 1 -> restores [AlphaWS, BetaWS]
    c_pos2 = evj(
        f"(() => {{ const s={A}.flyout.strip; const [x0,y0]=s.cards[0].actor.get_transformed_position(); "
        "const [w0,h0]=s.cards[0].actor.get_transformed_size(); "
        "const [x1,y1]=s.cards[1].actor.get_transformed_position(); "
        "return {x0:x0+w0/2, y0:y0+h0/2, x1:x1+w0/2, y1:y1+h0/2}; })()"
    )
    drag(c_pos2["x0"], c_pos2["y0"], c_pos2["x1"] + 30, c_pos2["y1"])
    names_restored = evj("[0,1].map(i => imports.ui.main.getWorkspaceName(i))")
    check("desktop_dnd_reorder_back", names_restored == ["AlphaWS", "BetaWS"], str(names_restored))
    ev(f"{A}.flyout.close(true)")
    time.sleep(0.15)

    # 4. Spawn real window on monitor 0, workspace 0 & open Task View
    win_proc = spawn_test_window("Win11DndTestWin")
    ev(
        "(() => { const a = global.get_window_actors().find(x => x.meta_window && x.meta_window.get_title() === 'Win11DndTestWin'); "
        "if (a) { a.meta_window.move_to_monitor(0); a.meta_window.change_workspace_by_index(0, false); } })()"
    )
    time.sleep(0.25)

    ev(f"{A}.taskView.open()")
    for _ in range(30):
        if evj(f"{A}.taskView._dock.translation_y === 0"):
            break
        time.sleep(0.05)
    time.sleep(0.28)

    # 4b. Desktop card Escape cancel & DnD inside modal Task View dock
    tv_cards = evj(
        f"(() => {{ const s={A}.taskView._strip; const [x0,y0]=s.cards[0].actor.get_transformed_position(); "
        "const [w0,h0]=s.cards[0].actor.get_transformed_size(); "
        "const [x1,y1]=s.cards[1].actor.get_transformed_position(); "
        "return {x0:x0+w0/2, y0:y0+h0/2, x1:x1+w0/2, y1:y1+h0/2}; })()"
    )
    move(tv_cards["x0"], tv_cards["y0"])
    time.sleep(0.05)
    xtest.fake_input(dpy, X.ButtonPress, 1); dpy.sync(); time.sleep(0.04)
    move(tv_cards["x1"], tv_cards["y1"]); time.sleep(0.15)
    press_key(XK.XK_Escape)
    time.sleep(0.28)
    xtest.fake_input(dpy, X.ButtonRelease, 1); dpy.sync(); time.sleep(0.15)
    names_after_esc = evj("[0,1].map(i => imports.ui.main.getWorkspaceName(i))")
    tv_still_open = evj(f"{A}.taskView.isOpen")
    check("taskview_desktop_dnd_escape_cancels", names_after_esc == ["AlphaWS", "BetaWS"] and tv_still_open, f"names={names_after_esc}, open={tv_still_open}")

    # 4c. Real X11 hover onto card 0 switches Task View preview back to workspace 0
    move(400, 500)
    time.sleep(0.12)
    move(tv_cards["x0"], tv_cards["y0"])
    time.sleep(0.25)

    tv_geom = evj(
        f"(() => {{ const tv={A}.taskView; const wc=tv._winCards.find(c => c.mw.get_title() === 'Win11DndTestWin'); "
        "if (!wc) { const w=global.get_window_actors().find(x=>x.meta_window&&x.meta_window.get_title()==='Win11DndTestWin'); return {missing:true, preview:tv._previewWsIndex, hover0:tv._strip.cards[0].actor.hover, pos0:tv._strip.cards[0].actor.get_transformed_position(), cards:tv._winCards.map(c=>c.mw.get_title()), winMon:w?w.meta_window.get_monitor():-1, winWs:w?w.meta_window.get_workspace().index():-1}; } "
        "const [wx,wy]=wc.actor.get_transformed_position(); const [ww,wh]=wc.actor.get_transformed_size(); "
        "const d1=tv._strip.cards[1]; const [dx,dy]=d1.actor.get_transformed_position(); const [dw,dh]=d1.actor.get_transformed_size(); "
        "const add=tv._strip.addCard; const [ax,ay]=add.get_transformed_position(); const [aw,ah]=add.get_transformed_size(); "
        "return {wx:wx+ww/2, wy:wy+wh/2, dx:dx+dw/2, dy:dy+dh/2, ax:ax+aw/2, ay:ay+ah/2, "
        "dragAboveDock: tv.actor.get_children().indexOf(tv._dragLayer) > tv.actor.get_children().indexOf(tv._dock)}; })()"
    )
    check("taskview_drag_layer_above_dock", tv_geom and tv_geom.get("dragAboveDock"), str(tv_geom))

    # 5a. Drag window outside dock -> springs back without changing workspace
    drag(tv_geom["wx"], tv_geom["wy"], 120, 120)
    still_in_grid = False
    for _ in range(14):
        still_in_grid = evj(
            f"(() => {{ const tv={A}.taskView; const wc=tv._winCards.find(c => c.mw.get_title() === 'Win11DndTestWin'); "
            "return !!(wc && wc.actor.get_parent() === tv._gridLayer && Math.abs(wc.actor.scale_x - 1) < 0.05 && Math.abs(wc.actor.translation_x) < 1); })()"
        )
        if still_in_grid:
            break
        time.sleep(0.05)
    ws_after_outside = evj(
        "global.get_window_actors().find(x => x.meta_window && x.meta_window.get_title() === 'Win11DndTestWin').meta_window.get_workspace().index()"
    )
    check("window_dnd_outside_springs_back", ws_after_outside == 0 and still_in_grid, f"ws={ws_after_outside}, inGrid={still_in_grid}")

    # 5b. Drag window over Desktop 1 -> check drop highlight & dragLayer mid-drag -> drop moves window
    move(tv_geom["wx"], tv_geom["wy"])
    time.sleep(0.08)
    xtest.fake_input(dpy, X.ButtonPress, 1); dpy.sync(); time.sleep(0.06)
    for i in range(1, 13):
        t = i / 12
        move(tv_geom["wx"] + (tv_geom["dx"] - tv_geom["wx"]) * t, tv_geom["wy"] + (tv_geom["dy"] - tv_geom["wy"]) * t)
        time.sleep(0.018)
    mid_drag = {}
    for _ in range(10):
        time.sleep(0.05)
        mid_drag = evj(
            f"(() => {{ const tv={A}.taskView; return {{isDragging: tv.isDraggingWindow, hasDrag: !!tv._dragState, "
            "dropLit: tv._strip.cards[1]._dropHighlighted, previewIdx: tv._previewWsIndex, "
            "parentIsDragLayer: !!(tv._dragState && tv._dragState.card.get_parent() === tv._dragLayer)}; })()"
        )
        if mid_drag["isDragging"] and mid_drag["dropLit"]:
            break
    check(
        "window_dnd_mid_drag_state",
        mid_drag["isDragging"] and mid_drag["dropLit"] and mid_drag["previewIdx"] == 0 and mid_drag["parentIsDragLayer"],
        str(mid_drag),
    )
    xtest.fake_input(dpy, X.ButtonRelease, 1); dpy.sync(); time.sleep(0.25)

    ws_after_drop = evj(
        "global.get_window_actors().find(x => x.meta_window && x.meta_window.get_title() === 'Win11DndTestWin').meta_window.get_workspace().index()"
    )
    gone_from_ws0 = evj(
        "!global.workspace_manager.get_workspace_by_index(0).list_windows().some(w => w.get_title() === 'Win11DndTestWin')"
    )
    check("window_dnd_drop_on_desktop", ws_after_drop == 1 and gone_from_ws0, f"ws={ws_after_drop}, gone={gone_from_ws0}")

    # 5c. Preview Desktop 1, then drag window onto "+ New desktop"
    ev(f"(() => {{ const tv={A}.taskView; tv._previewWsIndex = 1; tv._strip.setPreviewIndex(1); tv._rebuildWindowGrid(false); }})()")
    time.sleep(0.15)
    tv_geom2 = evj(
        f"(() => {{ const tv={A}.taskView; const wc=tv._winCards.find(c => c.mw.get_title() === 'Win11DndTestWin'); "
        "const [wx,wy]=wc.actor.get_transformed_position(); const [ww,wh]=wc.actor.get_transformed_size(); "
        "const add=tv._strip.addCard; const [ax,ay]=add.get_transformed_position(); const [aw,ah]=add.get_transformed_size(); "
        "return {wx:wx+ww/2, wy:wy+wh/2, ax:ax+aw/2, ay:ay+ah/2, n:global.workspace_manager.n_workspaces}; })()"
    )
    drag(tv_geom2["wx"], tv_geom2["wy"], tv_geom2["ax"], tv_geom2["ay"])
    after_add = evj(
        f"({{n: global.workspace_manager.n_workspaces, tvOpen: {A}.taskView.isOpen, "
        "winWs: global.get_window_actors().find(x => x.meta_window && x.meta_window.get_title() === 'Win11DndTestWin').meta_window.get_workspace().index()})"
    )
    check(
        "window_dnd_drop_on_add_desktop",
        after_add["n"] == tv_geom2["n"] + 1 and after_add["tvOpen"] and after_add["winWs"] == tv_geom2["n"],
        str(after_add),
    )

    # 5d. Keyboard navigation & Escape cancel during drag
    ev(f"(() => {{ const tv={A}.taskView; tv._previewWsIndex = 2; tv._strip.setPreviewIndex(2); tv._rebuildWindowGrid(false); }})()")
    time.sleep(0.15)
    press_key(XK.XK_Tab)
    focused_idx = evj(f"{A}.taskView._focusedWinIdx")
    check("keyboard_tab_focuses_window", focused_idx == 0, str(focused_idx))

    # Snap left & Snap right via util.snapWindow (same helper called by context menu)
    ev(f"{A}.taskView.close(true)")
    time.sleep(0.15)
    snap_res = evj(
        "(() => { const a = global.get_window_actors().find(x => x.meta_window && x.meta_window.get_title() === 'Win11DndTestWin'); "
        "const mw = a.meta_window; mw.change_workspace_by_index(0, false); imports.ui.main.wm.moveToWorkspace(global.workspace_manager.get_workspace_by_index(0)); "
        "const wa = mw.get_work_area_current_monitor(); "
        f"const u = {A}.taskView._winCards; "
        "return {waW: wa.width, waX: wa.x}; })()"
    )
    ev(
        f"(() => {{ const mw = global.get_window_actors().find(x => x.meta_window && x.meta_window.get_title() === 'Win11DndTestWin').meta_window; "
        f"const tv = {A}.taskView; tv.open(); }})()"
    )
    time.sleep(0.35)
    # Trigger Snap Left from real window context menu item 0
    ev(
        f"(() => {{ const tv = {A}.taskView; const wc = tv._winCards.find(c => c.mw.get_title() === 'Win11DndTestWin'); "
        "tv._openWindowContextMenu(wc.mw, 200, 200); "
        f"{A}.contextMenu._callbacks[0](); }})()"
    )
    time.sleep(0.25)
    snapped_rect = evj(
        "(() => { const mw = global.get_window_actors().find(x => x.meta_window && x.meta_window.get_title() === 'Win11DndTestWin').meta_window; "
        "const r = mw.get_frame_rect(); const wa = mw.get_work_area_current_monitor(); "
        "return {rx: r.x, rw: r.width, wax: wa.x, waw: wa.width}; })()"
    )
    check(
        "window_context_snap_left",
        abs(snapped_rect["rx"] - snapped_rect["wax"]) <= 4 and abs(snapped_rect["rw"] - snapped_rect["waw"] // 2) <= 8,
        str(snapped_rect),
    )

    # 6. Stress & Ultra-light performance check: rapid open/close (10x TaskView + 15x Flyout)
    rss_before = cinnamon_rss_kb()
    t0 = time.monotonic()
    for i in range(15):
        ev(f"{A}.flyout.open(false)")
        time.sleep(0.03)
        ev(f"{A}.flyout.close({'true' if i % 2 == 0 else 'false'})")
        time.sleep(0.02)
    flyout_ms = (time.monotonic() - t0) * 1000 / 15

    t1 = time.monotonic()
    for i in range(10):
        ev(f"{A}.taskView.open()")
        time.sleep(0.05)  # intentionally interrupt mid-250ms dock reveal!
        ev(f"{A}.taskView.close({'true' if i % 2 == 0 else 'false'})")
        time.sleep(0.03)
    time.sleep(0.3)
    tv_ms = (time.monotonic() - t1) * 1000 / 10
    rss_after = cinnamon_rss_kb()
    rss_delta_mb = (rss_after - rss_before) / 1024.0

    # Also test lite-mode skips blur backdrop
    ev(f"{A}.settings.setValue('lite-mode', true)")
    time.sleep(0.1)
    ev(f"{A}.taskView.open()")
    time.sleep(0.15)
    lite_check = evj(f"({{open: {A}.taskView.isOpen, hasBackdrop: !!{A}.taskView._backdrop}})")
    ev(f"{A}.taskView.close(true)")
    ev(f"{A}.settings.setValue('lite-mode', false)")
    check("lite_mode_skips_blur", lite_check["open"] and not lite_check["hasBackdrop"], str(lite_check))
    check(
        "stress_rapid_open_close_low_rss",
        rss_delta_mb < 16.0,
        f"rss_before={rss_before}KB, rss_after={rss_after}KB, delta={rss_delta_mb:.2f}MB, flyout={flyout_ms:.1f}ms, taskView={tv_ms:.1f}ms",
    )

finally:
    if win_proc is not None:
        win_proc.terminate()
        try:
            win_proc.wait(timeout=2)
        except Exception:
            win_proc.kill()
    ev(f"{A}.contextMenu.close(true); {A}.flyout.close(true); {A}.taskView.close(true)")
    ev(
        f"(() => {{ const wm = global.workspace_manager; "
        f"while (wm.n_workspaces > {orig_state['n']}) imports.ui.main._removeWorkspace(wm.get_workspace_by_index(wm.n_workspaces - 1)); "
        f"while (wm.n_workspaces < {orig_state['n']}) imports.ui.main._addWorkspace(); "
        f"imports.ui.main.wmSettings.set_strv('workspace-names', {json.dumps(orig_state['names'])}); "
        f"const ws = wm.get_workspace_by_index({orig_state['active']}); if (ws) imports.ui.main.wm.moveToWorkspace(ws); }})()"
    )
    move(400, 400)

# 7. Zero JS/St errors in ~/.xsession-errors
new_err = ""
if ERRLOG.exists():
    with open(ERRLOG, "r", errors="replace") as f:
        f.seek(err_start)
        new_err = f.read()
bad = [
    l for l in new_err.splitlines()
    if any(k in l for k in ("win11-workspace-switcher", "JS ERROR", "TypeError", "ReferenceError", "cr_parser_new_from_buf", "st_paint"))
]
check("no_js_or_st_errors", len(bad) == 0, "\n".join(bad))

failed = [n for n, ok in results if not ok]
print(f"\nBattery Summary: {len(results)-len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
