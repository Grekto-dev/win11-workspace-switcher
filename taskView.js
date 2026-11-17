// Full Windows 11 Task View overlay:
//   - Blurred cached wallpaper backdrop + subtle scrim
//   - Upper window grid of the active/previewed workspace with live Clutter.Clone previews,
//     2px accent hover border, close (×), snap/move/sticky context menu, and drag-to-desktop
//   - Bottom Virtual Desktops dock (width = monitor - 16, height = 176, 8px above taskbar)
//     sliding up from under the panel (~250ms EASE_OUT_QUINT)
const { Clutter, St, Pango } = imports.gi;
const Main = imports.ui.main;
const { tr } = require('./i18n');
const {
    workspaceDisplayName,
    reorderWorkspace,
    closeWorkspace,
    moveWindowToNewDesktop,
    getWorkspaceWindows,
    snapWindow,
    appIconForWindow,
} = require('./util');
const { DesktopStrip } = require('./desktopStrip');

const DOCK_MARGIN = 8;
const DOCK_H = 176;
const WIN_HEADER_H = 30;
const WIN_CARD_PAD = 16;

// Computes balanced grid rectangles for `windows` inside `area = {x, y, w, h}` preserving aspect ratios.
function layoutWindowGrid(windows, area) {
    const n = windows.length;
    if (n === 0) return [];

    // Choose row count that maximizes card area while fitting cleanly.
    let bestRows = 1;
    let bestScore = -1;
    for (let rows = 1; rows <= Math.min(4, n); rows++) {
        const cols = Math.ceil(n / rows);
        const cellW = (area.w - (cols + 1) * WIN_CARD_PAD) / cols;
        const cellH = (area.h - (rows + 1) * WIN_CARD_PAD) / rows;
        if (cellW < 120 || cellH < 90) continue;
        const sizeScore = Math.min(cellW, cellH * 1.6);
        if (sizeScore > bestScore) {
            bestScore = sizeScore;
            bestRows = rows;
        }
    }

    const rows = bestRows;
    const cols = Math.ceil(n / rows);
    const cellW = Math.floor((area.w - (cols + 1) * WIN_CARD_PAD) / cols);
    const cellH = Math.floor((area.h - (rows + 1) * WIN_CARD_PAD) / rows);
    const maxPreviewW = Math.max(100, cellW - 8);
    const maxPreviewH = Math.max(60, cellH - WIN_HEADER_H - 8);

    const rowData = [];
    let idx = 0;
    let totalRowsH = 0;

    for (let r = 0; r < rows; r++) {
        const countInRow = Math.min(cols, n - idx);
        const items = [];
        let rowWidth = 0;
        let rowMaxH = 0;

        for (let c = 0; c < countInRow; c++) {
            const mw = windows[idx++];
            const fr = mw.get_frame_rect();
            const aspect = fr.width > 0 && fr.height > 0 ? fr.width / fr.height : 1.6;
            let pw = maxPreviewW;
            let ph = Math.round(pw / aspect);
            if (ph > maxPreviewH) {
                ph = maxPreviewH;
                pw = Math.round(ph * aspect);
            }
            pw = Math.max(140, Math.min(maxPreviewW, pw));
            ph = Math.max(80, Math.min(maxPreviewH, ph));
            const cardW = pw + 4;
            const cardH = ph + WIN_HEADER_H + 4;
            items.push({ mw, fr, cardW, cardH, pw, ph });
            rowWidth += cardW;
            rowMaxH = Math.max(rowMaxH, cardH);
        }
        rowWidth += (countInRow - 1) * WIN_CARD_PAD;
        rowData.push({ items, rowWidth, rowMaxH });
        totalRowsH += rowMaxH;
    }

    totalRowsH += (rows - 1) * WIN_CARD_PAD;
    const rects = [];
    let curY = area.y + Math.max(0, Math.floor((area.h - totalRowsH) / 2));

    for (let r = 0; r < rowData.length; r++) {
        const { items, rowWidth, rowMaxH } = rowData[r];
        let curX = area.x + Math.max(0, Math.floor((area.w - rowWidth) / 2));
        for (let c = 0; c < items.length; c++) {
            const it = items[c];
            const cardY = curY + Math.floor((rowMaxH - it.cardH) / 2);
            rects.push({
                mw: it.mw,
                origRect: it.fr,
                x: curX,
                y: cardY,
                w: it.cardW,
                h: it.cardH,
                pw: it.pw,
                ph: it.ph,
            });
            curX += it.cardW + WIN_CARD_PAD;
        }
        curY += rowMaxH + WIN_CARD_PAD;
    }
    return rects;
}

