# Mock//Server — Visual Prototype

**Design Direction**: "Mission Bridge"
**Date**: 2026-06-08

## How to view

Open `index.html` in any modern browser. No build, no install, no server required.

```bash
open index.html
# or
xdg-open index.html
# or just double-click in Finder
```

## What you can do in the prototype

- **Click endpoints** in the left sidebar to switch the editor pane.
- **Edit fields** (method, port, path, status) and the JSON response.
- **FORMAT** the JSON (2-space indent) or **VALIDATE** it (inline error).
- **SAVE** with `Cmd/Ctrl + S` or the button. Try changing `(port, method, path)` to a duplicate — it rejects.
- **Click ARM** in the top right. The button transitions `ARM → STARTING… → STOP` with a 900ms pause; the status pill goes amber → green; LEDs in the sidebar pulse.
- **Toggle SIMULATE** in the logs panel header to fire fake requests every ~1.1s. New entries slide in, color-coded by match/404/error.
- **Click CLEAR** to wipe logs.
- **Click the gear** (top right) to open the Settings dialog (storage path, UI port).
- **Tab key** in the JSON editor inserts 2 spaces (no focus loss).

## Design Direction — "Mission Bridge"

A dark, instrument-panel inspired developer tool. The aesthetic borrows from three places:

1. **Apollo-era mission control** — signal lights, status pills, monospace data, "all caps" labels with letter-spacing.
2. **High-end audio plugin UIs** (UAD, FabFilter) — inset code editor, hard 1px borders, semantic color used sparingly for state.
3. **Brutalist editorial design** — Bricolage Grotesque at large sizes, hard contrast, no decoration without purpose.

### What it deliberately avoids

- ❌ Inter / Roboto / system fonts → uses **Bricolage Grotesque** (variable, characterful) + **JetBrains Mono** (tabular nums).
- ❌ Purple gradients on white → **ink-dark surfaces** with **semantic signal colors**.
- ❌ Centered hero + single CTA → **3-zone instrument layout** (sidebar / editor / logs).
- ❌ Tailwind default cards → **hard 1px borders**, no rounded corners on chrome, subtle inner shadows on insets.
- ❌ Generic dashboard → **status semantics drive the palette**: green = running, amber = stopped/warning, red = failed, cyan = selection/highlight.

### Color tokens

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#0c0d10` | Page background |
| `--surface-1/2/3` | `#15171b / #1c1f25 / #232730` | Panels, cards, hover |
| `--green` | `#7cffaf` | Running state, success |
| `--amber` | `#ffc857` | Stopped state, warnings, dirty edits |
| `--red` | `#ff5c5c` | Failed state, errors, delete |
| `--cyan` | `#6bd5ff` | Selection, focus, focus rings |
| `--magenta` | `#d68aff` | (Reserved) PATCH method |

### Typography scale

- **Display / UI chrome**: Bricolage Grotesque, variable opsz axis (24 for inline, 96 for empty-state mark)
- **Data / code / logs**: JetBrains Mono, tabular-nums on numerics, 11.5–13px
- **Section labels**: Bricolage, 11px, 0.18em letter-spacing, uppercase, secondary text color

### Motion

- **Page load**: 4 zones reveal with 40/140/240/360ms stagger (header → sidebar → editor → logs).
- **Status LEDs**: slow pulse (2.4s) when running, fast pulse (0.9s) when starting.
- **Start button**: 3-state morph (amber → amber-fast → green) with color-shifted gradient backgrounds.
- **Log entries**: slide in from -4px with brief cyan tint, then fade to transparent.
- **Selected endpoint**: 2px cyan left border with glow, slides in.
- **Method badges**: colored by HTTP verb (GET=green, POST=cyan, PUT=amber, PATCH=magenta, DELETE=red).

## File map

```
prototype/
├── index.html      # Semantic structure, 3 zones + modal
├── styles.css      # Design system: tokens, layout, components, motion
├── app.js          # State, render, interactions, log simulator
└── README.md       # This file
```

## Next steps

1. **Direction approved?** → We move to `writing-plans` to convert the design spec + this visual direction into an implementation plan.
2. **Want a different aesthetic?** → Tell me what feels off (too dark? too dense? not serious enough? too on-the-nose mission control?). I'll re-skin.
3. **Specific changes?** → Typography, color, motion, layout — any one of them is a fresh pass.
