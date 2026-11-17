// Lightweight utilities: Timer, WallpaperCache, Theme detection, workspace & window helpers.
const { Clutter, Cogl, GdkPixbuf, Gio, GLib, Meta, St, Cinnamon } = imports.gi;
const Main = imports.ui.main;
const { tr } = require('./i18n');

class Timer {
    constructor() {
        this.id = 0;
    }

    get pending() {
        return this.id !== 0;
    }

    set(ms, fn) {
        this.clear();
        this.id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(0, ms), () => {
            this.id = 0;
            fn();
            return GLib.SOURCE_REMOVE;
        });
    }

    clear() {
        if (this.id) {
            GLib.source_remove(this.id);
            this.id = 0;
        }
    }
}

function parseColorRgba(css, fallback = [0.3, 0.76, 1, 1]) {
    if (!css) return fallback;
    const [ok, col] = Clutter.Color.from_string(css);
    return ok ? [col.red / 255, col.green / 255, col.blue / 255, col.alpha / 255] : fallback;
}

let _cinnamonThemeSettings = null;
let _windowTracker = null;

function _getCinnamonThemeSettings() {
    if (!_cinnamonThemeSettings) {
        try {
            _cinnamonThemeSettings = new Gio.Settings({ schema_id: 'org.cinnamon.theme' });
        } catch (e) { /* headless */ }
    }
    return _cinnamonThemeSettings;
}

// Detects whether dark or light Win11 palette should be used.
function detectDarkTheme(mode, applet) {
    if (mode === 'dark') return true;
    if (mode === 'light') return false;
    // Check panel theme background luminance first, then GTK/Cinnamon theme name.
    try {
        const bar = applet && applet.panel ? applet.panel.actor : null;
        if (bar) {
            const node = bar.get_theme_node();
            const bg = node.get_background_color();
            if (bg && bg.alpha > 20) {
                const lum = 0.2126 * bg.red + 0.7152 * bg.green + 0.0722 * bg.blue;
                return lum < 135;
            }
        }
    } catch (e) { /* fall through */ }
    try {
        const ts = _getCinnamonThemeSettings();
        const themeName = ts ? (ts.get_string('name') || '') : '';
        if (/light/i.test(themeName)) return false;
        if (/dark/i.test(themeName)) return true;
    } catch (e) { /* fall through */ }
    return true;
}

// Fast 1D separable box blur on an RGBA/RGB byte array in place (3 passes ~ Gaussian).
function _boxBlur(src, dst, w, h, ch, r) {
    const div = r * 2 + 1;
    // Horizontal pass: src -> dst
    for (let y = 0; y < h; y++) {
        const row = y * w * ch;
        for (let c = 0; c < ch; c++) {
            let sum = 0;
            for (let i = -r; i <= r; i++) {
                const ix = Math.max(0, Math.min(w - 1, i));
                sum += src[row + ix * ch + c];
            }
            for (let x = 0; x < w; x++) {
                dst[row + x * ch + c] = (sum / div) | 0;
                const addX = Math.min(w - 1, x + r + 1);
                const remX = Math.max(0, x - r);
                sum += src[row + addX * ch + c] - src[row + remX * ch + c];
            }
        }
    }
    // Vertical pass: dst -> src
    for (let x = 0; x < w; x++) {
        for (let c = 0; c < ch; c++) {
            let sum = 0;
            for (let i = -r; i <= r; i++) {
                const iy = Math.max(0, Math.min(h - 1, i));
                sum += dst[(iy * w + x) * ch + c];
            }
            for (let y = 0; y < h; y++) {
                src[(y * w + x) * ch + c] = (sum / div) | 0;
                const addY = Math.min(h - 1, y + r + 1);
                const remY = Math.max(0, y - r);
                sum += dst[(addY * w + x) * ch + c] - dst[(remY * w + x) * ch + c];
            }
        }
    }
}

// Caches a single scaled thumbnail Clutter.Image (220x132) and a single blurred backdrop Clutter.Image (128x72)
// for the desktop wallpaper. Rebuilt lazily only when background settings change.
class WallpaperCache {
    constructor(onChange) {
        this._onChange = onChange;
        this._thumb = null;
        this._blur = null;
        this._thumbFailed = false;
        this._bgSettings = null;
        this._sigIds = [];
        try {
            this._bgSettings = new Gio.Settings({ schema_id: 'org.cinnamon.desktop.background' });
            this._sigIds.push(this._bgSettings.connect('changed::picture-uri', () => this.invalidate()));
            this._sigIds.push(this._bgSettings.connect('changed::picture-options', () => this.invalidate()));
            this._sigIds.push(this._bgSettings.connect('changed::primary-color', () => this.invalidate()));
        } catch (e) { /* headless/no schema */ }
    }

