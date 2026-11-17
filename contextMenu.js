// Windows 11 style floating context menu (supports right-aligned shortcuts and submenus).
const { Clutter, St, Pango } = imports.gi;
const Main = imports.ui.main;
const { monitorRect, preferredSize } = require('./popup');

class ContextMenu {
    constructor(applet) {
        this.applet = applet;
        this.actor = null;
        this._submenu = null;
        this._rows = [];
        this._callbacks = [];
        this._selected = -1;
        this._captureId = 0;
        this._grabbed = false;
        this._onClose = null;
        this._parentIsModal = false;
    }

    get isOpen() {
        return this.actor !== null;
    }

    // Opens menu at screen coordinates (anchorX, anchorY) or centered above `anchorActor`.
    // `items`: [{ kind: 'item'|'separator', label, shortcut?, submenu?, disabled?, checked?, activate() }]
    openAt(x, y, items, { dark = true, parentIsModal = false, onClose = null } = {}) {
        this.close(true);
        this._parentIsModal = parentIsModal;
        this._onClose = onClose;

        const actor = this._buildBox(items, dark, false);
        Main.layoutManager.addChrome(actor);
        actor.opacity = 0;

        if (!parentIsModal) {
            if (Main.pushModal(actor)) {
                this._grabbed = true;
            }
        }

        this.actor = actor;
        const [w, h] = preferredSize(actor);
        const mon = monitorRect(actor);
        const px = Math.max(mon.x + 8, Math.min(Math.round(x), mon.x + mon.width - w - 8));
        const py = Math.max(mon.y + 8, Math.min(Math.round(y), mon.y + mon.height - h - 8));
        actor.set_position(px, py);

        if (this.applet.animFlyout) {
            actor.translation_y = 8;
            actor.ease({
                opacity: 255,
                translation_y: 0,
                duration: 150,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        } else {
            actor.opacity = 255;
        }

        if (!parentIsModal) {
            actor.grab_key_focus();
        }

        this._captureId = global.stage.connect('captured-event', (stage, event) => this._onCaptured(event));
        return true;
    }

    _buildBox(items, dark, isSubmenu) {
        const cls = dark ? 'win11-ws-menu win11-ws-dark' : 'win11-ws-menu win11-ws-light';
        const actor = new St.BoxLayout({
            style_class: cls,
            vertical: true,
            reactive: true,
            can_focus: true,
        });

        const rows = isSubmenu ? null : this._rows;
        const cbs = isSubmenu ? null : this._callbacks;

        items.forEach(item => {
            if (item.kind === 'separator') {
                const sep = new St.Widget({ style_class: 'win11-ws-menu-sep', x_expand: true });
                sep.set_height(1);
                actor.add_child(sep);
                return;
            }

            const pill = new St.BoxLayout({
                style_class: 'win11-ws-menu-item',
                reactive: !item.disabled,
                track_hover: !item.disabled,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            if (item.disabled) pill.add_style_pseudo_class('insensitive');

            if (item.checked !== undefined) {
                const chk = new St.Label({
                    style_class: 'win11-ws-menu-check',
                    text: item.checked ? '✓' : '',
                    y_align: Clutter.ActorAlign.CENTER,
                });
                pill.add_child(chk);
            }

            const label = new St.Label({
                style_class: 'win11-ws-menu-label',
                text: item.label,
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
            });
            label.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
            pill.add_child(label);

            if (item.shortcut) {
                const sc = new St.Label({
                    style_class: 'win11-ws-menu-shortcut',
                    text: item.shortcut,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                pill.add_child(sc);
            }

            if (item.submenu) {
                const arrow = new St.Label({
                    style_class: 'win11-ws-menu-shortcut',
                    text: '›',
                    y_align: Clutter.ActorAlign.CENTER,
                });
                pill.add_child(arrow);
            }

            const idx = rows ? rows.length : -1;
            if (!item.disabled) {
                if (rows) {
                    rows.push(pill);
                    cbs.push(item.activate || null);
                }
                pill.connect('enter-event', () => {
                    if (rows) this._select(idx);
                    if (item.submenu) {
                        this._openSubmenu(pill, item.submenu, dark);
                    } else {
                        this._closeSubmenu();
                    }
                    return Clutter.EVENT_PROPAGATE;
                });
                pill.connect('button-release-event', (a, event) => {
                    if (event.get_button() !== 1) return Clutter.EVENT_STOP;
                    if (item.submenu) {
                        this._openSubmenu(pill, item.submenu, dark);
                        return Clutter.EVENT_STOP;
                    }
                    this.close(true);
                    if (item.activate) item.activate();
                    return Clutter.EVENT_STOP;
                });
            }

            actor.add_child(pill);
        });

        if (!isSubmenu) {
            actor.connect('key-press-event', (a, ev) => this._onKey(ev));
        }
        return actor;
    }

    _openSubmenu(parentPill, items, dark) {
        this._closeSubmenu();
        const sub = this._buildBox(items, dark, true);
        Main.layoutManager.addChrome(sub);
        const [pw, ph] = preferredSize(sub);
        const [ax, ay] = parentPill.get_transformed_position();
        const [aw] = parentPill.get_transformed_size();
        const mon = monitorRect(sub);
        let sx = ax + aw - 2;
        if (sx + pw > mon.x + mon.width - 8) sx = ax - pw + 2;
        const sy = Math.max(mon.y + 8, Math.min(ay - 4, mon.y + mon.height - ph - 8));
        sub.set_position(Math.round(sx), Math.round(sy));
        this._submenu = sub;
    }

    _closeSubmenu() {
        if (!this._submenu) return;
        const s = this._submenu;
        this._submenu = null;
        Main.layoutManager.removeChrome(s);
        s.destroy();
    }

    _select(idx) {
        if (this._selected === idx) return;
        if (this._selected >= 0 && this._rows[this._selected]) {
            this._rows[this._selected].remove_style_class_name('win11-ws-menu-focus');
        }
        this._selected = idx;
        if (idx >= 0 && this._rows[idx]) {
            this._rows[idx].add_style_class_name('win11-ws-menu-focus');
        }
    }

    _onKey(event) {
        const sym = event.get_key_symbol();
        if (sym === Clutter.KEY_Escape) {
            this.close(false);
            return Clutter.EVENT_STOP;
        }
        if (this._rows.length === 0) return Clutter.EVENT_PROPAGATE;
        if (sym === Clutter.KEY_Down) {
            this._select((this._selected + 1) % this._rows.length);
            return Clutter.EVENT_STOP;
        }
        if (sym === Clutter.KEY_Up) {
            this._select((this._selected - 1 + this._rows.length) % this._rows.length);
            return Clutter.EVENT_STOP;
        }
        if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter || sym === Clutter.KEY_space) {
            if (this._selected >= 0 && this._callbacks[this._selected]) {
                const cb = this._callbacks[this._selected];
                this.close(true);
                cb();
                return Clutter.EVENT_STOP;
            }
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _insideActor(target, root) {
        let a = target;
        while (a) {
            if (a === root) return true;
            a = a.get_parent();
        }
        return false;
    }

    _onCaptured(event) {
        const type = event.type();
        if (type === Clutter.EventType.KEY_PRESS && event.get_key_symbol() === Clutter.KEY_Escape) {
            this.close(false);
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.BUTTON_PRESS) {
            const target = event.get_source();
            const inMain = this.actor && this._insideActor(target, this.actor);
            const inSub = this._submenu && this._insideActor(target, this._submenu);
            if (!inMain && !inSub) {
                this.close(false);
                // Swallow click outside when opened as modal standalone; let parent modal see it only if needed
                return Clutter.EVENT_STOP;
            }
        }
        return Clutter.EVENT_PROPAGATE;
    }

    close(immediate) {
        this._closeSubmenu();
        if (this._captureId) {
            global.stage.disconnect(this._captureId);
            this._captureId = 0;
        }
        const actor = this.actor;
        this.actor = null;
        this._rows = [];
        this._callbacks = [];
        this._selected = -1;

        const cb = this._onClose;
        this._onClose = null;

        if (!actor) {
            if (cb) cb();
            return;
        }

        if (this._grabbed) {
            this._grabbed = false;
            try { Main.popModal(actor); } catch (e) { /* already popped */ }
        }

        const finish = () => {
            Main.layoutManager.removeChrome(actor);
            actor.destroy();
            if (cb) cb();
        };

        actor.remove_all_transitions();
        if (immediate || !this.applet.animFlyout) {
            finish();
        } else {
            actor.ease({
                opacity: 0,
                duration: 60,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: finish,
            });
        }
    }

    destroy() {
        this.close(true);
    }
}

module.exports = { ContextMenu };
