// Hover flyout: floating Virtual Desktops strip shown above the taskbar Task View button.
// Measured geometry: 9 px above taskbar, 8 px inner padding, radius 8 px, max monitor width - 16 px.
const { Clutter, St } = imports.gi;
const Main = imports.ui.main;
const { Timer } = require('./util');
const { DesktopStrip } = require('./desktopStrip');
const { MARGIN, monitorRect, placeNear, revealFromPanel } = require('./popup');

const CLOSE_DELAY_MS = 300;
const FLYOUT_GAP = 9;
const FLYOUT_PAD = 8;

class WorkspaceFlyout {
    constructor(applet) {
        this.applet = applet;
        this.actor = null;
        this.strip = null;
        this.sticky = false;
        this._closeTimer = new Timer();
        this._captureId = 0;
        this._pointerInside = false;
    }

    get isOpen() {
        return this.actor !== null;
    }

    open(sticky = false) {
        this._closeTimer.clear();
        if (sticky) this.sticky = true;

        const dark = this.applet.isDark;
        const mon = Main.layoutManager.findMonitorForActor(this.applet.actor) || Main.layoutManager.primaryMonitor;

        if (!this.actor) {
            const cls = (dark ? 'win11-ws-flyout win11-ws-dark' : 'win11-ws-flyout win11-ws-light')
                + (this.applet.liteMode ? ' win11-ws-lite' : '');
            this.actor = new St.BoxLayout({
                style_class: cls,
                vertical: true,
                reactive: true,
                track_hover: true,
            });
            this.actor.set_style(`padding: ${FLYOUT_PAD}px;`);

            this.actor.connect('enter-event', () => {
                this._pointerInside = true;
                this._closeTimer.clear();
                return Clutter.EVENT_PROPAGATE;
            });
            this.actor.connect('leave-event', () => {
                this._pointerInside = false;
                this.scheduleClose();
                return Clutter.EVENT_PROPAGATE;
            });

            this.strip = new DesktopStrip(this.applet, mon, {
                inTaskView: false,
                onActivateCard: (idx, ws) => {
                    this.close(true);
                    Main.wm.moveToWorkspace(ws);
                    this.applet.showOsdIfEnabled(idx);
                },
                onAddDesktop: () => {
                    const newIdx = global.workspace_manager.n_workspaces;
                    Main._addWorkspace();
                    if (this.applet.switchOnAdd) {
                        const ws = global.workspace_manager.get_workspace_by_index(newIdx);
                        if (ws) {
                            Main.wm.moveToWorkspace(ws);
                            this.applet.showOsdIfEnabled(newIdx);
                        }
                    }
                    this.refresh();
                },
                onBeforeModal: () => this.close(true),
            });
            this.actor.add_child(this.strip.actor);

            Main.layoutManager.addChrome(this.actor);
            this.actor.opacity = 0;
            this._reposition(mon);
            revealFromPanel(this.applet, this.actor, 250, Clutter.AnimationMode.EASE_OUT_QUINT);
        } else {
            const cls = (dark ? 'win11-ws-flyout win11-ws-dark' : 'win11-ws-flyout win11-ws-light')
                + (this.applet.liteMode ? ' win11-ws-lite' : '');
            this.actor.set_style_class_name(cls);
            this.strip.refresh();
            this._reposition(mon);
            this.actor.opacity = 255;
        }

        if (this.sticky && !this._captureId) {
            this._captureId = global.stage.connect('captured-event', (stage, ev) => {
                if (ev.type() !== Clutter.EventType.BUTTON_PRESS) return Clutter.EVENT_PROPAGATE;
                if (this.applet.contextMenu.isOpen || (this.strip && this.strip.isBusy)) {
                    return Clutter.EVENT_PROPAGATE;
                }
                const target = ev.get_source();
                if (!this._isInside(target, this.actor) && !this._isInside(target, this.applet.actor)) {
                    this.close(false);
                }
                return Clutter.EVENT_PROPAGATE;
            });
        }
    }

    _isInside(target, root) {
        let a = target;
        while (a) {
            if (a === root) return true;
            a = a.get_parent();
        }
        return false;
    }

    _reposition(mon) {
        if (!this.actor || !this.strip) return;
        const maxW = Math.max(280, mon.width - MARGIN * 2);
        const contentW = this.strip.totalContentWidth() + FLYOUT_PAD * 2 + 4;
        const w = Math.min(maxW, contentW);
        this.strip.actor.set_width(w - FLYOUT_PAD * 2);
        const [, h] = this.actor.get_preferred_height(w);
        const finalH = Math.ceil(h);
        this.actor.set_width(w);
        const [x, y] = placeNear(this.applet, this.applet.buttonActor, w, finalH, FLYOUT_GAP);
        this.actor.set_position(x, y);
        Main.layoutManager._chrome.updateRegions();
    }

    refresh() {
        if (!this.isOpen || !this.strip) return;
        const mon = monitorRect(this.actor);
        this.strip.refresh();
        this._reposition(mon);
    }

    updateActiveState() {
        if (!this.isOpen || !this.strip) return;
        this.strip.updateActiveState();
    }

    cancelClose() {
        this._closeTimer.clear();
    }

    scheduleClose() {
        if (this.sticky) return;
        this._closeTimer.set(CLOSE_DELAY_MS, () => {
            if (this._pointerInside || this.applet.buttonHovered) return;
            if (this.applet.contextMenu.isOpen || (this.strip && this.strip.isBusy)) {
                this.scheduleClose();
                return;
            }
            this.close(false);
        });
    }

    close(immediate = false) {
        this._closeTimer.clear();
        this._pointerInside = false;
        this.sticky = false;
        if (this._captureId) {
            global.stage.disconnect(this._captureId);
            this._captureId = 0;
        }
        if (this.applet.contextMenu.isOpen) {
            this.applet.contextMenu.close(true);
        }

        const actor = this.actor;
        const strip = this.strip;
        this.actor = null;
        this.strip = null;
        if (!actor) return;

        actor.remove_all_transitions();
        const done = () => {
            if (strip) strip.destroy();
            Main.layoutManager.removeChrome(actor);
            actor.destroy();
        };

        if (immediate || !this.applet.animFlyout) {
            done();
        } else {
            actor.ease({
                opacity: 0,
                duration: 80,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: done,
            });
        }
    }

    destroy() {
        this.close(true);
    }
}

module.exports = { WorkspaceFlyout };