    invalidate() {
        this._thumb = null;
        this._blur = null;
        this._thumbFailed = false;
        if (this._onChange) this._onChange();
    }

    _resolvePath() {
        if (!this._bgSettings) return null;
        const opt = this._bgSettings.get_string('picture-options');
        if (opt === 'none') return null;
        const uri = this._bgSettings.get_string('picture-uri');
        if (!uri) return null;
        try {
            if (uri.startsWith('file://')) {
                const [path] = GLib.filename_from_uri(uri);
                return GLib.file_test(path, GLib.FileTest.EXISTS) ? path : null;
            }
            return GLib.file_test(uri, GLib.FileTest.EXISTS) ? uri : null;
        } catch (e) {
            return null;
        }
    }

    _solidImage(w, h) {
        let col = [26, 46, 82];
        try {
            if (this._bgSettings) {
                const c = parseColorRgba(this._bgSettings.get_string('primary-color'), [0.1, 0.18, 0.32, 1]);
                col = [Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255)];
            }
        } catch (e) { /* default */ }
        const data = new Uint8Array(w * h * 3);
        for (let i = 0; i < data.length; i += 3) {
            data[i] = col[0];
            data[i + 1] = col[1];
            data[i + 2] = col[2];
        }
        const img = new Clutter.Image();
        img.set_data(data, Cogl.PixelFormat.RGB_888, w, h, w * 3);
        return img;
    }

    getThumbnailImage(w = 220, h = 132) {
        if (this._thumb) return this._thumb;
        const path = !this._thumbFailed ? this._resolvePath() : null;
        if (path) {
            try {
                const pb = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, w, h, false);
                const img = new Clutter.Image();
                const fmt = pb.get_has_alpha() ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888;
                img.set_data(pb.get_pixels(), fmt, pb.get_width(), pb.get_height(), pb.get_rowstride());
                this._thumb = img;
                return img;
            } catch (e) {
                this._thumbFailed = true;
            }
        }
        this._thumb = this._solidImage(8, 8);
        return this._thumb;
    }

    getBlurredBackdropImage() {
        if (this._blur) return this._blur;
        const w = 128;
        const h = 72;
        const path = !this._thumbFailed ? this._resolvePath() : null;
        if (path) {
            try {
                const pb = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, w, h, false);
                const pw = pb.get_width();
                const ph = pb.get_height();
                const ch = pb.get_n_channels();
                const rs = pb.get_rowstride();
                const raw = pb.get_pixels();
                // Copy into packed buffer (rowstride may have padding).
                const buf = new Uint8Array(pw * ph * ch);
                for (let y = 0; y < ph; y++) {
                    buf.set(raw.subarray(y * rs, y * rs + pw * ch), y * pw * ch);
                }
                const tmp = new Uint8Array(buf.length);
                _boxBlur(buf, tmp, pw, ph, ch, 5);
                _boxBlur(buf, tmp, pw, ph, ch, 5);
                _boxBlur(buf, tmp, pw, ph, ch, 4);
                const img = new Clutter.Image();
                const fmt = ch === 4 ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888;
                img.set_data(buf, fmt, pw, ph, pw * ch);
                this._blur = img;
                return img;
            } catch (e) {
                this._thumbFailed = true;
            }
        }
        this._blur = this._solidImage(8, 8);
        return this._blur;
    }

    destroy() {
        if (this._bgSettings) {
            this._sigIds.forEach(id => this._bgSettings.disconnect(id));
        }
        this._sigIds = [];
        this._bgSettings = null;
        this._thumb = null;
        this._blur = null;
    }
}

// Returns display name of workspace at `index`, formatted in the applet's chosen language when default.
function workspaceDisplayName(index) {
    if (Main.hasDefaultWorkspaceName(index)) {
        return tr('desktopN', index + 1);
    }
    return Main.getWorkspaceName(index);
}

