// Win11-Like Workspace Switcher — Cinnamon applet.
// Faithfully reproduces the Windows 11 Task View button, press-converge animation,
// hover Virtual Desktops flyout, and full Task View overlay with minimal CPU/RAM overhead.
const Applet = imports.ui.applet;
const AppletManager = imports.ui.appletManager;
const Main = imports.ui.main;
const ModalDialog = imports.ui.modalDialog;
const Settings = imports.ui.settings;
const { Clutter, St } = imports.gi;

const { setLanguage, tr } = require('./i18n');
const {
    Timer,
    detectDarkTheme,
    WallpaperCache,
    workspaceDisplayName,
    closeWorkspace,
} = require('./util');
const { ButtonArt } = require('./buttonArt');
const { ContextMenu } = require('./contextMenu');
const { WorkspaceFlyout } = require('./flyout');
const { Win11TaskView } = require('./taskView');
const { placeNear, preferredSize } = require('./popup');
const { ShortcutManager } = require('./shortcuts');

class Win11WorkspaceSwitcher extends Applet.Applet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);
        this.metadata = metadata;
        this.instanceId = instanceId;
        this.orientation = orientation;
        this.destroyed = false;

        this.buttonHovered = false;
        this._pressed = false;
        this._downBtn = 0;
        this._hoverTimer = new Timer();
        this._osdTimer = new Timer();
        this._tipActor = null;
        this._osdActor = null;
        this._signals = [];

        this.setAllowedLayout(Applet.AllowedLayout.BOTH);
        this.actor.set_track_hover(false);
        this.actor.set_style_class_name('win11-ws-applet');
        this.actor.set_style('padding: 0; margin: 0;');

        this._bindSettings();
        setLanguage(this.language);

        this.wallpaper = new WallpaperCache(() => {
            if (this.flyout && this.flyout.isOpen) this.flyout.refresh();
        });
        this.contextMenu = new ContextMenu(this);
        this.flyout = new WorkspaceFlyout(this);
        this.taskView = new Win11TaskView(this);

        // Centered container holding the pure-Cairo 40x40 Task View button
        this._wrap = new St.Bin({
            style_class: 'win11-ws-btn-wrap',
            x_expand: true,
            y_expand: true,
            x_align: St.Align.MIDDLE,
            y_align: St.Align.MIDDLE,
        });
        this.button = new ButtonArt(this);
        this._wrap.set_child(this.button.actor);
        this.actor.add_child(this._wrap);

        this._connectButtonEvents();
        this._connectWorkspaceSignals();
        this._refreshDarkTheme();
        this._applyMetrics();

        this.shortcuts = new ShortcutManager(
            this,
            () => this._shortcutSpecs(),
            (spec, conflict) => {
                Main.notify(
                    tr('shortcutConflictTitle'),
                    tr('shortcutConflictBody', conflict.accel, conflict.source)
                );
            }
        );
        this.shortcuts.sync(null);
    }

    get buttonActor() {
        return this.button.actor;
    }

    get isDark() {
        return this._cachedIsDark !== undefined ? this._cachedIsDark : true;
    }

    _refreshDarkTheme() {
        this._cachedIsDark = detectDarkTheme(this.themeMode, this);
    }

    get animButton() {
        return !this.liteMode && this.enableAnimations && this._animButton;
    }

    get animFlyout() {
        return !this.liteMode && this.enableAnimations && this._animFlyout;
    }

    get animTaskView() {
        return !this.liteMode && this.enableAnimations && this._animTaskView;
    }

    get taskviewBlur() {
        return !this.liteMode && this._taskviewBlur;
    }

    get taskviewLiveClones() {
        return !this.liteMode && this._taskviewLiveClones;
    }

    get effectivePreviewMode() {
        if (this.liteMode && this.desktopPreviewMode === 'live') return 'schematic';
        return this.desktopPreviewMode;
    }

    _bindSettings() {
        this.settings = new Settings.AppletSettings(this, this.metadata.uuid, this.instanceId);
        const IN = Settings.BindingDirection.IN;
        const s = this.settings;

        const onVisualChange = () => {
            this._refreshDarkTheme();
            this._applyMetrics();
            if (this.flyout.isOpen) this.flyout.refresh();
        };

        s.bindProperty(IN, 'language', 'language', () => {
            setLanguage(this.language);
            if (this.flyout.isOpen) this.flyout.refresh();
        });
        s.bindProperty(IN, 'theme-mode', 'themeMode', onVisualChange);
        s.bindProperty(IN, 'accent-color', 'accentColor', onVisualChange);
        s.bindProperty(IN, 'icon-size-mode', 'iconSizeMode', onVisualChange);
        s.bindProperty(IN, 'icon-size', 'iconSize', onVisualChange);

        s.bindProperty(IN, 'click-action', 'clickAction', null);
        s.bindProperty(IN, 'middle-click-action', 'middleClickAction', null);
        s.bindProperty(IN, 'scroll-switch', 'scrollSwitch', null);
        s.bindProperty(IN, 'show-osd-pill', 'showOsdPill', null);

        s.bindProperty(IN, 'hover-flyout', 'hoverFlyout', null);
        s.bindProperty(IN, 'hover-delay', 'hoverDelay', null);
        s.bindProperty(IN, 'flyout-on-single', 'flyoutOnSingle', null);
        s.bindProperty(IN, 'show-tooltip', 'showTooltip', null);

        s.bindProperty(IN, 'show-workspace-names', 'showWorkspaceNames', onVisualChange);
        s.bindProperty(IN, 'show-add-button', 'showAddButton', onVisualChange);
        s.bindProperty(IN, 'confirm-close-nonempty', 'confirmCloseNonEmpty', null);

        s.bindProperty(IN, 'show-all-monitors', 'showAllMonitors', null);
        s.bindProperty(IN, 'taskview-blur', '_taskviewBlur', null);
        s.bindProperty(IN, 'switch-on-add', 'switchOnAdd', null);

        s.bindProperty(IN, 'enable-animations', 'enableAnimations', null);
        s.bindProperty(IN, 'animate-button', '_animButton', null);
        s.bindProperty(IN, 'animate-flyout', '_animFlyout', null);
        s.bindProperty(IN, 'animate-taskview', '_animTaskView', null);

        s.bindProperty(IN, 'desktop-preview-mode', 'desktopPreviewMode', onVisualChange);
        s.bindProperty(IN, 'taskview-live-clones', '_taskviewLiveClones', null);
        s.bindProperty(IN, 'lite-mode', 'liteMode', onVisualChange);

        s.bindProperty(IN, 'enable-shortcuts', 'enableShortcuts', () => this.shortcuts && this.shortcuts.sync(null));
        s.bindProperty(IN, 'shortcut-taskview', 'shortcutTaskView', () => this.shortcuts && this.shortcuts.sync('shortcut-taskview'));
        s.bindProperty(IN, 'shortcut-workspace-left', 'shortcutWorkspaceLeft', () => this.shortcuts && this.shortcuts.sync('shortcut-workspace-left'));
        s.bindProperty(IN, 'shortcut-workspace-right', 'shortcutWorkspaceRight', () => this.shortcuts && this.shortcuts.sync('shortcut-workspace-right'));
        s.bindProperty(IN, 'shortcut-new-workspace', 'shortcutNewWorkspace', () => this.shortcuts && this.shortcuts.sync('shortcut-new-workspace'));
        s.bindProperty(IN, 'shortcut-close-workspace', 'shortcutCloseWorkspace', () => this.shortcuts && this.shortcuts.sync('shortcut-close-workspace'));
    }

    _shortcutSpecs() {
        return [
            {
                key: 'shortcut-taskview',
                name: 'win11-ws-taskview',
                value: this.shortcutTaskView,
                callback: () => this._onHotkeyTaskView(),
            },
            {
                key: 'shortcut-workspace-left',
                name: 'win11-ws-left',
                value: this.shortcutWorkspaceLeft,
                callback: () => this._switchWorkspaceStep(-1),
            },
            {
                key: 'shortcut-workspace-right',
                name: 'win11-ws-right',
                value: this.shortcutWorkspaceRight,
                callback: () => this._switchWorkspaceStep(1),
            },
            {
                key: 'shortcut-new-workspace',
                name: 'win11-ws-new',
                value: this.shortcutNewWorkspace,
                callback: () => this._addAndActivateWorkspace(),
            },
            {
                key: 'shortcut-close-workspace',
                name: 'win11-ws-close',
                value: this.shortcutCloseWorkspace,
                callback: () => this._closeActiveWorkspace(),
            },
        ];
    }

    _shouldHandleHotkey() {
        if (this.destroyed || global.settings.get_boolean('panel-edit-mode')) return false;
        const curMon = Main.layoutManager.currentMonitor ? Main.layoutManager.currentMonitor.index : 0;
        const myMon = this.panel ? this.panel.monitorIndex : curMon;
        if (myMon !== curMon) {
            const others = AppletManager.getRunningInstancesForUuid(this.metadata.uuid);
            if (others.some(inst => inst !== this && inst.panel && inst.panel.monitorIndex === curMon)) {
                return false;
            }
        }
        return true;
    }

    _onHotkeyTaskView() {
        if (!this._shouldHandleHotkey()) return;
        if ((Main.overview.visible || Main.expo.visible) && !this.taskView.isOpen) return;
        if (this.contextMenu.isOpen) this.contextMenu.close(true);
        this.taskView.toggle();
    }

    _switchWorkspaceStep(delta) {
        if (!this._shouldHandleHotkey()) return;
        const wm = global.workspace_manager;
        const n = wm.n_workspaces;
        const cur = wm.get_active_workspace_index();
        const next = cur + delta;
        if (next < 0 || next >= n) return;
        const ws = wm.get_workspace_by_index(next);
        if (!ws) return;
        Main.wm.moveToWorkspace(ws);
        this.showOsdIfEnabled(next);
        if (this.taskView.isOpen) {
            this.taskView._previewWsIndex = next;
            if (this.taskView._strip) {
                this.taskView._strip.setPreviewIndex(next);
                this.taskView._strip.scrollCardIntoView(next);
            }
            this.taskView._rebuildWindowGrid(false);
        }
    }

    _addAndActivateWorkspace() {
        if (!this._shouldHandleHotkey()) return;
        const idx = global.workspace_manager.n_workspaces;
        if (!Main._addWorkspace()) return;
        const ws = global.workspace_manager.get_workspace_by_index(idx);
        if (ws) {
            Main.wm.moveToWorkspace(ws);
            this.showOsdIfEnabled(idx);
        }
        if (this.taskView.isOpen) {
            this.taskView._previewWsIndex = idx;
            if (this.taskView._strip) {
                this.taskView._strip.setPreviewIndex(idx);
                this.taskView._strip.refresh();
                this.taskView._strip.scrollCardIntoView(idx);
            }
            this.taskView._rebuildWindowGrid(false);
        } else if (this.flyout.isOpen) {
            this.flyout.refresh();
        }
    }

    _closeActiveWorkspace() {
        if (!this._shouldHandleHotkey()) return;
        const wm = global.workspace_manager;
        if (wm.n_workspaces <= 1) return;
        const activeIdx = wm.get_active_workspace_index();
        const ws = wm.get_workspace_by_index(activeIdx);
        if (!ws) return;

        const wins = ws.list_windows().filter(w => Main.isInteresting(w) && !w.is_on_all_workspaces());
        const doClose = () => {
            if (!closeWorkspace(activeIdx)) return;
            const newIdx = wm.get_active_workspace_index();
            this.showOsdIfEnabled(newIdx);
            if (this.flyout.isOpen) this.flyout.refresh();
        };

        if (this.confirmCloseNonEmpty && wins.length > 0) {
            this.flyout.close(true);
            this.taskView.close(true);
            const dlg = new ModalDialog.ConfirmDialog(tr('confirmClose', workspaceDisplayName(activeIdx)), doClose);
            dlg.open();
        } else {
            doClose();
        }
    }

    _horizontal() {
        return this.orientation === St.Side.TOP || this.orientation === St.Side.BOTTOM;
    }

    _applyMetrics() {
        const ph = this._panelHeight || 48;
        const scale = ph / 48;
        const tile = Math.max(24, Math.round(40 * scale));
        const iconW = this.iconSizeMode === 'fixed'
            ? Math.min(tile - 4, this.iconSize || 24)
            : Math.max(14, Math.round(24 * scale));

        if (this._horizontal()) {
            this._wrap.set_size(tile + 4, -1);
        } else {
            this._wrap.set_size(-1, tile + 4);
        }
        this.button.setMetrics(tile, tile, iconW, this.isDark);
        this.updateButtonState();
    }

    updateButtonState() {
        if (!this.button) return;
        const active = (this.taskView && this.taskView.isOpen) || (this.flyout && this.flyout.isOpen && this.flyout.sticky);
        this.button.setState({
            hover: this.buttonHovered,
            pressed: this._pressed,
            active,
            dark: this.isDark,
        });
    }

    _connectButtonEvents() {
        const b = this.button.actor;
        b.connect('enter-event', () => {
            this.buttonHovered = true;
            this.updateButtonState();
            if (global.settings.get_boolean('panel-edit-mode')) return Clutter.EVENT_PROPAGATE;
            this.flyout.cancelClose();

            if (this.taskView.isOpen) return Clutter.EVENT_PROPAGATE;
            this._hoverTimer.set(this.hoverDelay || 400, () => {
                if (!this.buttonHovered || this.taskView.isOpen) return;
                const n = global.workspace_manager.n_workspaces;
                if (this.hoverFlyout && (n >= 2 || this.flyoutOnSingle)) {
                    this._hideTooltip();
                    this.flyout.open(false);
                } else if (this.showTooltip) {
                    this._showTooltip(tr('taskView'));
                }
            });
            return Clutter.EVENT_PROPAGATE;
        });

        b.connect('leave-event', () => {
            this.buttonHovered = false;
            this._pressed = false;
            this._downBtn = 0;
            this._hoverTimer.clear();
            this._hideTooltip();
            this.updateButtonState();
            this.flyout.scheduleClose();
            return Clutter.EVENT_PROPAGATE;
        });

        b.connect('button-press-event', (a, ev) => {
            if (global.settings.get_boolean('panel-edit-mode')) return Clutter.EVENT_PROPAGATE;
            const btn = ev.get_button();
            if (btn === 3) return Clutter.EVENT_PROPAGATE; // allow Cinnamon applet context menu
            this._downBtn = btn;
            if (btn === 1) {
                this._pressed = true;
                this.updateButtonState();
            }
            return Clutter.EVENT_STOP;
        });

        b.connect('button-release-event', (a, ev) => {
            if (global.settings.get_boolean('panel-edit-mode')) return Clutter.EVENT_PROPAGATE;
            const btn = ev.get_button();
            if (btn === 3) return Clutter.EVENT_PROPAGATE;

            const wasDown = this._downBtn === btn;
            this._downBtn = 0;
            this._pressed = false;
            this.updateButtonState();

            if (!wasDown) return Clutter.EVENT_STOP;
            const [ex, ey] = ev.get_coords();
            const [ax, ay] = b.get_transformed_position();
            const [aw, ah] = b.get_transformed_size();
            if (ex < ax || ex > ax + aw || ey < ay || ey > ay + ah) return Clutter.EVENT_STOP;

            this._hoverTimer.clear();
            this._hideTooltip();

            if (btn === 1) this._runAction(this.clickAction);
            else if (btn === 2) this._runAction(this.middleClickAction);
            return Clutter.EVENT_STOP;
        });

        b.connect('scroll-event', (a, ev) => {
            if (!this.scrollSwitch || global.settings.get_boolean('panel-edit-mode')) {
                return Clutter.EVENT_PROPAGATE;
            }
            const dir = ev.get_scroll_direction();
            let step = 0;
            if (dir === Clutter.ScrollDirection.UP || dir === Clutter.ScrollDirection.LEFT) step = -1;
            else if (dir === Clutter.ScrollDirection.DOWN || dir === Clutter.ScrollDirection.RIGHT) step = 1;
            if (step === 0) return Clutter.EVENT_PROPAGATE;

            const wm = global.workspace_manager;
            const n = wm.n_workspaces;
            if (n <= 1) return Clutter.EVENT_STOP;
            const next = (wm.get_active_workspace_index() + step + n) % n;
            const ws = wm.get_workspace_by_index(next);
            if (ws) {
                Main.wm.moveToWorkspace(ws);
                this.showOsdIfEnabled(next);
            }
            return Clutter.EVENT_STOP;
        });
    }

    _runAction(action) {
        switch (action) {
            case 'win11-taskview':
                this.taskView.toggle();
                break;
            case 'cinnamon-expo':
                this.flyout.close(true);
                if (!Main.expo.animationInProgress) Main.expo.toggle();
                break;
            case 'toggle-flyout':
                if (this.flyout.isOpen) this.flyout.close(false);
                else this.flyout.open(true);
                break;
            case 'new-workspace': {
                const idx = global.workspace_manager.n_workspaces;
                Main._addWorkspace();
                if (this.switchOnAdd) {
                    const ws = global.workspace_manager.get_workspace_by_index(idx);
                    if (ws) {
                        Main.wm.moveToWorkspace(ws);
                        this.showOsdIfEnabled(idx);
                    }
                }
                if (this.flyout.isOpen) this.flyout.refresh();
                break;
            }
            case 'next-workspace': {
                const wm = global.workspace_manager;
                const n = wm.n_workspaces;
                if (n > 1) {
                    const next = (wm.get_active_workspace_index() + 1) % n;
                    const ws = wm.get_workspace_by_index(next);
                    if (ws) {
                        Main.wm.moveToWorkspace(ws);
                        this.showOsdIfEnabled(next);
                    }
                }
                break;
            }
            default:
                break;
        }
    }

    _connectWorkspaceSignals() {
        const wm = global.workspace_manager;
        const onWsChange = () => {
            if (this.flyout.isOpen) this.flyout.refresh();
        };
        const onActiveWsChange = () => {
            if (this.flyout.isOpen) this.flyout.updateActiveState();
        };
        this._signals.push([wm, wm.connect('active-workspace-changed', onActiveWsChange)]);
        this._signals.push([wm, wm.connect('workspace-added', onWsChange)]);
        this._signals.push([wm, wm.connect('workspace-removed', onWsChange)]);
        this._signals.push([Main.wmSettings, Main.wmSettings.connect('changed::workspace-names', onWsChange)]);
        const themeCtx = St.ThemeContext.get_for_stage(global.stage);
        this._signals.push([themeCtx, themeCtx.connect('changed', () => {
            this._refreshDarkTheme();
            this._applyMetrics();
        })]);
    }

    _showTooltip(text) {
        this._hideTooltip();
        if (!text) return;
        const cls = this.isDark ? 'win11-ws-tip win11-ws-dark' : 'win11-ws-tip win11-ws-light';
        const tip = new St.BoxLayout({ style_class: cls, reactive: false });
        tip.add_child(new St.Label({ text, y_align: Clutter.ActorAlign.CENTER }));
        Main.layoutManager.addChrome(tip, { affectsInputRegion: false });
        tip.opacity = 0;
        const [w, h] = preferredSize(tip);
        const [x, y] = placeNear(this, this.buttonActor, w, h, 13);
        tip.set_position(x, y);
        tip.ease({
            opacity: 255,
            duration: this.animFlyout ? 100 : 0,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        if (!this.animFlyout) tip.opacity = 255;
        this._tipActor = tip;
    }

    _hideTooltip() {
        const tip = this._tipActor;
        this._tipActor = null;
        if (!tip) return;
        tip.remove_all_transitions();
        Main.layoutManager.removeChrome(tip);
        tip.destroy();
    }

    showOsdIfEnabled(wsIndex) {
        if (!this.showOsdPill) return;
        this._hideOsd(true);
        const cls = this.isDark ? 'win11-ws-osd win11-ws-dark' : 'win11-ws-osd win11-ws-light';
        const pill = new St.BoxLayout({ style_class: cls, reactive: false });
        pill.add_child(new St.Label({
            style_class: 'win11-ws-osd-label',
            text: workspaceDisplayName(wsIndex),
            y_align: Clutter.ActorAlign.CENTER,
        }));
        Main.layoutManager.addChrome(pill, { affectsInputRegion: false });
        pill.opacity = 0;

        const mon = Main.layoutManager.findMonitorForActor(this.actor) || Main.layoutManager.primaryMonitor;
        const [w, h] = preferredSize(pill);
        const bar = this.panel ? this.panel.actor : this.actor;
        const [, py] = bar.get_transformed_position();
        const [, ph] = bar.get_transformed_size();
        const x = Math.round(mon.x + (mon.width - w) / 2);
        const y = this.orientation === St.Side.TOP
            ? Math.round(py + ph + 16)
            : Math.round(mon.y + mon.height - (this.orientation === St.Side.BOTTOM ? ph : 0) - h - 16);

        pill.set_position(x, y);
        pill.ease({
            opacity: 255,
            duration: this.animFlyout ? 120 : 0,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        if (!this.animFlyout) pill.opacity = 255;
        this._osdActor = pill;
        this._osdTimer.set(1100, () => this._hideOsd(false));
    }

    _hideOsd(immediate) {
        this._osdTimer.clear();
        const actor = this._osdActor;
        this._osdActor = null;
        if (!actor) return;
        actor.remove_all_transitions();
        const done = () => {
            Main.layoutManager.removeChrome(actor);
            actor.destroy();
        };
        if (immediate || !this.animFlyout) {
            done();
        } else {
            actor.ease({
                opacity: 0,
                duration: 160,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: done,
            });
        }
    }

    on_panel_height_changed() {
        this._applyMetrics();
    }

    on_orientation_changed(orientation) {
        this.orientation = orientation;
        this._applyMetrics();
    }

    on_applet_removed_from_panel() {
        this.destroyed = true;
        this._hoverTimer.clear();
        this._hideTooltip();
        this._hideOsd(true);
        this._signals.forEach(([obj, id]) => {
            try { obj.disconnect(id); } catch (e) { /* already gone */ }
        });
        this._signals = [];
        if (this.shortcuts) this.shortcuts.destroy();
        if (this.taskView) this.taskView.destroy();
        if (this.flyout) this.flyout.destroy();
        if (this.contextMenu) this.contextMenu.destroy();
        if (this.wallpaper) this.wallpaper.destroy();
        if (this.button) this.button.destroy();
        if (this.settings) this.settings.finalize();
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new Win11WorkspaceSwitcher(metadata, orientation, panelHeight, instanceId);
}
