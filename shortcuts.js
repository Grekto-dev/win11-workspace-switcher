// Global workspace shortcuts manager with Windows 11 defaults and system-conflict protection.
const { Gio, GLib } = imports.gi;
const Main = imports.ui.main;

const MOD_ALIASES = {
    control: 'ctrl',
    ctrl: 'ctrl',
    primary: 'ctrl',
    alt: 'alt',
    mod1: 'alt',
    shift: 'shift',
    super: 'super',
    mod4: 'super',
    meta: 'meta',
    hyper: 'hyper',
};

const MOD_ORDER = ['ctrl', 'alt', 'shift', 'super', 'meta', 'hyper'];

const STATIC_KB_KEYS = [
    'looking-glass-keybinding',
    'magnifier-zoom-in',
    'magnifier-zoom-out',
    'magnifier-zoom-reset',
    'pointer-next-monitor',
    'pointer-previous-monitor',
    'show-desklets',
];

function parseAccelList(raw) {
    if (!raw || typeof raw !== 'string') return [];
    return raw.split('::').map(s => s.trim()).filter(s => s.length > 0);
}

function normalizeAccel(accel) {
    if (!accel || typeof accel !== 'string') return '';
    let s = accel.trim();
    if (!s) return '';

    const mods = new Set();
    let match;
    const modRe = /^<([^>]+)>/;
    while ((match = modRe.exec(s)) !== null) {
        const mapped = MOD_ALIASES[match[1].toLowerCase()];
        if (mapped) mods.add(mapped);
        s = s.slice(match[0].length);
    }

    const key = s.trim().toLowerCase();
    if (!key) return '';

    const ordered = MOD_ORDER.filter(m => mods.has(m));
    ordered.push(key);
    return ordered.join('+');
}

function _schemaLookup(schemaId) {
    try {
        const src = Gio.SettingsSchemaSource.get_default();
        return src ? src.lookup(schemaId, true) : null;
    } catch (e) {
        return null;
    }
}

class ShortcutManager {
    constructor(applet, getSpecs, onConflict) {
        this.applet = applet;
        this._getSpecs = getSpecs;
        this._onConflict = onConflict;
        this._lastValid = Object.create(null);
        this._reverting = false;
        this._boundNames = new Set();
        this._sysSettings = [];
        this._sysSigIds = [];
        this._syncIdleId = 0;

        this._watchSystemSchemas();
    }

