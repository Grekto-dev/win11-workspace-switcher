#!/usr/bin/env python3
"""Tests for Windows 11 workspace shortcuts: defaults, X11 triggers, disabling, and system-conflict protection."""
import ast
import json
import pathlib
import re
import subprocess
import sys
import time

from Xlib import X, XK, display as xdisplay
from Xlib.ext import xtest

UUID = "win11-workspace-switcher@cinnamon"
A = f"imports.ui.appletManager.getRunningInstancesForUuid('{UUID}')[0]"
ALL_A = f"imports.ui.appletManager.getRunningInstancesForUuid('{UUID}')"
SPICE_DIR = pathlib.Path.home() / ".config/cinnamon/spices" / UUID
ERRLOG = pathlib.Path.home() / ".xsession-errors"

dpy = xdisplay.Display(":0")
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


def set_setting_like_ui(inst_id, key, val):
    cfg_path = SPICE_DIR / f"{inst_id}.json"
    data = json.loads(cfg_path.read_text(encoding="utf-8"))
    data[key]["value"] = val
    cfg_path.write_text(json.dumps(data, indent=4), encoding="utf-8")
    subprocess.run(
        ["gdbus", "call", "--session", "--dest", "org.Cinnamon",
         "--object-path", "/org/Cinnamon", "--method", "org.Cinnamon.updateSetting",
         UUID, str(inst_id), key, json.dumps(val)],
        capture_output=True, text=True, check=True
    )


def set_all_instances_like_ui(inst_ids, key, val):
    for iid in inst_ids:
        set_setting_like_ui(iid, key, val)


def combo(keysyms):
    codes = [dpy.keysym_to_keycode(k) for k in keysyms]
    for kc in codes:
        xtest.fake_input(dpy, X.KeyPress, kc)
        dpy.sync()
        time.sleep(0.02)
    time.sleep(0.04)
    for kc in reversed(codes):
        xtest.fake_input(dpy, X.KeyRelease, kc)
        dpy.sync()
        time.sleep(0.02)
    time.sleep(0.18)


def bound_map():
    rows = evj(
        f"[...imports.ui.main.keybindingManager.bindings.values()]"
        f".filter(v => v.name.startsWith('{UUID}::'))"
        f".map(v => ({{name: v.name, bindings: v.bindings}}))"
    )
    out = {}
    for r in rows:
        parts = r["name"].split("::")
        slot = parts[1] if len(parts) > 1 else r["name"]
        out.setdefault(slot, []).extend(r["bindings"])
    return out


err_start = ERRLOG.stat().st_size if ERRLOG.exists() else 0
orig_ws = evj(
    "({n: global.workspace_manager.n_workspaces, active: global.workspace_manager.get_active_workspace_index(), "
    "names: imports.ui.main.wmSettings.get_strv('workspace-names')})"
)
inst_ids = evj(f"{ALL_A}.map(a => String(a.instanceId))")
inst0 = inst_ids[0]
orig_by_inst = {
    iid: json.loads((SPICE_DIR / f"{iid}.json").read_text(encoding="utf-8"))
    for iid in inst_ids
}

