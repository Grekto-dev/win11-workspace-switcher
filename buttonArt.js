// Pure Cairo + Clutter.Canvas panel button for Windows 11 Task View.
// Zero St widgets inside the panel button: one base canvas for the 40x40 tile and one icon canvas
// for the two overlapping rounded squares with the measured press-converge animation.
const { Clutter, GLib } = imports.gi;
const Cairo = imports.cairo;

// Measured Windows 11 taskbar tile levels (white/black overlay alphas over panel).
const LEVELS_DARK = {
    idle:        [0,     0,     0,     0],
    hover:       [0.065, 0.043, 0,     0],
    pressed:     [0.045, 0,     0,     0],
    active:      [0.063, 0.067, 0.019, 0.024],
    activeHover: [0.088, 0.017, 0,    -0.10],
};

const LEVELS_LIGHT = {
    idle:        [0,     0,     0,     0],
    hover:       [0.72,  0.55,  0.35,  0.25],
    pressed:     [0.48,  0.35,  0.22,  0.15],
    active:      [0.72,  0.60,  0.40,  0.28],
    activeHover: [0.85,  0.65,  0.45,  0.32],
};

const FADE_MS = 140;
const PRESS_MS = 90;
const RELEASE_MS = 160;

const easeCubic = t => 1 - Math.pow(1 - t, 3);

function roundedRect(cr, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
    cr.closePath();
}

function makeCanvas(draw) {
    const canvas = new Clutter.Canvas();
    const actor = new Clutter.Actor();
    actor.set_content(canvas);
    canvas.connect('draw', (c, cr, w, h) => {
        try {
            cr.setOperator(Cairo.Operator.CLEAR);
            cr.paint();
            cr.setOperator(Cairo.Operator.OVER);
            draw(cr, w, h);
        } finally {
            cr.$dispose();
        }
        return true;
    });
    return { actor, canvas };
}

class ButtonArt {
    constructor(applet) {
        this.applet = applet;
        this.actor = new Clutter.Actor({ reactive: true });
        this.actor._delegate = applet;

        const base = makeCanvas((cr, w, h) => this._paintTile(cr, w, h));
        const icon = makeCanvas((cr, w, h) => this._paintIcon(cr, w, h));
        this._tileCanvas = base.canvas;
        this._iconCanvas = icon.canvas;
        this._tileActor = base.actor;
        this._iconActor = icon.actor;
        this._tileActor.visible = false;
        this.actor.add_child(this._tileActor);
        this.actor.add_child(this._iconActor);

        this._w = 40;
        this._h = 40;
        this._scale = 1;
        this._iconWidth = 24;
        this._dark = true;
        this._hover = false;
        this._pressed = false;
        this._active = false;

        this._now = [0, 0, 0, 0];
        this._from = [0, 0, 0, 0];
        this._to = [0, 0, 0, 0];
        this._lvT0 = -1;

        this._conv = 0;        // 0 = separated (idle), 1 = converged (pressed)
        this._convFrom = 0;
        this._convTo = 0;
        this._convDur = PRESS_MS;
        this._convT0 = -1;

        this._tl = null;
        this.actor.connect('destroy', () => this.destroy());
    }

    setMetrics(tileW, tileH, iconWidth, dark) {
        this._w = tileW;
        this._h = tileH;
        this._scale = tileH / 40;
        this._iconWidth = iconWidth;
        this._dark = dark;
        this.actor.set_size(tileW, tileH);
        [this._tileActor, this._iconActor].forEach(a => a.set_size(tileW, tileH));
        this._tileCanvas.set_size(tileW, tileH);
        this._iconCanvas.set_size(tileW, tileH);
        this._tileCanvas.invalidate();
        this._iconCanvas.invalidate();
    }

    setState({ hover, pressed, active, dark }) {
        let iconDirty = false;
        if (dark !== undefined && dark !== this._dark) {
            this._dark = dark;
            iconDirty = true;
        }
        if (hover !== undefined) this._hover = hover;
        if (active !== undefined) this._active = active;

        if (pressed !== undefined && pressed !== this._pressed) {
            this._pressed = pressed;
            const targetConv = pressed ? 1 : 0;
            if (!this.applet.animButton) {
                this._conv = targetConv;
                this._convT0 = -1;
                iconDirty = true;
            } else {
                this._convFrom = this._conv;
                this._convTo = targetConv;
                this._convDur = pressed ? PRESS_MS : RELEASE_MS;
                this._convT0 = GLib.get_monotonic_time() / 1000;
                this._kick();
            }
        }

        const table = this._dark ? LEVELS_DARK : LEVELS_LIGHT;
        let key = 'idle';
        if (this._pressed) key = 'pressed';
        else if (this._active && this._hover) key = 'activeHover';
        else if (this._active) key = 'active';
        else if (this._hover) key = 'hover';
        const target = table[key];

        if (!this.applet.animButton) {
            if (this._now.some((v, i) => v !== target[i])) {
                this._now = target.slice();
                this._tileActor.visible = target.some(v => v !== 0);
                if (this._tileActor.visible) this._tileCanvas.invalidate();
            }
            this._lvT0 = -1;
        } else if (this._to.some((v, i) => v !== target[i])) {
            this._from = this._now.slice();
            this._to = target.slice();
            this._tileActor.visible = true;
            this._lvT0 = GLib.get_monotonic_time() / 1000;
            this._kick();
        }

        if (iconDirty) this._iconCanvas.invalidate();
    }