// Moves workspace `fromIndex` to `toIndex`, keeping custom workspace names aligned.
function reorderWorkspace(fromIndex, toIndex) {
    const wm = global.workspace_manager;
    const n = wm.n_workspaces;
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= n || toIndex >= n) return false;
    const ws = wm.get_workspace_by_index(fromIndex);
    if (!ws || typeof wm.reorder_workspace !== 'function') return false;

    const names = Main.wmSettings.get_strv('workspace-names').slice();
    while (names.length < n) names.push('');
    const [moved] = names.splice(fromIndex, 1);
    names.splice(toIndex, 0, moved || '');
    while (names.length > 0 && !names[names.length - 1]) names.pop();

    wm.reorder_workspace(ws, toIndex);
    Main.wmSettings.set_strv('workspace-names', names);
    return true;
}

// Closes workspace at `index`, cleanly updating workspace-names and moving sticky/remaining windows.
function closeWorkspace(index) {
    const wm = global.workspace_manager;
    if (wm.n_workspaces <= 1 || index < 0 || index >= wm.n_workspaces) return false;
    const ws = wm.get_workspace_by_index(index);
    if (!ws) return false;
    // Move non-sticky windows to an adjacent workspace before removing (Main._removeWorkspace also handles it,
    // but doing it explicitly prevents transient windows from flickering).
    const targetIdx = index > 0 ? index - 1 : 1;
    const targetWs = wm.get_workspace_by_index(targetIdx);
    if (targetWs) {
        ws.list_windows().forEach(w => {
            if (!w.is_on_all_workspaces()) {
                w.change_workspace(targetWs);
            }
        });
    }
    return Main._removeWorkspace(ws);
}

// Moves `metaWindow` to a newly appended workspace without switching away from the active workspace.
function moveWindowToNewDesktop(metaWindow) {
    if (!metaWindow) return -1;
    const wm = global.workspace_manager;
    const newIdx = wm.n_workspaces;
    if (metaWindow.is_on_all_workspaces()) metaWindow.unstick();
    if (Main._addWorkspace()) {
        const newWs = wm.get_workspace_by_index(newIdx);
        if (newWs) {
            metaWindow.change_workspace(newWs);
            return newIdx;
        }
    }
    Main.moveWindowToNewWorkspace(metaWindow, false);
    return wm.n_workspaces - 1;
}

// Lists interesting windows for a workspace in stacking order (bottom to top) or MRU.
function getWorkspaceWindows(workspace, monitorIndex, showAllMonitors) {
    if (!workspace) return [];
    const wins = workspace.list_windows().filter(w => {
        if (!Main.isInteresting(w)) return false;
        if (!showAllMonitors && monitorIndex >= 0 && w.get_monitor() !== monitorIndex) return false;
        return true;
    });
    // Sort by display stacking order (bottom to top) for accurate miniature layering.
    try {
        return global.display.sort_windows_by_stacking(wins);
    } catch (e) {
        return wins;
    }
}

function snapWindow(metaWindow, side) {
    if (!metaWindow) return;
    try {
        if (metaWindow.minimized) metaWindow.unminimize();
        if (metaWindow.get_maximized()) metaWindow.unmaximize(Meta.MaximizeFlags.BOTH);
        const wa = metaWindow.get_work_area_current_monitor();
        const halfW = Math.floor(wa.width / 2);
        const x = side === 'left' ? wa.x : wa.x + halfW;
        const w = side === 'left' ? halfW : wa.width - halfW;
        metaWindow.move_resize_frame(false, x, wa.y, w, wa.height);
    } catch (e) { /* window gone */ }
}

function appIconForWindow(metaWindow, size) {
    try {
        if (!_windowTracker) _windowTracker = Cinnamon.WindowTracker.get_default();
        const app = _windowTracker.get_window_app(metaWindow);
        if (app) {
            const info = app.is_window_backed() ? null : app.get_app_info();
            const gicon = info ? info.get_icon() : null;
            if (gicon) {
                const tex = St.TextureCache.get_default().load_gicon(null, gicon, size);
                if (tex) {
                    tex.set_size(size, size);
                    return tex;
                }
            }
            const t = app.create_icon_texture(size);
            if (t) return t;
        }
    } catch (e) { /* fallback */ }
    return new St.Icon({ icon_name: 'application-x-executable', icon_size: size });
}

module.exports = {
    Timer,
    parseColorRgba,
    detectDarkTheme,
    WallpaperCache,
    workspaceDisplayName,
    reorderWorkspace,
    closeWorkspace,
    moveWindowToNewDesktop,
    getWorkspaceWindows,
    snapWindow,
    appIconForWindow,
};