try:
    # Ensure cursor is on monitor 0 so multi-instance applet resolves monitor 0 instance
    xtest.fake_input(dpy, X.MotionNotify, x=500, y=500)
    dpy.sync()
    time.sleep(0.05)

    # 1. Verify default Windows 11 shortcuts are registered
    bm = bound_map()
    check(
        "defaults_bound",
        bm.get("win11-ws-taskview") == ["<Super>Tab"]
        and bm.get("win11-ws-left") == ["<Primary><Super>Left"]
        and bm.get("win11-ws-right") == ["<Primary><Super>Right"]
        and bm.get("win11-ws-new") == ["<Primary><Super>d"]
        and bm.get("win11-ws-close") == ["<Primary><Super>F4"],
        str(bm),
    )

    # 2. Pure normalization unit check via node
    norm_res = subprocess.run(
        ["node", "-e",
         "const fs = require('fs'); "
         "const src = fs.readFileSync('/home/pedro/.gemini/antigravity/scratch/win11-workspace-switcher/shortcuts.js', 'utf8'); "
         "const fnSrc = src.replace(/const \\{ Gio, GLib \\} = imports\\.gi;\\nconst Main = imports\\.ui\\.main;/, 'const Gio = {}, GLib = {}, Main = {};'); "
         "const m = { exports: {} }; new Function('module', 'exports', fnSrc)(m, m.exports); "
         "const { normalizeAccel, parseAccelList } = m.exports; "
         "if (normalizeAccel('<Control><Super>Left') !== normalizeAccel('<Primary><Super>left')) throw new Error('norm1'); "
         "if (normalizeAccel('<Super><Ctrl>D') !== normalizeAccel('<Primary><Super>d')) throw new Error('norm2'); "
         "if (parseAccelList('::').length !== 0) throw new Error('empty');"],
        capture_output=True, text=True, check=False
    )
    check("shortcuts_normalization_unit", norm_res.returncode == 0, norm_res.stderr.strip())

    # 3. Real X11 keystrokes: Win+Tab toggles Task View open & closed
    combo([XK.XK_Super_L, XK.XK_Tab])
    time.sleep(0.25)
    tv_opened = evj(f"{A}.taskView.isOpen")
    combo([XK.XK_Super_L, XK.XK_Tab])
    time.sleep(0.25)
    tv_closed = not evj(f"{A}.taskView.isOpen")
    check("x11_win_tab_toggles_taskview", tv_opened and tv_closed, f"opened={tv_opened}, closed={tv_closed}")

    # 4. Real X11 keystrokes: Ctrl+Win+D creates & activates workspace, Ctrl+Win+Left/Right switches, Ctrl+Win+F4 closes
    n0 = evj("global.workspace_manager.n_workspaces")
    combo([XK.XK_Control_L, XK.XK_Super_L, XK.XK_d])
    time.sleep(0.15)
    after_d = evj("({n: global.workspace_manager.n_workspaces, active: global.workspace_manager.get_active_workspace_index()})")
    check("x11_ctrl_win_d_adds_and_switches", after_d["n"] == n0 + 1 and after_d["active"] == n0, str(after_d))

    combo([XK.XK_Control_L, XK.XK_Super_L, XK.XK_Left])
    time.sleep(0.1)
    idx_left = evj("global.workspace_manager.get_active_workspace_index()")
    combo([XK.XK_Control_L, XK.XK_Super_L, XK.XK_Right])
    time.sleep(0.1)
    idx_right = evj("global.workspace_manager.get_active_workspace_index()")
    check("x11_ctrl_win_left_right_switches", idx_left == n0 - 1 and idx_right == n0, f"left={idx_left}, right={idx_right}")

    combo([XK.XK_Control_L, XK.XK_Super_L, XK.XK_F4])
    time.sleep(0.15)
    n_after_f4 = evj("global.workspace_manager.n_workspaces")
    check("x11_ctrl_win_f4_closes_workspace", n_after_f4 == n0, f"n_after_f4={n_after_f4}, n0={n0}")

    # 5. Individual disable ("::") on monitor 0 instance stops Ctrl+Win+D on monitor 0, and clearing all instances removes binding
    set_setting_like_ui(inst0, "shortcut-new-workspace", "::")
    time.sleep(0.2)
    combo([XK.XK_Control_L, XK.XK_Super_L, XK.XK_d])
    time.sleep(0.1)
    n_mon0_disabled = evj("global.workspace_manager.n_workspaces")
    set_all_instances_like_ui(inst_ids, "shortcut-new-workspace", "::")
    time.sleep(0.2)
    bm_disabled_all = bound_map()
    check(
        "disable_single_shortcut",
        n_mon0_disabled == n0 and "win11-ws-new" not in bm_disabled_all,
        f"n={n_mon0_disabled}, bm={bm_disabled_all}",
    )

    set_all_instances_like_ui(inst_ids, "shortcut-new-workspace", "<Primary><Super>d")
    time.sleep(0.2)

    # 6. Master switch enable-shortcuts=false unregisters all, true restores all
    set_all_instances_like_ui(inst_ids, "enable-shortcuts", False)
    time.sleep(0.25)
    bm_all_off = bound_map()
    set_all_instances_like_ui(inst_ids, "enable-shortcuts", True)
    time.sleep(0.25)
    bm_all_on = bound_map()
    check("master_disable_toggle", len(bm_all_off) == 0 and len(bm_all_on) == 5, f"off={bm_all_off}, on={bm_all_on}")

    # 7. Conflict rejection tests (WM, media-keys, custom-keybinding, other applet, intra-applet)
    # 7a. WM shortcut (<Control><Alt>Left vs <Primary><Alt>Left normalization)
    set_setting_like_ui(inst0, "shortcut-workspace-left", "<Primary><Alt>Left")
    time.sleep(0.25)
    val_wm = evj(f"{A}.settings.getValue('shortcut-workspace-left')")
    bm_wm = bound_map()
    check("conflict_wm_rejected_and_reverted", val_wm == "<Primary><Super>Left" and bm_wm.get("win11-ws-left") == ["<Primary><Super>Left"], f"val={val_wm}, bm={bm_wm}")

    # 7b. Media-keys shortcut (<Super>e -> home)
    set_setting_like_ui(inst0, "shortcut-taskview", "<Super>e")
    time.sleep(0.25)
    val_media = evj(f"{A}.settings.getValue('shortcut-taskview')")
    check("conflict_media_rejected_and_reverted", val_media == "<Super>Tab", f"val={val_media}")

    # 7c. Custom keybinding (<Super><Shift>s -> Snipping Tool)
    set_setting_like_ui(inst0, "shortcut-new-workspace", "<Super><Shift>s")
    time.sleep(0.25)
    val_custom = evj(f"{A}.settings.getValue('shortcut-new-workspace')")
    check("conflict_custom_rejected_and_reverted", val_custom == "<Primary><Super>d", f"val={val_custom}")

    # 7d. Other applet binding (Super_L on win11-menu@cinnamon)
    set_setting_like_ui(inst0, "shortcut-taskview", "Super_L")
    time.sleep(0.25)
    val_applet = evj(f"{A}.settings.getValue('shortcut-taskview')")
    check("conflict_other_applet_rejected", val_applet == "<Super>Tab", f"val={val_applet}")

    # 7e. Intra-applet conflict (<Super>Tab already used by shortcut-taskview)
    set_setting_like_ui(inst0, "shortcut-workspace-right", "<Super>Tab")
    time.sleep(0.25)
    val_intra = evj(f"{A}.settings.getValue('shortcut-workspace-right')")
    check("conflict_intra_applet_rejected", val_intra == "<Primary><Super>Right", f"val={val_intra}")

    # 8. Custom non-conflicting shortcut works and binds cleanly
    set_setting_like_ui(inst0, "shortcut-taskview", "<Super><Alt>t")
    time.sleep(0.25)
    val_ok = evj(f"{A}.settings.getValue('shortcut-taskview')")
    bm_ok = bound_map()
    combo([XK.XK_Super_L, XK.XK_Alt_L, XK.XK_t])
    time.sleep(0.25)
    custom_opened = evj(f"{A}.taskView.isOpen")
    if custom_opened:
        ev(f"{A}.taskView.close(true)")
    check(
        "custom_valid_shortcut_works",
        val_ok == "<Super><Alt>t" and "<Super><Alt>t" in bm_ok.get("win11-ws-taskview", []) and custom_opened,
        f"val={val_ok}, bm={bm_ok}, open={custom_opened}",
    )

    # 9. Verify Cinnamon Settings JSON keybinding table loads our schema without errors
    cs_check = subprocess.run(
        ["python3", "-c",
         "import sys; sys.path.insert(0, '/usr/share/cinnamon/cinnamon-settings/bin'); "
         "from KeybindingTable import KeybindingTable; kt = KeybindingTable(); "
         "matches = [c for c in kt._spice_store if c.int_name.startswith('win11-workspace-switcher@cinnamon_')]; "
         "assert len(matches) >= 1 and all(len(m.keybindings) == 5 for m in matches), f'got {[(m.int_name, len(m.keybindings)) for m in matches]}'"],
        capture_output=True, text=True, check=False
    )
    check("cinnamon_settings_keybinding_table_loads", cs_check.returncode == 0, cs_check.stderr.strip())