    _kick() {
        if (!this._tl) {
            this._tl = new Clutter.Timeline({ duration: 1000 });
            this._tl.connect('new-frame', () => this._step());
        }
        if (!this._tl.is_playing()) {
            this._tl.rewind();
            this._tl.start();
        }
    }

    _step() {
        const now = GLib.get_monotonic_time() / 1000;
        let busy = false;
        if (this._lvT0 >= 0) {
            const t = Math.min(1, (now - this._lvT0) / FADE_MS);
            this._now = this._from.map((v, i) => v + (this._to[i] - v) * t);
            this._tileCanvas.invalidate();
            if (t >= 1) {
                this._lvT0 = -1;
                if (this._now.every(v => v === 0)) this._tileActor.visible = false;
            } else {
                busy = true;
            }
        }
        if (this._convT0 >= 0) {
            const t = easeCubic(Math.min(1, (now - this._convT0) / this._convDur));
            this._conv = this._convFrom + (this._convTo - this._convFrom) * t;
            this._iconCanvas.invalidate();
            if (t >= 1) this._convT0 = -1;
            else busy = true;
        }
        if (!busy && this._tl) this._tl.stop();
    }

    _paintTile(cr, w, h) {
        const [fill, top, side, bot] = this._now;
        if (fill === 0 && top === 0 && side === 0 && bot === 0) return;

        const r = 4.5 * this._scale;
        const baseRgb = this._dark ? [1, 1, 1] : [1, 1, 1];
        const borderRgb = this._dark ? [1, 1, 1] : [0, 0, 0];

        roundedRect(cr, 0.5, 0.5, w - 1, h - 1, r);
        cr.setSourceRGBA(baseRgb[0], baseRgb[1], baseRgb[2], Math.max(0, fill));
        cr.fill();

        const edge = (y0, y1, a) => {
            if (!a) return;
            cr.save();
            cr.rectangle(0, y0, w, y1 - y0);
            cr.clip();
            roundedRect(cr, 0.5, 0.5, w - 1, h - 1, r);
            if (a > 0) {
                cr.setSourceRGBA(this._dark ? 1 : borderRgb[0], this._dark ? 1 : borderRgb[1], this._dark ? 1 : borderRgb[2], this._dark ? a : a * 0.14);
            } else {
                cr.setSourceRGBA(0, 0, 0, -a);
            }
            cr.setLineWidth(1);
            cr.stroke();
            cr.restore();
        };

        edge(0, 4 * this._scale, top);
        edge(4 * this._scale, h - 4 * this._scale, side);
        edge(h - 4 * this._scale, h, bot);
    }

    // Draws the Windows 11 Task View icon: two overlapping rounded rectangles (18x16 each inside 24x22).
    // On press (_conv -> 1), they converge smoothly toward center and scale slightly down.
    _paintIcon(cr, w, h) {
        const s = this._iconWidth / 24;
        const sqW = 18 * s;
        const sqH = 16 * s;
        const rad = 2.2 * s;
        const sep = 3 * s * (1 - 0.78 * this._conv);
        const scale = 1 - 0.08 * this._conv;

        cr.save();
        cr.translate(w / 2, h / 2);
        cr.scale(scale, scale);

        // Back square (top-right: +sep, -sep)
        roundedRect(cr, sep - sqW / 2, -sep - sqH / 2, sqW, sqH, rad);
        if (this._dark) {
            cr.setSourceRGBA(0.93, 0.94, 0.96, 0.96);
            cr.fill();
        } else {
            cr.setSourceRGBA(1, 1, 1, 0.78);
            cr.fillPreserve();
            cr.setSourceRGBA(0, 0, 0, 0.12);
            cr.setLineWidth(Math.max(0.8, 1 * s));
            cr.stroke();
        }

        // Front square (bottom-left: -sep, +sep)
        roundedRect(cr, -sep - sqW / 2, sep - sqH / 2, sqW, sqH, rad);
        if (this._dark) {
            cr.setSourceRGBA(0.35, 0.36, 0.40, 0.84);
            cr.fillPreserve();
            cr.setSourceRGBA(1, 1, 1, 0.16);
            cr.setLineWidth(Math.max(0.8, 1 * s));
            cr.stroke();
        } else {
            cr.setSourceRGBA(0.16, 0.17, 0.19, 0.92);
            cr.fillPreserve();
            cr.setSourceRGBA(1, 1, 1, 0.12);
            cr.setLineWidth(Math.max(0.8, 1 * s));
            cr.stroke();
        }

        cr.restore();
    }

    destroy() {
        if (this._tl) {
            this._tl.stop();
            this._tl = null;
        }
        this._tileCanvas = null;
        this._iconCanvas = null;
        this._tileActor = null;
        this._iconActor = null;
    }
}

module.exports = { ButtonArt };