    _watchSystemSchemas() {
        const scheduleSync = () => {
            if (this.applet.destroyed || this._syncIdleId) return;
            this._syncIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._syncIdleId = 0;
                if (!this.applet.destroyed) this.sync(null);
                return GLib.SOURCE_REMOVE;
            });
        };

        const addSchema = (schemaId, path = null) => {
            if (!_schemaLookup(schemaId)) return null;
            try {
                const gs = path
                    ? Gio.Settings.new_with_path(schemaId, path)
                    : new Gio.Settings({ schema_id: schemaId });
                this._sysSettings.push(gs);
                this._sysSigIds.push([gs, gs.connect('changed', scheduleSync)]);
                return gs;
            } catch (e) {
                return null;
            }
        };

        this._kbRoot = addSchema('org.cinnamon.desktop.keybindings');
        this._kbWm = addSchema('org.cinnamon.desktop.keybindings.wm');
        this._kbMedia = addSchema('org.cinnamon.desktop.keybindings.media-keys');
        this._kbMuffin = addSchema('org.cinnamon.muffin.keybindings');
    }

    _collectSystemBindings() {
        const map = new Map();
        const ownPrefix = `${this.applet.metadata.uuid}::`;

        const addAll = (list, label) => {
            if (!list) return;
            for (let i = 0; i < list.length; i++) {
                const norm = normalizeAccel(list[i]);
                if (norm && !map.has(norm)) map.set(norm, label);
            }
        };

        const scanSchemaAll = (gs, prefix) => {
            if (!gs) return;
            try {
                const keys = gs.list_keys();
                for (let i = 0; i < keys.length; i++) {
                    const k = keys[i];
                    try {
                        addAll(gs.get_strv(k), `${prefix}: ${k}`);
                    } catch (e) { /* non-strv key */ }
                }
            } catch (e) { /* ignore */ }
        };

        scanSchemaAll(this._kbWm, 'wm');
        scanSchemaAll(this._kbMedia, 'media-keys');
        scanSchemaAll(this._kbMuffin, 'muffin');

        if (this._kbRoot) {
            for (let i = 0; i < STATIC_KB_KEYS.length; i++) {
                const k = STATIC_KB_KEYS[i];
                try {
                    addAll(this._kbRoot.get_strv(k), `system: ${k}`);
                } catch (e) { /* ignore */ }
            }
            if (_schemaLookup('org.cinnamon.desktop.keybindings.custom-keybinding')) {
                try {
                    const customs = this._kbRoot.get_strv('custom-list');
                    for (let i = 0; i < customs.length; i++) {
                        const id = customs[i];
                        if (!id) continue;
                        const path = `/org/cinnamon/desktop/keybindings/custom-keybindings/${id}/`;
                        const cs = Gio.Settings.new_with_path('org.cinnamon.desktop.keybindings.custom-keybinding', path);
                        const name = cs.get_string('name') || id;
                        addAll(cs.get_strv('binding'), name);
                    }
                } catch (e) { /* ignore */ }
            }
        }

        // Also check active bindings registered in Cinnamon's keybindingManager (other applets/desklets/extensions)
        try {
            const km = Main.keybindingManager;
            if (km && km.bindings) {
                for (const entry of km.bindings.values()) {
                    if (!entry || !entry.name || entry.name.startsWith(ownPrefix)) continue;
                    addAll(entry.bindings, entry.name);
                }
            }
            if (km && km.applet_bindings) {
                for (const xletKey of km.applet_bindings.keys()) {
                    if (!xletKey || xletKey.startsWith(ownPrefix)) continue;
                    const parts = xletKey.split('::');
                    const raw = parts.slice(2).join('::');
                    addAll([raw], `${parts[0]} (${parts[1] || 'shortcut'})`);
                }
            }
        } catch (e) { /* ignore */ }

        return map;
    }

    _clearOne(name) {
        this._boundNames.delete(name);
        try {
            Main.keybindingManager.removeXletHotKey(this.applet, name);
        } catch (e) { /* ignore */ }
    }

    sync(changedKey = null) {
        if (this._reverting || this.applet.destroyed) return;

        const specs = this._getSpecs();
        if (!this.applet.enableShortcuts) {
            for (let i = 0; i < specs.length; i++) {
                this._clearOne(specs[i].name);
            }
            return;
        }

        const systemMap = this._collectSystemBindings();
        const usedInApplet = new Set();

        // Process unchanged slots first so a newly edited slot cannot steal an existing applet shortcut.
        const ordered = changedKey
            ? specs.filter(s => s.key !== changedKey).concat(specs.filter(s => s.key === changedKey))
            : specs;

        for (let i = 0; i < ordered.length; i++) {
            const spec = ordered[i];
            this._clearOne(spec.name);

            const candidates = parseAccelList(spec.value);
            if (candidates.length === 0) {
                this._lastValid[spec.key] = '';
                continue;
            }

            const kept = [];
            let firstConflict = null;

            for (let j = 0; j < candidates.length; j++) {
                const raw = candidates[j];
                const norm = normalizeAccel(raw);
                if (!norm) continue;
                const sysSrc = systemMap.get(norm);
                if (sysSrc) {
                    if (!firstConflict) firstConflict = { accel: raw, source: sysSrc };
                } else if (usedInApplet.has(norm)) {
                    if (!firstConflict) firstConflict = { accel: raw, source: this.applet.metadata.name };
                } else {
                    usedInApplet.add(norm);
                    kept.push(raw);
                }
            }

            if (firstConflict && spec.key === changedKey) {
                const fallback = this._lastValid[spec.key] || '::';
                const validFallback = parseAccelList(fallback).filter(a => {
                    const n = normalizeAccel(a);
                    return n && !systemMap.has(n) && !usedInApplet.has(n);
                });
                this._reverting = true;
                try {
                    this.applet.settings.setValue(spec.key, validFallback.length > 0 ? validFallback.join('::') : '::');
                } finally {
                    this._reverting = false;
                }
                if (validFallback.length > 0) {
                    validFallback.forEach(a => usedInApplet.add(normalizeAccel(a)));
                    Main.keybindingManager.addXletHotKey(this.applet, spec.name, validFallback.join('::'), spec.callback);
                    this._boundNames.add(spec.name);
                    this._lastValid[spec.key] = validFallback.join('::');
                } else {
                    this._lastValid[spec.key] = '';
                }
                if (this._onConflict) this._onConflict(spec, firstConflict);
                continue;
            }

            if (firstConflict) {
                global.log(`[${this.applet.metadata.uuid}] Skipping conflicting shortcut '${firstConflict.accel}' for '${spec.key}' (in use by ${firstConflict.source})`);
            }

            const bindingStr = kept.join('::');
            this._lastValid[spec.key] = bindingStr;
            if (bindingStr.length > 0) {
                Main.keybindingManager.addXletHotKey(this.applet, spec.name, bindingStr, spec.callback);
                this._boundNames.add(spec.name);
            }
        }
    }

    destroy() {
        if (this._syncIdleId) {
            GLib.source_remove(this._syncIdleId);
            this._syncIdleId = 0;
        }
        this._sysSigIds.forEach(([obj, id]) => {
            try { obj.disconnect(id); } catch (e) { /* already gone */ }
        });
        this._sysSigIds = [];
        this._sysSettings = [];
        for (const name of Array.from(this._boundNames)) {
            this._clearOne(name);
        }
        this._boundNames.clear();
    }
}

module.exports = {
    parseAccelList,
    normalizeAccel,
    ShortcutManager,
};
