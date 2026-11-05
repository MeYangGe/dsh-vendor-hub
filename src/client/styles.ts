/**
 * The console's stylesheet.
 *
 * Visual language follows magpie's own web UI: a neutral canvas, soft cards with
 * a hairline border, KPI tiles that lead with the number, thin allowance bars
 * that change colour as they drain, pill status tags and segmented controls.
 *
 * Classes are `mmp-` prefixed because other plugins inject global CSS into the
 * same document. Every colour resolves through a harness theme alias with a
 * literal fallback, so the panel stays readable on any theme.
 */

export const CSS_ID = 'dsh-magpie-connect/Panel.css'

export const PANEL_CSS = `
.mmp-root{
  --mmp-fg:var(--dsw-alias-label-primary,#16181d);
  --mmp-fg-dim:var(--dsw-alias-label-secondary,#5c626e);
  --mmp-fg-faint:var(--dsw-alias-label-tertiary,#8a909c);
  --mmp-bg:var(--dsw-alias-bg-layer-1,#ffffff);
  --mmp-bg-soft:var(--dsw-alias-bg-layer-2,#f5f6f8);
  --mmp-bg-sunk:var(--dsw-alias-bg-layer-3,#eceef2);
  --mmp-line:var(--dsw-alias-border-subtle,#e3e6ec);
  --mmp-accent:var(--dsw-alias-brand-primary,#34698c);
  --mmp-accent-soft:color-mix(in oklab,var(--mmp-accent) 12%,transparent);
  --mmp-good:#2f9e6a;
  --mmp-warn:#c98a15;
  --mmp-bad:#cc4b48;
  --mmp-radius:14px;
  color:var(--mmp-fg);
  font-size:13px;
  line-height:1.5;
  font-variant-numeric:tabular-nums;
}

/* ---------------------------------------------------------------- shell */
/* The panel is a column that owns the full height, with a fixed header and a
   scrolling body. the panel class itself must never claim height: a content pane
   that sets height:100% inside a flex column pushes everything below it out of
   sight - that was the "blank supplier page" defect. */
.mmp-shell{display:flex;flex-direction:column;height:100%;min-height:0}
.mmp-header{display:flex;align-items:center;gap:10px;flex-wrap:wrap;
  padding:14px 20px 10px;border-bottom:1px solid var(--mmp-line);flex:0 0 auto}
.mmp-scroll{flex:1 1 auto;min-height:0;overflow:auto}
.mmp-panel{display:flex;flex-direction:column;gap:14px;padding:16px 20px 28px}
.mmp-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.mmp-title{font-size:16px;font-weight:600;letter-spacing:-0.01em;margin:0}
.mmp-sub{color:var(--mmp-fg-dim);font-size:12px}
.mmp-grow{flex:1 1 auto}
.mmp-segs{display:inline-flex;background:var(--mmp-bg-sunk);border-radius:999px;padding:3px;gap:2px}
.mmp-seg{border:0;background:transparent;color:var(--mmp-fg-dim);font:inherit;font-size:12px;
  padding:5px 12px;border-radius:999px;cursor:pointer;white-space:nowrap}
.mmp-seg[data-on="1"]{background:var(--mmp-bg);color:var(--mmp-fg);font-weight:600;box-shadow:0 1px 2px rgba(16,20,28,.10)}
.mmp-seg:hover:not([data-on="1"]){color:var(--mmp-fg)}

.mmp-btn{border:1px solid var(--mmp-line);background:var(--mmp-bg);color:var(--mmp-fg);
  font:inherit;font-size:12px;padding:5px 12px;border-radius:9px;cursor:pointer}
.mmp-btn:hover{border-color:var(--mmp-accent);color:var(--mmp-accent)}
.mmp-btn[data-variant="primary"]{background:var(--mmp-accent);border-color:transparent;color:#fff}
.mmp-btn[data-variant="primary"]:hover{filter:brightness(1.08);color:#fff}
.mmp-btn[data-variant="danger"]:hover{border-color:var(--mmp-bad);color:var(--mmp-bad)}
.mmp-btn:disabled{opacity:.5;cursor:not-allowed}

/* ------------------------------------------------------------- kpi tiles */
.mmp-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:10px}
.mmp-tile{background:var(--mmp-bg);border:1px solid var(--mmp-line);border-radius:var(--mmp-radius);
  padding:12px 14px;display:flex;flex-direction:column;gap:2px}
.mmp-tile b{font-size:22px;font-weight:600;letter-spacing:-0.02em;line-height:1.15}
.mmp-tile span{font-size:11.5px;color:var(--mmp-fg-dim)}
.mmp-tile small{font-size:11px;color:var(--mmp-fg-faint)}

/* --------------------------------------------------------------- blocks */
.mmp-block{background:var(--mmp-bg);border:1px solid var(--mmp-line);border-radius:var(--mmp-radius);overflow:hidden}
.mmp-block-head{display:flex;align-items:center;gap:8px;padding:11px 14px;border-bottom:1px solid var(--mmp-line);
  font-size:12px;color:var(--mmp-fg-dim);font-weight:600}
.mmp-block-body{padding:6px 0}

/* ------------------------------------------------------------------ rows */
.mmp-row{display:flex;align-items:center;gap:11px;padding:10px 14px}
.mmp-row + .mmp-row{border-top:1px solid var(--mmp-line)}
.mmp-row:hover{background:var(--mmp-bg-soft)}
.mmp-glyph{width:30px;height:30px;flex:0 0 30px;border-radius:9px;display:grid;place-items:center;
  background:var(--mmp-accent-soft);color:var(--mmp-accent);font-weight:700;font-size:13px}
.mmp-who{flex:1 1 auto;min-width:0}
.mmp-name{font-weight:600;font-size:12.5px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.mmp-meta{font-size:11.5px;color:var(--mmp-fg-dim);display:flex;gap:6px;flex-wrap:wrap}
.mmp-share{width:88px;height:4px;border-radius:999px;background:var(--mmp-bg-sunk);overflow:hidden;flex:0 0 88px}
.mmp-share i{display:block;height:100%;border-radius:999px;background:var(--mmp-accent)}
.mmp-num{text-align:right;font-size:12px;min-width:74px}
.mmp-num b{font-weight:600}
.mmp-num small{display:block;color:var(--mmp-fg-faint);font-size:10.5px}

/* --------------------------------------------------------------- pills */
.mmp-pill{font-size:10.5px;padding:1px 7px;border-radius:999px;background:var(--mmp-bg-sunk);
  color:var(--mmp-fg-dim);font-weight:600;white-space:nowrap}
.mmp-pill[data-tone="good"]{background:color-mix(in oklab,var(--mmp-good) 15%,transparent);color:var(--mmp-good)}
.mmp-pill[data-tone="warn"]{background:color-mix(in oklab,var(--mmp-warn) 16%,transparent);color:var(--mmp-warn)}
.mmp-pill[data-tone="bad"]{background:color-mix(in oklab,var(--mmp-bad) 14%,transparent);color:var(--mmp-bad)}
.mmp-pill[data-tone="accent"]{background:var(--mmp-accent-soft);color:var(--mmp-accent)}

/* --------------------------------------------------------------- bars */
.mmp-bars{display:flex;flex-direction:column;gap:7px;padding:2px 14px 12px}
.mmp-bar{display:flex;flex-direction:column;gap:3px}
.mmp-bar-top{display:flex;font-size:11.5px;color:var(--mmp-fg-dim);gap:8px}
.mmp-bar-track{height:5px;border-radius:999px;background:var(--mmp-bg-sunk);overflow:hidden}
.mmp-bar-fill{height:100%;border-radius:999px;background:var(--mmp-accent);transition:width .25s ease}
.mmp-bar-fill[data-tone="warn"]{background:var(--mmp-warn)}
.mmp-bar-fill[data-tone="bad"]{background:var(--mmp-bad)}
.mmp-bar-note{font-size:10.5px;color:var(--mmp-fg-faint)}

/* -------------------------------------------------------------- sidebar */
.mmp-foot{box-sizing:border-box;width:100%;display:flex;flex-direction:column;gap:6px;
  padding:8px 10px;border-radius:11px;border:1px solid var(--mmp-line);background:var(--mmp-bg);
  cursor:pointer;text-align:left;font:inherit;color:inherit}
.mmp-foot:hover{border-color:var(--mmp-accent)}
.mmp-foot-head{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--mmp-fg-dim)}
.mmp-foot-head b{color:var(--mmp-fg);font-weight:600}
.mmp-foot-grid{display:flex;flex-direction:column;gap:5px}
.mmp-foot-item{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--mmp-fg-dim)}
.mmp-foot-item .mmp-share{width:auto;flex:1 1 auto;height:3px}
.mmp-foot-rail{display:grid;place-items:center;width:36px;height:36px;border-radius:10px;
  border:1px solid var(--mmp-line);background:var(--mmp-bg);cursor:pointer;font-weight:700;font-size:12px;
  color:var(--mmp-accent);position:relative}
.mmp-dot{position:absolute;top:-3px;right:-3px;width:9px;height:9px;border-radius:999px;background:var(--mmp-warn);
  border:2px solid var(--mmp-bg)}

/* ---------------------------------------------------------------- forms */
.mmp-form{display:flex;flex-direction:column;gap:9px;padding:12px 14px 14px}
.mmp-field{display:flex;flex-direction:column;gap:3px}
.mmp-field label{font-size:11.5px;color:var(--mmp-fg-dim)}
.mmp-field input{font:inherit;font-size:12.5px;padding:7px 10px;border-radius:9px;
  border:1px solid var(--mmp-line);background:var(--mmp-bg-soft);color:var(--mmp-fg);min-width:0}
.mmp-field input:focus{outline:none;border-color:var(--mmp-accent);background:var(--mmp-bg)}
.mmp-hint{font-size:11px;color:var(--mmp-fg-faint);line-height:1.45}
.mmp-actions{display:flex;gap:7px;flex-wrap:wrap;align-items:center}

/* -------------------------------------------------------------- empties */
.mmp-empty{color:var(--mmp-fg-dim);font-size:12px;padding:14px;text-align:center}
.mmp-error{color:var(--mmp-bad);font-size:11.5px;padding:8px 14px;background:color-mix(in oklab,var(--mmp-bad) 7%,transparent)}
.mmp-ok{color:var(--mmp-good);font-size:11.5px}
.mmp-log{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;
  color:var(--mmp-fg-dim);display:flex;flex-direction:column;gap:2px;max-height:220px;overflow:auto;padding:8px 14px}
.mmp-log div{display:flex;gap:8px}
.mmp-log time{color:var(--mmp-fg-faint);flex:0 0 auto}
.mmp-vendor-tabs{display:flex;gap:6px;flex-wrap:wrap;padding:12px 14px 0}
.mmp-vendor-tab{border:1px solid var(--mmp-line);background:var(--mmp-bg);border-radius:999px;
  font:inherit;font-size:11.5px;padding:4px 11px;cursor:pointer;color:var(--mmp-fg-dim)}
.mmp-vendor-tab[data-on="1"]{border-color:var(--mmp-accent);color:var(--mmp-accent);background:var(--mmp-accent-soft)}
.mmp-footbar{font-size:11px;color:var(--mmp-fg-faint);display:flex;gap:10px;flex-wrap:wrap}
`

let installed = false

/** Mount the stylesheet once; safe to call from every surface. */
export function ensureStyles(): void {
  if (installed) return
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) !== null) {
    installed = true
    return
  }
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-magpie-connect'
  tag.dataset.pluginCss = CSS_ID
  tag.textContent = PANEL_CSS
  document.head.appendChild(tag)
  installed = true
}

/** Remove the stylesheet when the plugin's fiber unwinds. */
export function removeStyles(): void {
  if (typeof document === 'undefined') return
  const tag = document.querySelector(`style[data-plugin-css="${CSS_ID}"]`)
  tag?.remove()
  installed = false
}