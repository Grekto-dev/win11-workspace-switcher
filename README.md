# Win11-Like Workspace Switcher

Windows 11 Task View & Virtual Desktops switcher applet for Cinnamon, modeled closely after Windows 11 24H2 (`48 px` taskbar proportions, Dark/Light palettes, animations, and interactions) while staying ultra-lightweight.

## Features

- **Task View taskbar button**: `40 × 40` tile inside a `48 px` panel (scales proportionally with panel height and stays centered vertically and horizontally), two overlapping rounded-square icon drawn in pure Cairo (`ButtonArt`), with Windows 11's **press-converge** animation and zero idle compositor overhead.
- **Hover Virtual Desktops flyout**: Opens after `400 ms` hover above the panel button with a panel-clipped slide-up reveal (`250 ms EASE_OUT_QUINT`), displaying `240 × 164 px` desktop cards (`220 × 132 px` wallpaper + live window miniatures, `32 × 3 px` `#4cc2ff` active pill, hover `✕` close button), `+ New desktop` card, smooth horizontal scrolling, and **drag-and-drop desktop reordering**.
- **Full Windows 11 Task View overlay**:
  - Lazy-cached downscaled blurred wallpaper backdrop (`128 × 72` separable box-blurred `Clutter.Image` — avoids Cinnamon CSS `background-blur` crashes).
  - Upper window grid with aspect-preserving live `Clutter.Clone` previews, `2 px` accent hover/focus border, `✕` close button, smooth open animation, and **GPU-translated drag-and-drop onto desktop cards or `+ New desktop`** (floating above the dock, cursor-centered shrink, edge auto-scroll, `Escape` cancel / spring-back).
  - Window context menu (`Snap left`, `Snap right`, `Move to >`, `Show on all desktops`, `Close`) and keyboard grid/strip navigation (`Tab`, arrows, `Enter`, `F2`, `Delete`, `Alt+Shift+Left/Right`, `Shift+F10`).
  - Bottom Virtual Desktops dock (`monitorWidth - 16 px`, `176 px` tall, `8 px` above taskbar) with hover-to-preview workspace windows, inline rename (`F2` or click name), drag-and-drop desktop reordering, and desktop context menu (`Rename`, `Move left`, `Move right`, `Close`).
- **Configurable Windows 11 global shortcuts**: Defaults to `Win + Tab` (Task View), `Ctrl + Win + Left/Right` (switch workspace), `Ctrl + Win + D` (new workspace), and `Ctrl + Win + F4` (close current workspace). Every shortcut can be customized or disabled (`Enable global workspace shortcuts` toggle or clearing with `Backspace`/`Delete`), with automatic conflict detection against system WM/media/custom/applet shortcuts.
- **Ultra-lightweight**: Zero `St.Widget` overhead on the panel button, zero idle timers or polling, lazy wallpaper texture cache, cached theme detection, in-place active-pill updates, GPU `translation` drags (zero relayouts), and an ultra-lightweight `lite-mode`.

## Install & Verify

```sh
./tests/static_check.py
./install.sh --link
./tests/live_test.py
./tests/test_shortcuts.py
./tests/debug_battery.py
```
