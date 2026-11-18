// Reusable Windows 11 Virtual Desktops strip shared by both the Hover Flyout and the Task View Dock.
// Measured geometry (1440x900 @ 100%):
//   Card outer: 240 x 164 px, radius 6 px, spacing 4 px
//   Thumbnail:  220 x 132 px, radius 4 px
//   Active indicator pill at bottom: 32 x 3 px, accent color (#4cc2ff)
const { Clutter, GLib, St, Pango, Meta } = imports.gi;
const Main = imports.ui.main;
const ModalDialog = imports.ui.modalDialog;
const { tr } = require('./i18n');
const {
    workspaceDisplayName,
    reorderWorkspace,
    closeWorkspace,
    getWorkspaceWindows,
} = require('./util');

const CARD_W = 240;
const CARD_H = 164;
const THUMB_W = 220;
const THUMB_H = 132;
const CARD_GAP = 4;

class DesktopCard {
    constructor(strip, index, workspace, isActive) {
        this.strip = strip;
        this.applet = strip.applet;
        this.index = index;
        this.workspace = workspace;
        this.isActive = isActive;
        this._editing = false;
        this._entry = null;
        this._dropHighlighted = false;

        this.actor = new St.BoxLayout({
            style_class: 'win11-ws-card',
            vertical: true,
            reactive: true,
            track_hover: true,
        });
        this.actor.set_size(CARD_W, CARD_H);
        if (isActive) this.actor.add_style_class_name('win11-ws-card-active');
        this._isPreview = false;

        // Header row: workspace title + close (×) button on hover
        this.header = new St.BoxLayout({
            style_class: 'win11-ws-card-header',
            x_expand: true,
        });
        this.header.set_height(20);

        this.nameBox = new St.Bin({
            x_expand: true,
            x_align: St.Align.START,
            y_align: St.Align.MIDDLE,
            reactive: strip.inTaskView,
        });
        this.label = new St.Label({
            style_class: 'win11-ws-card-title',
            text: workspaceDisplayName(index),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        if (!this.applet.showWorkspaceNames) this.label.hide();
        this.nameBox.set_child(this.label);

        this.closeBtn = new St.Button({
            style_class: 'win11-ws-card-close',
            reactive: true,
            can_focus: false,
            visible: false,
        });
        this.closeBtn.set_size(20, 20);
        this.closeBtn.set_child(new St.Label({
            text: '✕',
            style_class: 'win11-ws-card-close-glyph',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this.closeBtn.connect('clicked', () => {
            this._requestClose();
        });

        this.header.add_child(this.nameBox);
        this.header.add_child(this.closeBtn);
        this.actor.add_child(this.header);

        // Thumbnail frame: wallpaper image + scaled window previews
        this.thumbFrame = new St.Widget({
            style_class: 'win11-ws-thumb',
            layout_manager: new Clutter.BinLayout(),
            clip_to_allocation: true,
        });
        this.thumbFrame.set_size(THUMB_W, THUMB_H);

        this.bgActor = new Clutter.Actor({
            width: THUMB_W,
            height: THUMB_H,
            content_gravity: Clutter.ContentGravity.RESIZE_FILL,
        });
        this.bgActor.set_content(this.applet.wallpaper.getThumbnailImage(THUMB_W, THUMB_H));
        this.thumbFrame.add_child(this.bgActor);

        this.winLayer = new Clutter.Actor({ width: THUMB_W, height: THUMB_H });
        this.thumbFrame.add_child(this.winLayer);
        this._populateMiniWindows();

        this.actor.add_child(this.thumbFrame);

        // Bottom active pill indicator (32x3 px centered)
        this.pillWrap = new St.Bin({
            style_class: 'win11-ws-pill-wrap',
            x_expand: true,
            x_align: St.Align.MIDDLE,
            y_align: St.Align.END,
        });
        this.pill = new St.Widget({ style_class: 'win11-ws-pill' });
        this.pill.set_size(32, 3);
        this.pill.set_style(`background-color: ${this.applet.accentColor};`);
        this.pill.visible = isActive;
        this.pillWrap.set_child(this.pill);
        this.actor.add_child(this.pillWrap);

        // Interactions
        this.actor.connect('enter-event', () => {
            if (this.strip.isDragging || (this.applet.taskView && this.applet.taskView.isDraggingWindow)) {
                return Clutter.EVENT_PROPAGATE;
            }
            if (global.workspace_manager.n_workspaces > 1) {
                this.closeBtn.visible = true;
            }
            if (this.strip.onHoverCard) this.strip.onHoverCard(this.index, this.workspace);
            return Clutter.EVENT_PROPAGATE;
        });
        this.actor.connect('leave-event', () => {
            this.closeBtn.visible = false;
            return Clutter.EVENT_PROPAGATE;
        });

        // Clicking the label directly inside Task View starts inline rename (Windows 11 behavior).
        if (strip.inTaskView) {
            this.nameBox.connect('button-press-event', (a, ev) => {
                if (ev.get_button() === 1 && !this._editing && !this.strip.isDragging) {
                    this.startRename();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
        }

        let pressX = 0;
        let pressY = 0;
        let pressedBtn = 0;
        this.actor.connect('button-press-event', (a, ev) => {
            if (this._editing || this.applet.contextMenu.isOpen) return Clutter.EVENT_PROPAGATE;
            const src = ev.get_source();
            if (src === this.closeBtn || this.closeBtn.contains(src)) return Clutter.EVENT_PROPAGATE;
            if (this.strip.inTaskView && (src === this.nameBox || this.nameBox.contains(src))) return Clutter.EVENT_PROPAGATE;
            pressedBtn = ev.get_button();
            [pressX, pressY] = ev.get_coords();
            if (pressedBtn === 1 && global.workspace_manager.n_workspaces > 1) {
                this.strip._armDesktopDrag(this, pressX, pressY);
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this.actor.connect('button-release-event', (a, ev) => {
            if (this._editing || this.strip.isDragging) return Clutter.EVENT_PROPAGATE;
            const btn = ev.get_button();
            if (btn !== pressedBtn) return Clutter.EVENT_PROPAGATE;
            pressedBtn = 0;
            const [rx, ry] = ev.get_coords();
            if (Math.hypot(rx - pressX, ry - pressY) > 8) return Clutter.EVENT_PROPAGATE;

            if (btn === 1) {
                if (this.strip.onActivateCard) this.strip.onActivateCard(this.index, this.workspace);
                return Clutter.EVENT_STOP;
            }
            if (btn === 2) {
                this._requestClose();
                return Clutter.EVENT_STOP;
            }
            if (btn === 3) {
                this._openContextMenu(rx, ry);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _populateMiniWindows() {
        const mode = this.applet.effectivePreviewMode;
        if (mode === 'wallpaper') return;

        const mon = this.strip.monitor;
        const monW = Math.max(1, mon.width);
        const monH = Math.max(1, mon.height);
        const sx = THUMB_W / monW;
        const sy = THUMB_H / monH;

        const wins = getWorkspaceWindows(this.workspace, mon.index, this.applet.showAllMonitors);
        for (let i = 0; i < wins.length; i++) {
            const mw = wins[i];
            if (mw.minimized) continue;
            const rect = mw.get_frame_rect();
            const wx = Math.round((rect.x - mon.x) * sx);
            const wy = Math.round((rect.y - mon.y) * sy);
            const ww = Math.max(6, Math.round(rect.width * sx));
            const wh = Math.max(5, Math.round(rect.height * sy));

            if (mode === 'live') {
                const priv = mw.get_compositor_private();
                if (priv && priv.width > 0 && priv.height > 0) {
                    const clone = new Clutter.Clone({
                        source: priv,
                        x: wx,
                        y: wy,
                        width: ww,
                        height: wh,
                    });
                    this.winLayer.add_child(clone);
                    continue;
                }
            }

            // Ultra-lightweight schematic rectangle fallback
            const box = new St.Widget({
                style_class: 'win11-ws-mini-win',
                x: wx,
                y: wy,
                width: ww,
                height: wh,
            });
            this.winLayer.add_child(box);
        }
    }

    setActive(on) {
        this.isActive = on;
        this.pill.visible = on;
        if (on) this.actor.add_style_class_name('win11-ws-card-active');
        else this.actor.remove_style_class_name('win11-ws-card-active');
    }

    setPreview(on) {
        if (this._isPreview === on) return;
        this._isPreview = on;
        if (on) this.actor.add_style_class_name('win11-ws-card-preview');
        else this.actor.remove_style_class_name('win11-ws-card-preview');
    }

    setDropHighlight(on) {
        if (this._dropHighlighted === on) return;
        this._dropHighlighted = on;
        if (on) this.actor.add_style_class_name('win11-ws-card-drop');
        else this.actor.remove_style_class_name('win11-ws-card-drop');
    }

    _requestClose() {
        const wm = global.workspace_manager;
        if (wm.n_workspaces <= 1) return;
        const wins = this.workspace.list_windows().filter(w => Main.isInteresting(w) && !w.is_on_all_workspaces());
        const idx = this.index;
        const doClose = () => {
            closeWorkspace(idx);
            this.strip.refresh();
        };

        if (this.applet.confirmCloseNonEmpty && wins.length > 0) {
            // Close flyout/TaskView cleanly before opening modal dialog
            if (this.strip.onBeforeModal) this.strip.onBeforeModal();
            const msg = tr('confirmClose', workspaceDisplayName(idx));
            const dlg = new ModalDialog.ConfirmDialog(msg, doClose);
            dlg.open();
        } else {
            doClose();
        }
    }

    startRename() {
        if (this._editing) return;
        this._editing = true;
        this.strip.setEditing(true);

        const current = workspaceDisplayName(this.index);
        const entry = new St.Entry({
            style_class: 'win11-ws-rename-entry',
            text: current,
            can_focus: true,
        });
        entry.set_width(THUMB_W - 26);
        entry.set_style(`border-bottom: 2px solid ${this.applet.accentColor};`);
        this._entry = entry;

        this.nameBox.set_child(entry);
        entry.grab_key_focus();
        const ct = entry.clutter_text;
        ct.set_selection(0, -1);

        let finished = false;
        const finish = (commit) => {
            if (finished) return;
            finished = true;
            const raw = entry.get_text().trim();
            if (commit && raw.length > 0) {
                const defEn = tr('desktopN', this.index + 1);
                if (raw === defEn) {
                    Main.setWorkspaceName(this.index, Main._makeDefaultWorkspaceName
                        ? Main._makeDefaultWorkspaceName(this.index) : '');
                } else {
                    Main.setWorkspaceName(this.index, raw);
                }
            }
            this._editing = false;
            this._entry = null;
            this.label.set_text(workspaceDisplayName(this.index));
            this.nameBox.set_child(this.label);
            this.strip.setEditing(false);
        };

        ct.connect('activate', () => finish(true));
        ct.connect('key-press-event', (a, ev) => {
            const sym = ev.get_key_symbol();
            if (sym === Clutter.KEY_Escape) {
                finish(false);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        entry.connect('key-focus-out', () => finish(true));
    }

    _openContextMenu(x, y) {
        const n = global.workspace_manager.n_workspaces;
        const idx = this.index;
        const items = [
            {
                kind: 'item',
                label: tr('rename'),
                activate: () => this.startRename(),
            },
            {
                kind: 'item',
                label: tr('moveLeft'),
                shortcut: tr('shortcutLeft'),
                disabled: idx <= 0,
                activate: () => {
                    if (reorderWorkspace(idx, idx - 1)) {
                        if (this.strip.onReorderDesktop) this.strip.onReorderDesktop(idx, idx - 1);
                    }
                    this.strip.refresh();
                },
            },
            {
                kind: 'item',
                label: tr('moveRight'),
                shortcut: tr('shortcutRight'),
                disabled: idx >= n - 1,
                activate: () => {
                    if (reorderWorkspace(idx, idx + 1)) {
                        if (this.strip.onReorderDesktop) this.strip.onReorderDesktop(idx, idx + 1);
                    }
                    this.strip.refresh();
                },
            },
            { kind: 'separator' },
            {
                kind: 'item',
                label: tr('close'),
                shortcut: tr('deleteKey'),
                disabled: n <= 1,
                activate: () => this._requestClose(),
            },
        ];

        this.strip.setMenuOpen(true);
        this.applet.contextMenu.openAt(x, y, items, {
            dark: this.applet.isDark,
            parentIsModal: this.strip.inTaskView,
            onClose: () => this.strip.setMenuOpen(false),
        });
    }
}

class DesktopStrip {
    constructor(applet, monitor, {
        inTaskView = false,
        onActivateCard = null,
        onHoverCard = null,
        onAddDesktop = null,
        onReorderDesktop = null,
        onBeforeModal = null,
    } = {}) {
        this.applet = applet;
        this.monitor = monitor;
        this.inTaskView = inTaskView;
        this.onActivateCard = onActivateCard;
        this.onHoverCard = onHoverCard;
        this.onAddDesktop = onAddDesktop;
        this.onReorderDesktop = onReorderDesktop;
        this.onBeforeModal = onBeforeModal;

        this.cards = [];
        this.addCard = null;
        this._editing = false;
        this._menuOpen = false;
        this._previewIdx = -1;
        this._addDropLit = false;
        this._dragState = null;
        this._dragCaptureId = 0;
        this._destroyed = false;
        this._scrollRestoreId = 0;

        this.scrollView = new St.ScrollView({
            style_class: 'win11-ws-scroll',
            hscrollbar_policy: St.PolicyType.AUTOMATIC,
            vscrollbar_policy: St.PolicyType.NEVER,
            enable_mouse_scrolling: false,
            x_expand: true,
        });

        this.row = new St.BoxLayout({
            style_class: 'win11-ws-strip-row',
            vertical: false,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this.row.set_style(`spacing: ${CARD_GAP}px;`);
        this.scrollView.add_actor(this.row);

        // Smooth horizontal mouse-wheel scrolling when cards overflow
        this.scrollView.connect('scroll-event', (a, ev) => {
            const dir = ev.get_scroll_direction();
            const hbar = this.scrollView.get_hscroll_bar();
            if (!hbar) return Clutter.EVENT_PROPAGATE;
            const adj = hbar.get_adjustment();
            if (adj.upper <= adj.page_size) return Clutter.EVENT_PROPAGATE;
            let delta = 0;
            if (dir === Clutter.ScrollDirection.UP || dir === Clutter.ScrollDirection.LEFT) delta = -120;
            else if (dir === Clutter.ScrollDirection.DOWN || dir === Clutter.ScrollDirection.RIGHT) delta = 120;
            else if (dir === Clutter.ScrollDirection.SMOOTH) {
                const [dx, dy] = ev.get_scroll_delta();
                delta = (Math.abs(dx) > Math.abs(dy) ? dx : dy) * 80;
            }
            if (delta !== 0) {
                adj.set_value(Math.max(adj.lower, Math.min(adj.upper - adj.page_size, adj.value + delta)));
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this.refresh();
    }

    get actor() {
        return this.scrollView;
    }

    get isDragging() {
        return !!(this._dragState && this._dragState.active);
    }

    get isBusy() {
        return this._editing || this._menuOpen || this.isDragging;
    }

    setEditing(on) {
        this._editing = on;
    }

    setMenuOpen(on) {
        this._menuOpen = on;
    }

    setPreviewIndex(idx) {
        this._previewIdx = idx;
        for (let i = 0; i < this.cards.length; i++) {
            this.cards[i].setPreview(i === idx);
        }
    }

    updateActiveState() {
        const activeIdx = global.workspace_manager.get_active_workspace_index();
        for (let i = 0; i < this.cards.length; i++) {
            this.cards[i].setActive(i === activeIdx);
        }
    }

    _getHAdjustment() {
        const hbar = this.scrollView.get_hscroll_bar();
        return hbar ? hbar.get_adjustment() : null;
    }

    scrollCardIntoView(idx) {
        const card = idx >= 0 && idx < this.cards.length ? this.cards[idx] : null;
        if (!card) return;
        const adj = this._getHAdjustment();
        if (!adj || adj.upper <= adj.page_size) return;
        const step = CARD_W + CARD_GAP;
        const left = idx * step;
        const right = left + CARD_W;
        if (left < adj.value) adj.set_value(Math.max(adj.lower, left));
        else if (right > adj.value + adj.page_size) {
            adj.set_value(Math.min(adj.upper - adj.page_size, right - adj.page_size));
        }
    }

    autoScrollAt(sx, viewBounds = null) {
        const adj = this._getHAdjustment();
        if (!adj || adj.upper <= adj.page_size) return false;
        let vx;
        let vw;
        if (viewBounds) {
            vx = viewBounds.vx;
            vw = viewBounds.vw;
        } else {
            [vx] = this.scrollView.get_transformed_position();
            [vw] = this.scrollView.get_transformed_size();
        }
        const edge = 48;
        let step = 0;
        if (sx < vx + edge) step = -Math.max(6, Math.round((vx + edge - sx) * 0.45));
        else if (sx > vx + vw - edge) step = Math.max(6, Math.round((sx - (vx + vw - edge)) * 0.45));
        if (step !== 0) {
            const next = Math.max(adj.lower, Math.min(adj.upper - adj.page_size, adj.value + step));
            if (next !== adj.value) {
                adj.set_value(next);
                return true;
            }
        }
        return false;
    }

    _armDesktopDrag(card, startX, startY) {
        this._cancelDesktopDrag(false);
        const hAdj = this._getHAdjustment();
        const [vx] = this.scrollView.get_transformed_position();
        const [vw] = this.scrollView.get_transformed_size();
        this._dragState = {
            card,
            fromIdx: card.index,
            targetIdx: card.index,
            startX,
            startY,
            startScroll: hAdj ? hAdj.value : 0,
            viewBounds: { vx, vw },
            lastMx: startX,
            redrawLaterId: 0,
            active: false,
        };
        this._dragCaptureId = global.stage.connect('captured-event', (stage, ev) => {
            if (!this._dragState) return Clutter.EVENT_PROPAGATE;
            const type = ev.type();
            if (type === Clutter.EventType.MOTION) {
                const [mx, my] = ev.get_coords();
                const dx = mx - this._dragState.startX;
                const dy = my - this._dragState.startY;
                if (!this._dragState.active) {
                    if (Math.hypot(dx, dy) > 10 && Math.abs(dx) >= Math.abs(dy) * 0.6) {
                        this._startDesktopDrag();
                    } else {
                        return Clutter.EVENT_PROPAGATE;
                    }
                }
                this._dragState.lastMx = mx;
                if (!this._dragState.redrawLaterId) {
                    this._dragState.redrawLaterId = Meta.later_add(Meta.LaterType.BEFORE_REDRAW, () => {
                        if (this._dragState) {
                            this._dragState.redrawLaterId = 0;
                            this._updateDesktopDrag(this._dragState.lastMx);
                        }
                        return GLib.SOURCE_REMOVE;
                    });
                }
                return Clutter.EVENT_PROPAGATE;
            }
            if (type === Clutter.EventType.KEY_PRESS && ev.get_key_symbol() === Clutter.KEY_Escape) {
                if (this._dragState.active) {
                    this._cancelDesktopDrag(true);
                    return Clutter.EVENT_STOP;
                }
                this._cancelDesktopDrag(false);
                return Clutter.EVENT_PROPAGATE;
            }
            if (type === Clutter.EventType.BUTTON_RELEASE && ev.get_button() === 1) {
                if (this._dragState.active) {
                    this._updateDesktopDrag(ev.get_coords()[0]);
                    this._finishDesktopDrag();
                    return Clutter.EVENT_STOP;
                }
                this._cancelDesktopDrag(false);
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _startDesktopDrag() {
        const st = this._dragState;
        if (!st) return;
        st.active = true;
        st.card.closeBtn.visible = false;
        st.card.actor.add_style_class_name('win11-ws-card-dragging');
    }

    _updateDesktopDrag(mx) {
        const st = this._dragState;
        if (!st || !st.active) return;
        this.autoScrollAt(mx, st.viewBounds);
        const hAdj = this._getHAdjustment();
        const curScroll = hAdj ? hAdj.value : 0;
        const step = CARD_W + CARD_GAP;
        const n = this.cards.length;
        const dx = (mx - st.startX) + (curScroll - st.startScroll);
        const minTx = -st.fromIdx * step;
        const maxTx = (n - 1 - st.fromIdx) * step;
        const tx = Math.max(minTx, Math.min(maxTx, dx));
        st.card.actor.translation_x = tx;

        const targetIdx = Math.max(0, Math.min(n - 1, st.fromIdx + Math.round(tx / step)));
        if (targetIdx !== st.targetIdx) {
            st.targetIdx = targetIdx;
            const anim = this.applet.animFlyout;
            for (let i = 0; i < n; i++) {
                if (i === st.fromIdx) continue;
                let shift = 0;
                if (targetIdx > st.fromIdx && i > st.fromIdx && i <= targetIdx) shift = -step;
                else if (targetIdx < st.fromIdx && i >= targetIdx && i < st.fromIdx) shift = step;
                const a = this.cards[i].actor;
                a.remove_all_transitions();
                if (anim) {
                    a.ease({
                        translation_x: shift,
                        duration: 120,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });
                } else {
                    a.translation_x = shift;
                }
            }
        }
    }

    _finishDesktopDrag() {
        const st = this._dragState;
        const fromIdx = st ? st.fromIdx : -1;
        const targetIdx = st ? st.targetIdx : -1;
        this._cancelDesktopDrag(false);
        if (fromIdx >= 0 && targetIdx >= 0 && targetIdx !== fromIdx) {
            if (reorderWorkspace(fromIdx, targetIdx)) {
                if (this.onReorderDesktop) this.onReorderDesktop(fromIdx, targetIdx);
            }
            this.refresh();
        } else if (st && st.card && st.card.actor) {
            this._resetCardTransforms(this.applet.animFlyout);
        }
    }

    _resetCardTransforms(animate) {
        for (let i = 0; i < this.cards.length; i++) {
            const a = this.cards[i].actor;
            a.remove_all_transitions();
            a.remove_style_class_name('win11-ws-card-dragging');
            if (animate && a.translation_x !== 0) {
                a.ease({ translation_x: 0, duration: 130, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
            } else {
                a.translation_x = 0;
            }
        }
    }

    _cancelDesktopDrag(animateReset) {
        if (this._dragCaptureId) {
            global.stage.disconnect(this._dragCaptureId);
            this._dragCaptureId = 0;
        }
        const st = this._dragState;
        this._dragState = null;
        if (st && st.redrawLaterId) {
            Meta.later_remove(st.redrawLaterId);
            st.redrawLaterId = 0;
        }
        if (st && st.active && st.card && st.card.actor) {
            st.card.actor.remove_style_class_name('win11-ws-card-dragging');
            if (animateReset) this._resetCardTransforms(this.applet.animFlyout);
        }
    }

    refresh() {
        this._cancelDesktopDrag(false);
        const hAdj = this._getHAdjustment();
        const savedScroll = hAdj ? hAdj.value : 0;

        this.row.destroy_all_children();
        this.cards = [];
        this.addCard = null;
        this._addDropLit = false;

        const wm = global.workspace_manager;
        const n = wm.n_workspaces;
        const activeIdx = wm.get_active_workspace_index();

        for (let i = 0; i < n; i++) {
            const ws = wm.get_workspace_by_index(i);
            const card = new DesktopCard(this, i, ws, i === activeIdx);
            if (this.inTaskView && i === this._previewIdx) card.setPreview(true);
            this.cards.push(card);
            this.row.add_child(card.actor);
        }

        if (this.applet.showAddButton) {
            this.addCard = this._buildAddCard();
            this.row.add_child(this.addCard);
        }

        if (savedScroll > 0) {
            if (this._scrollRestoreId) {
                GLib.source_remove(this._scrollRestoreId);
                this._scrollRestoreId = 0;
            }
            this._scrollRestoreId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._scrollRestoreId = 0;
                if (this._destroyed) return GLib.SOURCE_REMOVE;
                const adj = this._getHAdjustment();
                if (adj && adj.upper > adj.page_size) {
                    adj.set_value(Math.max(adj.lower, Math.min(adj.upper - adj.page_size, savedScroll)));
                }
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _buildAddCard() {
        const card = new St.BoxLayout({
            style_class: 'win11-ws-card win11-ws-add-card',
            vertical: true,
            reactive: true,
            track_hover: true,
        });
        card.set_size(CARD_W, CARD_H);

        const header = new St.BoxLayout({ style_class: 'win11-ws-card-header', x_expand: true });
        header.set_height(20);
        const lbl = new St.Label({
            style_class: 'win11-ws-card-title',
            text: tr('newDesktop'),
            y_align: Clutter.ActorAlign.CENTER,
        });
        if (!this.applet.showWorkspaceNames) lbl.hide();
        header.add_child(lbl);
        card.add_child(header);

        const tile = new St.Bin({
            style_class: 'win11-ws-add-tile',
            x_align: St.Align.MIDDLE,
            y_align: St.Align.MIDDLE,
        });
        tile.set_size(THUMB_W, THUMB_H);
        tile.set_child(new St.Label({ style_class: 'win11-ws-add-plus', text: '+' }));
        card.add_child(tile);

        const spacer = new St.Widget({ x_expand: true });
        spacer.set_height(4);
        card.add_child(spacer);

        let addPressed = false;
        card.connect('button-press-event', (a, ev) => {
            if (ev.get_button() === 1) addPressed = true;
            return Clutter.EVENT_STOP;
        });

        card.connect('button-release-event', (a, ev) => {
            if (ev.get_button() !== 1 || !addPressed) return Clutter.EVENT_STOP;
            addPressed = false;
            if (this.onAddDesktop) {
                this.onAddDesktop();
            } else {
                const idx = global.workspace_manager.n_workspaces;
                Main._addWorkspace();
                if (this.applet.switchOnAdd) {
                    const ws = global.workspace_manager.get_workspace_by_index(idx);
                    if (ws) Main.wm.moveToWorkspace(ws);
                }
                this.refresh();
            }
            return Clutter.EVENT_STOP;
        });

        return card;
    }

    // Builds a cached flat list of stage-coordinate drop rectangles for fast per-frame hit-testing.
    getDropTargets() {
        const targets = [];
        for (let i = 0; i < this.cards.length; i++) {
            const c = this.cards[i];
            const [x, y] = c.actor.get_transformed_position();
            const [w, h] = c.actor.get_transformed_size();
            targets.push({ kind: 'desktop', card: c, x0: x, y0: y, x1: x + w, y1: y + h });
        }
        if (this.addCard) {
            const [x, y] = this.addCard.get_transformed_position();
            const [w, h] = this.addCard.get_transformed_size();
            targets.push({ kind: 'add', actor: this.addCard, x0: x, y0: y, x1: x + w, y1: y + h });
        }
        return targets;
    }

    setAddDropHighlight(on) {
        if (this._addDropLit === on) return;
        this._addDropLit = on;
        if (this.addCard) {
            if (on) this.addCard.add_style_class_name('win11-ws-card-drop');
            else this.addCard.remove_style_class_name('win11-ws-card-drop');
        }
    }

    // Returns { kind: 'desktop', card } | { kind: 'add', actor } | null for stage coords (sx, sy)
    hitTestDropTarget(sx, sy) {
        for (let i = 0; i < this.cards.length; i++) {
            const c = this.cards[i];
            const [x, y] = c.actor.get_transformed_position();
            const [w, h] = c.actor.get_transformed_size();
            if (sx >= x && sx <= x + w && sy >= y && sy <= y + h) {
                return { kind: 'desktop', card: c };
            }
        }
        if (this.addCard) {
            const [x, y] = this.addCard.get_transformed_position();
            const [w, h] = this.addCard.get_transformed_size();
            if (sx >= x && sx <= x + w && sy >= y && sy <= y + h) {
                return { kind: 'add', actor: this.addCard };
            }
        }
        return null;
    }

    clearDropHighlights() {
        for (let i = 0; i < this.cards.length; i++) {
            this.cards[i].setDropHighlight(false);
        }
        this.setAddDropHighlight(false);
    }

    totalContentWidth() {
        const count = global.workspace_manager.n_workspaces + (this.applet.showAddButton ? 1 : 0);
        return count * CARD_W + Math.max(0, count - 1) * CARD_GAP;
    }

    destroy() {
        this._destroyed = true;
        this._cancelDesktopDrag(false);
        if (this._scrollRestoreId) {
            GLib.source_remove(this._scrollRestoreId);
            this._scrollRestoreId = 0;
        }
        this.scrollView.destroy();
        this.cards = [];
        this.addCard = null;
    }
}

module.exports = { DesktopStrip, CARD_W, CARD_H, CARD_GAP };
