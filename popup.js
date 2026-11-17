// Shared positioning and panel-edge reveal helpers for floating popups.
const { Clutter, St } = imports.gi;
const Main = imports.ui.main;

const MARGIN = 8;

function monitorRect(actor) {
    const mon = (actor && Main.layoutManager.findMonitorForActor(actor)) || Main.layoutManager.primaryMonitor;
    return { x: mon.x, y: mon.y, width: mon.width, height: mon.height };
}

function preferredSize(actor) {
    const [, w] = actor.get_preferred_width(-1);
    const [, h] = actor.get_preferred_height(w);
    return [Math.ceil(w), Math.ceil(h)];
}

// Places a popup of size (w, h) centered on `anchor`, on the side facing away from the panel.
function placeNear(applet, anchor, w, h, gap) {
    const mon = monitorRect(anchor);
    const [ax, ay] = anchor.get_transformed_position();
    const [aw, ah] = anchor.get_transformed_size();
    const bar = applet.panel ? applet.panel.actor : applet.actor;
    const [px, py] = bar.get_transformed_position();
    const [pw, ph] = bar.get_transformed_size();
    let x;
    let y;

    switch (applet.orientation) {
        case St.Side.TOP:
            x = ax + aw / 2 - w / 2;
            y = py + ph + gap;
            break;
        case St.Side.LEFT:
            x = px + pw + gap;
            y = ay + ah / 2 - h / 2;
            break;
        case St.Side.RIGHT:
            x = px - gap - w;
            y = ay + ah / 2 - h / 2;
            break;
        default: // BOTTOM
            x = ax + aw / 2 - w / 2;
            y = py - gap - h;
    }

    x = Math.max(mon.x + MARGIN, Math.min(x, mon.x + mon.width - w - MARGIN));
    y = Math.max(mon.y + MARGIN, Math.min(y, mon.y + mon.height - h - MARGIN));
    return [Math.round(x), Math.round(y)];
}

// Slides `actor` out from under the panel, clipped cleanly at the panel edge.
function revealFromPanel(applet, actor, duration, mode, onDone) {
    const finish = () => {
        if (!actor || actor.is_finalized && actor.is_finalized()) return;
        actor.remove_clip();
        actor.translation_x = 0;
        actor.translation_y = 0;
        actor.opacity = 255;
        Main.layoutManager._chrome.updateRegions();
        if (onDone) onDone();
    };
    if (!applet.animFlyout || duration <= 0 || !applet.panel) {
        finish();
        return;
    }
    const [px, py] = applet.panel.actor.get_transformed_position();
    const [pw, ph] = applet.panel.actor.get_transformed_size();
    const [x, y] = actor.get_position();
    const [w, h] = preferredSize(actor);
    let prop;
    let from;
    let clip;

    switch (applet.orientation) {
        case St.Side.TOP:
            prop = 'translation_y';
            from = (py + ph) - (y + h);
            clip = () => {
                const c = Math.max(0, (py + ph) - (y + actor.translation_y));
                actor.set_clip(0, c, w, Math.max(0, h - c));
            };
            break;
        case St.Side.LEFT:
            prop = 'translation_x';
            from = (px + pw) - (x + w);
            clip = () => {
                const c = Math.max(0, (px + pw) - (x + actor.translation_x));
                actor.set_clip(c, 0, Math.max(0, w - c), h);
            };
            break;
        case St.Side.RIGHT:
            prop = 'translation_x';
            from = px - x;
            clip = () => {
                const v = Math.max(0, px - (x + actor.translation_x));
                actor.set_clip(0, 0, v, h);
            };
            break;
        default:
            prop = 'translation_y';
            from = py - y;
            clip = () => {
                const v = Math.max(0, py - (y + actor.translation_y));
                actor.set_clip(0, 0, w, v);
            };
    }

    actor.remove_all_transitions();
    actor[prop] = from;
    actor.opacity = 255;
    clip();
    const target = { duration, mode, onUpdate: clip, onComplete: finish };
    target[prop] = 0;
    actor.ease(target);
}

module.exports = { MARGIN, monitorRect, preferredSize, placeNear, revealFromPanel };