finally:
    ev(f"{A}.contextMenu.close(true); {A}.flyout.close(true); {A}.taskView.close(true)")
    for iid, data in orig_by_inst.items():
        (SPICE_DIR / f"{iid}.json").write_text(json.dumps(data, indent=4), encoding="utf-8")
        subprocess.run(
            ["gdbus", "call", "--session", "--dest", "org.Cinnamon",
             "--object-path", "/org/Cinnamon", "--method", "org.Cinnamon.updateSetting",
             UUID, str(iid), "enable-shortcuts", json.dumps(data["enable-shortcuts"]["value"])],
            capture_output=True, text=True, check=False
        )
    ev(
        f"(() => {{ const wm = global.workspace_manager; "
        f"while (wm.n_workspaces > {orig_ws['n']}) imports.ui.main._removeWorkspace(wm.get_workspace_by_index(wm.n_workspaces - 1)); "
        f"while (wm.n_workspaces < {orig_ws['n']}) imports.ui.main._addWorkspace(); "
        f"imports.ui.main.wmSettings.set_strv('workspace-names', {json.dumps(orig_ws['names'])}); "
        f"const ws = wm.get_workspace_by_index({orig_ws['active']}); if (ws) imports.ui.main.wm.moveToWorkspace(ws); }})()"
    )

# 10. Zero errors in ~/.xsession-errors
new_err = ""
if ERRLOG.exists():
    with open(ERRLOG, "r", errors="replace") as f:
        f.seek(err_start)
        new_err = f.read()
bad = [
    l for l in new_err.splitlines()
    if any(k in l for k in ("win11-workspace-switcher", "JS ERROR", "TypeError", "ReferenceError", "Unable to bind", "unable to bind hotkey"))
]
check("no_js_or_hotkey_errors", len(bad) == 0, "\n".join(bad))

failed = [n for n, ok in results if not ok]
print(f"\nShortcuts Summary: {len(results)-len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