class Win11TaskView {
    constructor(applet) {
        this.applet = applet;
        this.actor = null;
        this._monitor = null;
        this._backdrop = null;
        this._scrim = null;
        this._gridLayer = null;
        this._dragLayer = null;
        this._emptyLabel = null;
        this._dock = null;
        this._strip = null;
        this._grabbed = false;
        this._previewWsIndex = 0;
        this._focusedWinIdx = -1;
        this._winCards = [];
        this._dragState = null;
        this._dragCaptureId = 0;
        this._wsSigIds = [];
    }

    get isOpen() {
        return this.actor !== null;
    }

    get isDraggingWindow() {
        return !!(this._dragState && this._dragState.active);
    }

    toggle() {
        if (this.isOpen) this.close(false);
        else this.open();
    }

    open() {
        if (this.isOpen) return;
        this.applet.flyout.close(true);

        const mon = Main.layoutManager.findMonitorForActor(this.applet.actor) || Main.layoutManager.primaryMonitor;
        this._monitor = mon;
        this._previewWsIndex = global.workspace_manager.get_active_workspace_index();

        const dark = this.applet.isDark;
        const root = new St.Widget({
            style_class: (dark ? 'win11-ws-taskview win11-ws-dark' : 'win11-ws-taskview win11-ws-light')
                + (this.applet.liteMode ? ' win11-ws-lite' : ''),
            reactive: true,
            can_focus: true,
            x: mon.x,
            y: mon.y,
            width: mon.width,
            height: mon.height,
        });

        // 1. Blurred wallpaper backdrop
        if (this.applet.taskviewBlur) {
            this._backdrop = new Clutter.Actor({
                x: 0,
                y: 0,
                width: mon.width,
                height: mon.height,
                content_gravity: Clutter.ContentGravity.RESIZE_FILL,
                minification_filter: Clutter.ScalingFilter.LINEAR,
                magnification_filter: Clutter.ScalingFilter.LINEAR,
            });
            this._backdrop.set_content(this.applet.wallpaper.getBlurredBackdropImage());
            root.add_child(this._backdrop);
        }

        // 2. Scrim (also acts as click-empty-area-to-close)
        this._scrim = new St.Widget({
            style_class: 'win11-ws-tv-scrim',
            reactive: true,
            x: 0,
            y: 0,
            width: mon.width,
            height: mon.height,
        });
        this._scrim.connect('button-release-event', (a, ev) => {
            if (ev.get_button() === 1 && !this._dragState && !this.applet.contextMenu.isOpen) {
                this.close(false);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        root.add_child(this._scrim);

        // 3. Upper window grid layer
        this._gridLayer = new Clutter.Actor({
            x: 0,
            y: 0,
            width: mon.width,
            height: mon.height,
        });
        root.add_child(this._gridLayer);

        this._emptyLabel = new St.Label({
            style_class: 'win11-ws-tv-empty',
            text: tr('noWindows'),
            visible: false,
        });
        root.add_child(this._emptyLabel);

        // 4. Bottom Virtual Desktops dock
        const panelReserve = this._panelReserve(mon);
        const dockW = mon.width - DOCK_MARGIN * 2;
        const dockX = DOCK_MARGIN;
        const dockY = mon.height - panelReserve.bottom - DOCK_MARGIN - DOCK_H;

        this._dock = new St.BoxLayout({
            style_class: 'win11-ws-tv-dock',
            vertical: true,
            reactive: true,
            x: dockX,
            y: dockY,
            width: dockW,
            height: DOCK_H,
        });

        this._strip = new DesktopStrip(this.applet, mon, {
            inTaskView: true,
            onActivateCard: (idx, ws) => {
                Main.wm.moveToWorkspace(ws);
                this.applet.showOsdIfEnabled(idx);
                this.close(false);
            },
            onHoverCard: (idx) => {
                if (this._dragState || (this._strip && this._strip.isDragging)) return;
                if (idx !== this._previewWsIndex) {
                    this._previewWsIndex = idx;
                    this._focusedWinIdx = -1;
                    this._strip.setPreviewIndex(idx);
                    this._rebuildWindowGrid(false);
                }
            },
            onReorderDesktop: (fromIdx, toIdx) => {
                if (this._previewWsIndex === fromIdx) {
                    this._previewWsIndex = toIdx;
                } else if (fromIdx < toIdx && this._previewWsIndex > fromIdx && this._previewWsIndex <= toIdx) {
                    this._previewWsIndex--;
                } else if (fromIdx > toIdx && this._previewWsIndex >= toIdx && this._previewWsIndex < fromIdx) {
                    this._previewWsIndex++;
                }
                if (this._strip) this._strip.setPreviewIndex(this._previewWsIndex);
            },
            onAddDesktop: () => {
                const newIdx = global.workspace_manager.n_workspaces;
                Main._addWorkspace();
                if (this.applet.switchOnAdd) {
                    const ws = global.workspace_manager.get_workspace_by_index(newIdx);
                    if (ws) Main.wm.moveToWorkspace(ws);
                    this._previewWsIndex = newIdx;
                }
                this._strip.setPreviewIndex(this._previewWsIndex);
                this._strip.refresh();
                this._strip.scrollCardIntoView(this._previewWsIndex);
                this._rebuildWindowGrid(false);
            },
            onBeforeModal: () => this.close(true),
        });
        this._strip.setPreviewIndex(this._previewWsIndex);
        this._strip.actor.set_width(dockW - 16);
        this._dock.add_child(this._strip.actor);
        root.add_child(this._dock);

        // 5. Top drag layer above dock so dragged window previews float cleanly over desktop cards
        this._dragLayer = new Clutter.Actor({
            x: 0,
            y: 0,
            width: mon.width,
            height: mon.height,
        });
        root.add_child(this._dragLayer);

        // Keyboard handling
        root.connect('key-press-event', (a, ev) => this._onKeyPress(ev));

        Main.layoutManager.addChrome(root);
        if (!Main.pushModal(root)) {
            Main.layoutManager.removeChrome(root);
            this._strip.destroy();
            root.destroy();
            return;
        }
        this._grabbed = true;
        this.actor = root;
        this.applet.updateButtonState();

        // Listen for workspace additions/removals while Task View is open
        const wm = global.workspace_manager;
        this._wsSigIds.push(wm.connect('workspace-added', () => this._onWorkspacesChanged(true)));
        this._wsSigIds.push(wm.connect('workspace-removed', () => this._onWorkspacesChanged(true)));
        this._wsSigIds.push(wm.connect('active-workspace-changed', () => this._onWorkspacesChanged(false)));

        // Build grid & run open animations
        this._rebuildWindowGrid(this.applet.animTaskView);
        this._animateOpen(mon, dockY, panelReserve);
        root.grab_key_focus();
    }

    _panelReserve(mon) {
        const res = { top: 0, bottom: 0, left: 0, right: 0 };
        const bar = this.applet.panel ? this.applet.panel.actor : null;
        if (!bar) return res;
        const [px, py] = bar.get_transformed_position();
        const [pw, ph] = bar.get_transformed_size();
        if (this.applet.orientation === St.Side.BOTTOM) res.bottom = Math.max(0, (mon.y + mon.height) - py);
        else if (this.applet.orientation === St.Side.TOP) res.top = Math.max(0, (py + ph) - mon.y);
        else if (this.applet.orientation === St.Side.LEFT) res.left = Math.max(0, (px + pw) - mon.x);
        else if (this.applet.orientation === St.Side.RIGHT) res.right = Math.max(0, (mon.x + mon.width) - px);
        return res;
    }

    _animateOpen(mon, dockY, panelReserve) {
        if (!this.applet.animTaskView) return;

        if (this._backdrop) {
            this._backdrop.opacity = 0;
            this._backdrop.ease({ opacity: 255, duration: 220, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
        }
        this._scrim.opacity = 0;
        this._scrim.ease({ opacity: 255, duration: 220, mode: Clutter.AnimationMode.EASE_OUT_QUAD });

        // Slide dock up from under the panel, clipped at the panel edge
        const dock = this._dock;
        const clipBottom = mon.height - panelReserve.bottom;
        const startOffset = clipBottom - dockY;
        dock.translation_y = startOffset;
        const updateClip = () => {
            if (!this._dock || dock !== this._dock) return;
            const curY = dockY + dock.translation_y;
            const visibleH = Math.max(0, Math.min(DOCK_H, clipBottom - curY));
            dock.set_clip(0, 0, dock.width, visibleH);
        };
        updateClip();
        dock.ease({
            translation_y: 0,
            duration: 250,
            mode: Clutter.AnimationMode.EASE_OUT_QUINT,
            onUpdate: updateClip,
            onComplete: () => {
                if (this._dock === dock) dock.remove_clip();
            },
        });
    }

    _onWorkspacesChanged(structureChanged = true) {
        if (!this.isOpen) return;
        const n = global.workspace_manager.n_workspaces;
        if (this._previewWsIndex >= n) this._previewWsIndex = Math.max(0, n - 1);
        if (this._strip) {
            if (structureChanged) {
                this._strip.setPreviewIndex(this._previewWsIndex);
                this._strip.refresh();
            } else {
                this._strip.updateActiveState();
            }
        }
        if (structureChanged) this._rebuildWindowGrid(false);
    }

    _gridArea() {
        const mon = this._monitor;
        const res = this._panelReserve(mon);
        const top = res.top + 28;
        const bottom = mon.height - res.bottom - DOCK_MARGIN - DOCK_H - 20;
        const left = res.left + 48;
        const right = mon.width - res.right - 48;
        return { x: left, y: top, w: Math.max(240, right - left), h: Math.max(160, bottom - top) };
    }

    _rebuildWindowGrid(animateFromDesktop) {
        if (!this._gridLayer) return;
        this._gridLayer.destroy_all_children();
        this._winCards = [];

        const wm = global.workspace_manager;
        const ws = wm.get_workspace_by_index(this._previewWsIndex);
        const mon = this._monitor;
        const wins = getWorkspaceWindows(ws, mon.index, this.applet.showAllMonitors);
        // Most recently focused first in Task View grid (reverse of bottom-to-top stacking)
        wins.reverse();

        const area = this._gridArea();
        if (wins.length === 0) {
            this._emptyLabel.visible = true;
            const [, ew] = this._emptyLabel.get_preferred_width(-1);
            const [, eh] = this._emptyLabel.get_preferred_height(ew);
            this._emptyLabel.set_position(
                Math.round(area.x + (area.w - ew) / 2),
                Math.round(area.y + (area.h - eh) / 2)
            );
            return;
        }
        this._emptyLabel.visible = false;

        const layouts = layoutWindowGrid(wins, area);
        const accent = this.applet.accentColor;

        layouts.forEach((item, idx) => {
            const card = this._buildWindowCard(item, accent, idx);
            this._gridLayer.add_child(card);
            this._winCards.push({ actor: card, mw: item.mw, rect: item });

            if (animateFromDesktop && !item.mw.minimized) {
                const startX = item.origRect.x - mon.x;
                const startY = item.origRect.y - mon.y;
                const sx = Math.max(0.2, item.origRect.width / Math.max(1, item.w));
                const sy = Math.max(0.2, item.origRect.height / Math.max(1, item.h));
                card.set_position(startX, startY);
                card.set_scale(sx, sy);
                card.opacity = 180;
                card.ease({
                    x: item.x,
                    y: item.y,
                    scale_x: 1,
                    scale_y: 1,
                    opacity: 255,
                    duration: 240,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
            } else if (animateFromDesktop) {
                card.opacity = 0;
                card.set_scale(0.92, 0.92);
                card.set_pivot_point(0.5, 0.5);
                card.ease({
                    opacity: 255,
                    scale_x: 1,
                    scale_y: 1,
                    duration: 220,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
            }
        });
        this._applyWindowFocus();
    }

    _applyWindowFocus() {
        const accent = this.applet.accentColor;
        if (this._focusedWinIdx >= this._winCards.length) this._focusedWinIdx = this._winCards.length - 1;
        for (let i = 0; i < this._winCards.length; i++) {
            const { actor } = this._winCards[i];
            if (i === this._focusedWinIdx) actor.set_style(`border-color: ${accent};`);
            else if (!actor.hover) actor.set_style(null);
        }
    }

    _buildWindowCard(item, accent, cardIdx) {
        const { mw, x, y, w, h, pw, ph } = item;
        const card = new St.BoxLayout({
            style_class: 'win11-ws-wincard',
            vertical: true,
            reactive: true,
            track_hover: true,
            x,
            y,
            width: w,
            height: h,
        });

        // Header: 16px icon + title + close (×) button
        const header = new St.BoxLayout({
            style_class: 'win11-ws-wincard-header',
            x_expand: true,
        });
        header.set_height(WIN_HEADER_H);

        const icon = appIconForWindow(mw, 16);
        const iconBin = new St.Bin({ y_align: St.Align.MIDDLE });
        iconBin.set_size(16, 16);
        iconBin.set_child(icon);
        header.add_child(iconBin);

        const title = new St.Label({
            style_class: 'win11-ws-wincard-title',
            text: mw.get_title() || '',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        title.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        header.add_child(title);

        const closeBtn = new St.Button({
            style_class: 'win11-ws-card-close',
            reactive: true,
            can_focus: false,
            visible: false,
        });
        closeBtn.set_size(22, 22);
        closeBtn.set_child(new St.Label({
            text: '✕',
            style_class: 'win11-ws-card-close-glyph',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        closeBtn.connect('clicked', () => {
            mw.delete(global.get_current_time());
            this._rebuildWindowGrid(false);
            if (this._strip) this._strip.refresh();
        });
        header.add_child(closeBtn);
        card.add_child(header);

        // Preview body: live Clutter.Clone or lightweight fallback
        const previewWrap = new St.Widget({
            style_class: 'win11-ws-wincard-preview',
            layout_manager: new Clutter.BinLayout(),
            clip_to_allocation: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        previewWrap.set_size(pw, ph);

        const priv = this.applet.taskviewLiveClones ? mw.get_compositor_private() : null;
        if (priv && priv.width > 0 && priv.height > 0) {
            previewWrap.add_child(new Clutter.Clone({
                source: priv,
                width: pw,
                height: ph,
            }));
        } else {
            const fallback = new St.Bin({
                style_class: 'win11-ws-wincard-fallback',
                x_align: St.Align.MIDDLE,
                y_align: St.Align.MIDDLE,
            });
            fallback.set_size(pw, ph);
            fallback.set_child(appIconForWindow(mw, 48));
            previewWrap.add_child(fallback);
        }
        card.add_child(previewWrap);

        // Hover border in accent color + close button visibility
        card.connect('enter-event', () => {
            if (this._dragState && this._dragState.active) return Clutter.EVENT_PROPAGATE;
            closeBtn.visible = true;
            card.set_style(`border-color: ${accent};`);
            return Clutter.EVENT_PROPAGATE;
        });
        card.connect('leave-event', () => {
            if (this._dragState && this._dragState.card === card && this._dragState.active) return Clutter.EVENT_PROPAGATE;
            closeBtn.visible = false;
            if (this._focusedWinIdx !== cardIdx) card.set_style(null);
            return Clutter.EVENT_PROPAGATE;
        });

        // Click / Drag / Middle-click / Right-click
        let pressX = 0;
        let pressY = 0;
        let pressBtn = 0;
        card.connect('button-press-event', (a, ev) => {
            if (this.applet.contextMenu.isOpen) return Clutter.EVENT_PROPAGATE;
            pressBtn = ev.get_button();
            [pressX, pressY] = ev.get_coords();
            if (pressBtn === 1) {
                this._armWindowDrag(card, mw, closeBtn, pressX, pressY);
            }
            return Clutter.EVENT_STOP;
        });

        card.connect('button-release-event', (a, ev) => {
            const btn = ev.get_button();
            if (btn === 1 && this._dragState) {
                const dragged = this._dragState.active;
                this._finishWindowDrag(ev);
                if (dragged) return Clutter.EVENT_STOP;
            }
            if (btn !== pressBtn) return Clutter.EVENT_STOP;
            pressBtn = 0;
            const [rx, ry] = ev.get_coords();
            if (Math.hypot(rx - pressX, ry - pressY) > 8) return Clutter.EVENT_STOP;

            if (btn === 1) {
                const ws = global.workspace_manager.get_workspace_by_index(this._previewWsIndex);
                this.close(false);
                if (ws && ws !== global.workspace_manager.get_active_workspace()) {
                    Main.wm.moveToWorkspace(ws);
                }
                Main.activateWindow(mw);
            } else if (btn === 2) {
                mw.delete(global.get_current_time());
                this._rebuildWindowGrid(false);
                if (this._strip) this._strip.refresh();
            } else if (btn === 3) {
                this._openWindowContextMenu(mw, rx, ry);
            }
            return Clutter.EVENT_STOP;
        });

        return card;
    }

    _armWindowDrag(card, mw, closeBtn, startX, startY) {
        this._cancelWindowDrag();
        const [cx, cy] = card.get_position();
        const [cw, ch] = card.get_size();
        const dragScale = Math.max(0.28, Math.min(0.60, 200 / Math.max(1, cw)));
        this._dragState = {
            card,
            mw,
            closeBtn,
            startX,
            startY,
            origX: cx,
            origY: cy,
            cw,
            ch,
            dragScale,
            active: false,
            target: null,
        };
        this._dragCaptureId = global.stage.connect('captured-event', (stage, ev) => {
            if (!this._dragState) return Clutter.EVENT_PROPAGATE;
            const type = ev.type();
            if (type === Clutter.EventType.MOTION) {
                const [mx, my] = ev.get_coords();
                const dx = mx - this._dragState.startX;
                const dy = my - this._dragState.startY;
                if (!this._dragState.active && Math.hypot(dx, dy) > 10) {
                    this._startWindowDrag(mx, my);
                }
                if (this._dragState.active) {
                    this._updateWindowDrag(mx, my);
                }
                return Clutter.EVENT_PROPAGATE;
            }
            if (type === Clutter.EventType.KEY_PRESS && ev.get_key_symbol() === Clutter.KEY_Escape) {
                if (this._dragState.active) {
                    this._springBackDraggedCard(this._dragState);
                    this._cancelWindowDrag();
                    return Clutter.EVENT_STOP;
                }
                this._cancelWindowDrag();
                return Clutter.EVENT_PROPAGATE;
            }
            if (type === Clutter.EventType.BUTTON_RELEASE && ev.get_button() === 1) {
                if (this._dragState.active) {
                    this._finishWindowDrag(ev);
                    return Clutter.EVENT_STOP;
                }
                this._cancelWindowDrag();
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _startWindowDrag(mx, my) {
        const st = this._dragState;
        if (!st) return;
        st.active = true;
        if (st.closeBtn) st.closeBtn.visible = false;
        st.card.set_style(null);
        st.card.remove_all_transitions();

        // Reparent into _dragLayer (above dock) so dragged preview floats over desktop cards
        if (this._dragLayer && st.card.get_parent() === this._gridLayer) {
            this._gridLayer.remove_child(st.card);
            this._dragLayer.add_child(st.card);
        }
        st.card.set_pivot_point(0.5, 0.5);
        if (this.applet.animTaskView) {
            st.card.ease({
                scale_x: st.dragScale,
                scale_y: st.dragScale,
                opacity: 225,
                duration: 90,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            st.card.set_scale(st.dragScale, st.dragScale);
            st.card.opacity = 225;
        }
        this._positionDraggedCard(st, mx, my);
    }

    _positionDraggedCard(st, mx, my) {
        const mon = this._monitor;
        const targetX = Math.round(mx - mon.x - st.cw / 2);
        const targetY = Math.round(my - mon.y - st.ch / 2);
        st.card.set_translation(targetX - st.origX, targetY - st.origY, 0);
    }

    _isValidDropTarget(st, hit) {
        if (!hit) return false;
        if (hit.kind === 'add') return true;
        if (hit.kind === 'desktop') {
            return st.mw.is_on_all_workspaces() || hit.card.workspace !== st.mw.get_workspace();
        }
        return false;
    }

    _updateWindowDrag(mx, my) {
        const st = this._dragState;
        if (!st || !st.active) return;
        this._positionDraggedCard(st, mx, my);
        if (!this._strip) return;

        this._strip.autoScrollAt(mx);
        this._strip.clearDropHighlights();
        const hit = this._strip.hitTestDropTarget(mx, my);
        st.target = this._isValidDropTarget(st, hit) ? hit : null;
        if (st.target && st.target.kind === 'desktop') st.target.card.setDropHighlight(true);
        else if (st.target && st.target.kind === 'add') st.target.actor.add_style_class_name('win11-ws-card-drop');
    }

    _springBackDraggedCard(st) {
        if (!st || !st.active || !st.card) return;
        const card = st.card;
        const grid = this._gridLayer;
        const reparentBack = () => {
            if (!grid || !this.isOpen || card.get_parent() !== this._dragLayer) return;
            this._dragLayer.remove_child(card);
            grid.add_child(card);
        };
        card.remove_all_transitions();
        if (this.applet.animTaskView) {
            card.ease({
                translation_x: 0,
                translation_y: 0,
                scale_x: 1,
                scale_y: 1,
                opacity: 255,
                duration: 160,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onComplete: reparentBack,
            });
        } else {
            card.set_translation(0, 0, 0);
            card.set_scale(1, 1);
            card.opacity = 255;
            reparentBack();
        }
    }

    _finishWindowDrag(ev) {
        const st = this._dragState;
        this._cancelWindowDrag();
        if (!st || !st.active) return;

        const [mx, my] = ev.get_coords();
        const hit = this._strip ? this._strip.hitTestDropTarget(mx, my) : null;
        if (this._strip) this._strip.clearDropHighlights();

        if (this._isValidDropTarget(st, hit)) {
            if (hit.kind === 'desktop') {
                if (st.mw.is_on_all_workspaces()) st.mw.unstick();
                st.mw.change_workspace(hit.card.workspace);
                st.card.destroy();
                this._strip.refresh();
                this._rebuildWindowGrid(false);
                return;
            }
            if (hit.kind === 'add') {
                const newIdx = moveWindowToNewDesktop(st.mw);
                st.card.destroy();
                this._strip.refresh();
                if (newIdx >= 0) this._strip.scrollCardIntoView(newIdx);
                this._rebuildWindowGrid(false);
                return;
            }
        }

        // Dropped outside any valid desktop card: spring back into grid
        this._springBackDraggedCard(st);
    }

    _cancelWindowDrag() {
        if (this._dragCaptureId) {
            global.stage.disconnect(this._dragCaptureId);
            this._dragCaptureId = 0;
        }
        if (this._strip) this._strip.clearDropHighlights();
        this._dragState = null;
    }

    _openWindowContextMenu(mw, x, y) {
        const wm = global.workspace_manager;
        const curWs = mw.get_workspace();
        const moveSub = [];
        for (let i = 0; i < wm.n_workspaces; i++) {
            const ws = wm.get_workspace_by_index(i);
            moveSub.push({
                kind: 'item',
                label: workspaceDisplayName(i),
                disabled: !mw.is_on_all_workspaces() && ws === curWs,
                activate: () => {
                    if (mw.is_on_all_workspaces()) mw.unstick();
                    mw.change_workspace(ws);
                    this._strip.refresh();
                    this._rebuildWindowGrid(false);
                },
            });
        }
        moveSub.push({ kind: 'separator' });
        moveSub.push({
            kind: 'item',
            label: tr('newDesktop'),
            activate: () => {
                const newIdx = moveWindowToNewDesktop(mw);
                this._strip.refresh();
                if (newIdx >= 0) this._strip.scrollCardIntoView(newIdx);
                this._rebuildWindowGrid(false);
            },
        });

        const sticky = mw.is_on_all_workspaces();
        const items = [
            {
                kind: 'item',
                label: tr('snapLeft'),
                activate: () => {
                    this.close(false);
                    Main.activateWindow(mw);
                    snapWindow(mw, 'left');
                },
            },
            {
                kind: 'item',
                label: tr('snapRight'),
                activate: () => {
                    this.close(false);
                    Main.activateWindow(mw);
                    snapWindow(mw, 'right');
                },
            },
            { kind: 'separator' },
            {
                kind: 'item',
                label: tr('moveTo'),
                submenu: moveSub,
            },
            {
                kind: 'item',
                label: sticky ? tr('onlyThisDesktop') : tr('showAllDesktops'),
                checked: sticky,
                activate: () => {
                    if (sticky) mw.unstick();
                    else mw.stick();
                    this._strip.refresh();
                    this._rebuildWindowGrid(false);
                },
            },
            { kind: 'separator' },
            {
                kind: 'item',
                label: tr('close'),
                shortcut: tr('deleteKey'),
                activate: () => {
                    mw.delete(global.get_current_time());
                    this._rebuildWindowGrid(false);
                    this._strip.refresh();
                },
            },
        ];

        this.applet.contextMenu.openAt(x, y, items, {
            dark: this.applet.isDark,
            parentIsModal: true,
        });
    }

    _onKeyPress(event) {
        if (this._strip && this._strip.isBusy) return Clutter.EVENT_PROPAGATE;
        if (this.applet.contextMenu.isOpen) return Clutter.EVENT_PROPAGATE;

        const sym = event.get_key_symbol();
        const state = event.get_state();
        const shift = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;
        const altShift = (state & (Clutter.ModifierType.MOD1_MASK | Clutter.ModifierType.SHIFT_MASK))
            === (Clutter.ModifierType.MOD1_MASK | Clutter.ModifierType.SHIFT_MASK);

        if (sym === Clutter.KEY_Escape) {
            if (this._dragState && this._dragState.active) {
                this._springBackDraggedCard(this._dragState);
                this._cancelWindowDrag();
                return Clutter.EVENT_STOP;
            }
            this.close(false);
            return Clutter.EVENT_STOP;
        }

        const n = global.workspace_manager.n_workspaces;
        if (sym === Clutter.KEY_Tab || sym === Clutter.KEY_ISO_Left_Tab) {
            if (this._winCards.length > 0) {
                this._focusedWinIdx = this._focusedWinIdx >= 0 ? -1 : 0;
                this._applyWindowFocus();
            }
            return Clutter.EVENT_STOP;
        }

        // Window grid focus mode
        if (this._focusedWinIdx >= 0 && this._winCards.length > 0) {
            const focused = this._winCards[this._focusedWinIdx];
            if (sym === Clutter.KEY_Left || sym === Clutter.KEY_Up) {
                this._focusedWinIdx = (this._focusedWinIdx - 1 + this._winCards.length) % this._winCards.length;
                this._applyWindowFocus();
                return Clutter.EVENT_STOP;
            }
            if (sym === Clutter.KEY_Right) {
                this._focusedWinIdx = (this._focusedWinIdx + 1) % this._winCards.length;
                this._applyWindowFocus();
                return Clutter.EVENT_STOP;
            }
            if (sym === Clutter.KEY_Down) {
                if (this._focusedWinIdx < this._winCards.length - 1) {
                    this._focusedWinIdx++;
                } else {
                    this._focusedWinIdx = -1;
                }
                this._applyWindowFocus();
                return Clutter.EVENT_STOP;
            }
            if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) {
                const ws = global.workspace_manager.get_workspace_by_index(this._previewWsIndex);
                this.close(false);
                if (ws && ws !== global.workspace_manager.get_active_workspace()) {
                    Main.wm.moveToWorkspace(ws);
                }
                Main.activateWindow(focused.mw);
                return Clutter.EVENT_STOP;
            }
            if (sym === Clutter.KEY_Delete) {
                focused.mw.delete(global.get_current_time());
                this._rebuildWindowGrid(false);
                if (this._strip) this._strip.refresh();
                return Clutter.EVENT_STOP;
            }
            if (sym === Clutter.KEY_Menu || (shift && sym === Clutter.KEY_F10)) {
                const [cx, cy] = focused.actor.get_transformed_position();
                const [cw, ch] = focused.actor.get_transformed_size();
                this._openWindowContextMenu(focused.mw, cx + cw / 2, cy + ch / 2);
                return Clutter.EVENT_STOP;
            }
        }

        // Desktop strip keyboard navigation & reorder
        if (sym === Clutter.KEY_Up && this._winCards.length > 0) {
            this._focusedWinIdx = 0;
            this._applyWindowFocus();
            return Clutter.EVENT_STOP;
        }
        if (altShift && sym === Clutter.KEY_Left) {
            if (this._previewWsIndex > 0) {
                reorderWorkspace(this._previewWsIndex, this._previewWsIndex - 1);
                this._previewWsIndex--;
                this._strip.setPreviewIndex(this._previewWsIndex);
                this._strip.refresh();
                this._strip.scrollCardIntoView(this._previewWsIndex);
            }
            return Clutter.EVENT_STOP;
        }
        if (altShift && sym === Clutter.KEY_Right) {
            if (this._previewWsIndex < n - 1) {
                reorderWorkspace(this._previewWsIndex, this._previewWsIndex + 1);
                this._previewWsIndex++;
                this._strip.setPreviewIndex(this._previewWsIndex);
                this._strip.refresh();
                this._strip.scrollCardIntoView(this._previewWsIndex);
            }
            return Clutter.EVENT_STOP;
        }
        if (sym === Clutter.KEY_Left) {
            this._previewWsIndex = (this._previewWsIndex - 1 + n) % n;
            this._focusedWinIdx = -1;
            this._strip.setPreviewIndex(this._previewWsIndex);
            this._strip.scrollCardIntoView(this._previewWsIndex);
            this._rebuildWindowGrid(false);
            return Clutter.EVENT_STOP;
        }
        if (sym === Clutter.KEY_Right) {
            this._previewWsIndex = (this._previewWsIndex + 1) % n;
            this._focusedWinIdx = -1;
            this._strip.setPreviewIndex(this._previewWsIndex);
            this._strip.scrollCardIntoView(this._previewWsIndex);
            this._rebuildWindowGrid(false);
            return Clutter.EVENT_STOP;
        }
        if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) {
            const ws = global.workspace_manager.get_workspace_by_index(this._previewWsIndex);
            if (ws) Main.wm.moveToWorkspace(ws);
            this.close(false);
            return Clutter.EVENT_STOP;
        }
        if (sym === Clutter.KEY_F2 && this._strip && this._strip.cards[this._previewWsIndex]) {
            this._strip.cards[this._previewWsIndex].startRename();
            return Clutter.EVENT_STOP;
        }
        if (sym === Clutter.KEY_Delete && n > 1) {
            closeWorkspace(this._previewWsIndex);
            this._onWorkspacesChanged(true);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    close(immediate = false) {
        this._cancelWindowDrag();
        if (this.applet.contextMenu.isOpen) {
            this.applet.contextMenu.close(true);
        }
        const wm = global.workspace_manager;
        this._wsSigIds.forEach(id => wm.disconnect(id));
        this._wsSigIds = [];

        const actor = this.actor;
        const strip = this._strip;
        const dock = this._dock;
        this.actor = null;
        this._strip = null;
        this._dock = null;
        this._backdrop = null;
        this._scrim = null;
        this._gridLayer = null;
        this._dragLayer = null;
        this._winCards = [];
        this._focusedWinIdx = -1;
        this.applet.updateButtonState();

        if (!actor) return;

        if (dock) dock.remove_all_transitions();

        if (this._grabbed) {
            this._grabbed = false;
            try { Main.popModal(actor); } catch (e) { /* already popped */ }
        }

        const finish = () => {
            if (strip) strip.destroy();
            Main.layoutManager.removeChrome(actor);
            actor.destroy();
        };

        actor.remove_all_transitions();
        if (immediate || !this.applet.animTaskView) {
            finish();
        } else {
            actor.ease({
                opacity: 0,
                duration: 150,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: finish,
            });
        }
    }

    destroy() {
        this.close(true);
    }
}

module.exports = { Win11TaskView };
