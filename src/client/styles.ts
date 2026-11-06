/**
 * The console's stylesheet.
 *
 * Visual language follows magpie's own web UI: a neutral canvas, soft cards with
 * a hairline border, KPI tiles that lead with the number, thin allowance bars
 * that change colour as they drain, pill status tags and segmented controls.
 *
 * Classes are `vdh-` prefixed because other plugins inject global CSS into the
 * same document. Every colour resolves through a harness theme alias with a
 * literal fallback, so the panel stays readable on any theme.
 */

export const CSS_ID = 'dsh-vendor-hub/Panel.css'

export const PANEL_CSS = `
.vdh-root{
  --vdh-fg:var(--dsw-alias-label-primary,#16181d);
  --vdh-fg-dim:var(--dsw-alias-label-secondary,#5c626e);
  --vdh-fg-faint:var(--dsw-alias-label-tertiary,#8a909c);
  --vdh-bg:var(--dsw-alias-bg-layer-1,#ffffff);
  --vdh-bg-soft:var(--dsw-alias-bg-layer-2,#f5f6f8);
  --vdh-bg-sunk:var(--dsw-alias-bg-layer-3,#eceef2);
  --vdh-line:var(--dsw-alias-border-subtle,#e3e6ec);
  --vdh-accent:var(--dsw-alias-brand-primary,#34698c);
  --vdh-accent-soft:color-mix(in oklab,var(--vdh-accent) 12%,transparent);
  --vdh-good:#2f9e6a;
  --vdh-warn:#c98a15;
  --vdh-bad:#cc4b48;
  --vdh-radius:14px;
  color:var(--vdh-fg);
  font-size:13px;
  line-height:1.5;
  font-variant-numeric:tabular-nums;
}

/* ---------------------------------------------------------------- shell */
/* The panel is a column that owns the full height, with a fixed header and a
   scrolling body. the panel class itself must never claim height: a content pane
   that sets height:100% inside a flex column pushes everything below it out of
   sight - that was the "blank supplier page" defect. */
.vdh-shell{display:flex;flex-direction:column;height:100%;min-height:0}
.vdh-header{display:flex;align-items:center;gap:10px;flex-wrap:wrap;
  padding:14px 20px 10px;border-bottom:1px solid var(--vdh-line);flex:0 0 auto}
.vdh-scroll{flex:1 1 auto;min-height:0;overflow:auto}
.vdh-panel{display:flex;flex-direction:column;gap:14px;padding:16px 20px 28px}
.vdh-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.vdh-title{font-size:16px;font-weight:600;letter-spacing:-0.01em;margin:0}
.vdh-sub{color:var(--vdh-fg-dim);font-size:12px}
.vdh-grow{flex:1 1 auto}
.vdh-segs{display:inline-flex;background:var(--vdh-bg-sunk);border-radius:999px;padding:3px;gap:2px}
.vdh-seg{border:0;background:transparent;color:var(--vdh-fg-dim);font:inherit;font-size:12px;
  padding:5px 12px;border-radius:999px;cursor:pointer;white-space:nowrap}
.vdh-seg[data-on="1"]{background:var(--vdh-bg);color:var(--vdh-fg);font-weight:600;box-shadow:0 1px 2px rgba(16,20,28,.10)}
.vdh-seg:hover:not([data-on="1"]){color:var(--vdh-fg)}

.vdh-btn{border:1px solid var(--vdh-line);background:var(--vdh-bg);color:var(--vdh-fg);
  font:inherit;font-size:12px;padding:5px 12px;border-radius:9px;cursor:pointer}
.vdh-btn:hover{border-color:var(--vdh-accent);color:var(--vdh-accent)}
.vdh-btn[data-variant="primary"]{background:var(--vdh-accent);border-color:transparent;color:#fff}
.vdh-btn[data-variant="primary"]:hover{filter:brightness(1.08);color:#fff}
.vdh-btn[data-variant="danger"]:hover{border-color:var(--vdh-bad);color:var(--vdh-bad)}
.vdh-btn:disabled{opacity:.5;cursor:not-allowed}

/* ------------------------------------------------------------- kpi tiles */
.vdh-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:10px}
.vdh-tile{background:var(--vdh-bg);border:1px solid var(--vdh-line);border-radius:var(--vdh-radius);
  padding:12px 14px;display:flex;flex-direction:column;gap:2px}
.vdh-tile b{font-size:22px;font-weight:600;letter-spacing:-0.02em;line-height:1.15}
.vdh-tile span{font-size:11.5px;color:var(--vdh-fg-dim)}
.vdh-tile small{font-size:11px;color:var(--vdh-fg-faint)}

/* --------------------------------------------------------------- blocks */
.vdh-block{background:var(--vdh-bg);border:1px solid var(--vdh-line);border-radius:var(--vdh-radius);overflow:hidden}
.vdh-block-head{display:flex;align-items:center;gap:8px;padding:11px 14px;border-bottom:1px solid var(--vdh-line);
  font-size:12px;color:var(--vdh-fg-dim);font-weight:600}
.vdh-block-body{padding:6px 0}

/* ------------------------------------------------------------------ rows */
.vdh-row{display:flex;align-items:center;gap:11px;padding:10px 14px}
.vdh-row + .vdh-row{border-top:1px solid var(--vdh-line)}
.vdh-row:hover{background:var(--vdh-bg-soft)}
.vdh-glyph{width:30px;height:30px;flex:0 0 30px;border-radius:9px;display:grid;place-items:center;
  background:var(--vdh-accent-soft);color:var(--vdh-accent);font-weight:700;font-size:13px}
.vdh-who{flex:1 1 auto;min-width:0}
.vdh-name{font-weight:600;font-size:12.5px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.vdh-meta{font-size:11.5px;color:var(--vdh-fg-dim);display:flex;gap:6px;flex-wrap:wrap}
.vdh-share{width:88px;height:4px;border-radius:999px;background:var(--vdh-bg-sunk);overflow:hidden;flex:0 0 88px}
.vdh-share i{display:block;height:100%;border-radius:999px;background:var(--vdh-accent)}
.vdh-num{text-align:right;font-size:12px;min-width:74px}
.vdh-num b{font-weight:600}
.vdh-num small{display:block;color:var(--vdh-fg-faint);font-size:10.5px}

/* --------------------------------------------------------------- pills */
.vdh-pill{font-size:10.5px;padding:1px 7px;border-radius:999px;background:var(--vdh-bg-sunk);
  color:var(--vdh-fg-dim);font-weight:600;white-space:nowrap}
.vdh-pill[data-tone="good"]{background:color-mix(in oklab,var(--vdh-good) 15%,transparent);color:var(--vdh-good)}
.vdh-pill[data-tone="warn"]{background:color-mix(in oklab,var(--vdh-warn) 16%,transparent);color:var(--vdh-warn)}
.vdh-pill[data-tone="bad"]{background:color-mix(in oklab,var(--vdh-bad) 14%,transparent);color:var(--vdh-bad)}
.vdh-pill[data-tone="accent"]{background:var(--vdh-accent-soft);color:var(--vdh-accent)}

/* --------------------------------------------------------------- bars */
.vdh-bars{display:flex;flex-direction:column;gap:7px;padding:2px 14px 12px}
.vdh-bar{display:flex;flex-direction:column;gap:3px}
.vdh-bar-top{display:flex;font-size:11.5px;color:var(--vdh-fg-dim);gap:8px}
.vdh-bar-track{height:5px;border-radius:999px;background:var(--vdh-bg-sunk);overflow:hidden}
.vdh-bar-fill{height:100%;border-radius:999px;background:var(--vdh-accent);transition:width .25s ease}
.vdh-bar-fill[data-tone="warn"]{background:var(--vdh-warn)}
.vdh-bar-fill[data-tone="bad"]{background:var(--vdh-bad)}
.vdh-bar-note{font-size:10.5px;color:var(--vdh-fg-faint)}

/* -------------------------------------------------------------- sidebar */
.vdh-foot{box-sizing:border-box;width:100%;display:flex;flex-direction:column;gap:6px;
  padding:8px 10px;border-radius:11px;border:1px solid var(--vdh-line);background:var(--vdh-bg);
  cursor:pointer;text-align:left;font:inherit;color:inherit}
.vdh-foot:hover{border-color:var(--vdh-accent)}
.vdh-foot-head{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--vdh-fg-dim)}
.vdh-foot-head b{color:var(--vdh-fg);font-weight:600}
.vdh-foot-grid{display:flex;flex-direction:column;gap:5px}
.vdh-foot-item{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--vdh-fg-dim)}
.vdh-foot-item .vdh-share{width:auto;flex:1 1 auto;height:3px}
.vdh-foot-rail{display:grid;place-items:center;width:36px;height:36px;border-radius:10px;
  border:1px solid var(--vdh-line);background:var(--vdh-bg);cursor:pointer;font-weight:700;font-size:12px;
  color:var(--vdh-accent);position:relative}
.vdh-dot{position:absolute;top:-3px;right:-3px;width:9px;height:9px;border-radius:999px;background:var(--vdh-warn);
  border:2px solid var(--vdh-bg)}

/* ---------------------------------------------------------------- forms */
.vdh-form{display:flex;flex-direction:column;gap:9px;padding:12px 14px 14px}
.vdh-field{display:flex;flex-direction:column;gap:3px}
.vdh-field label{font-size:11.5px;color:var(--vdh-fg-dim)}
.vdh-field input{font:inherit;font-size:12.5px;padding:7px 10px;border-radius:9px;
  border:1px solid var(--vdh-line);background:var(--vdh-bg-soft);color:var(--vdh-fg);min-width:0}
.vdh-field input:focus{outline:none;border-color:var(--vdh-accent);background:var(--vdh-bg)}
.vdh-hint{font-size:11px;color:var(--vdh-fg-faint);line-height:1.45}
.vdh-actions{display:flex;gap:7px;flex-wrap:wrap;align-items:center}

/* -------------------------------------------------------------- empties */
.vdh-empty{color:var(--vdh-fg-dim);font-size:12px;padding:14px;text-align:center}
.vdh-error{color:var(--vdh-bad);font-size:11.5px;padding:8px 14px;background:color-mix(in oklab,var(--vdh-bad) 7%,transparent)}
.vdh-ok{color:var(--vdh-good);font-size:11.5px}
.vdh-log{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;
  color:var(--vdh-fg-dim);display:flex;flex-direction:column;gap:2px;max-height:220px;overflow:auto;padding:8px 14px}
.vdh-log div{display:flex;gap:8px}
.vdh-log time{color:var(--vdh-fg-faint);flex:0 0 auto}
.vdh-vendor-tabs{display:flex;gap:6px;flex-wrap:wrap;padding:12px 14px 0}
.vdh-vendor-tab{border:1px solid var(--vdh-line);background:var(--vdh-bg);border-radius:999px;
  font:inherit;font-size:11.5px;padding:4px 11px;cursor:pointer;color:var(--vdh-fg-dim)}
.vdh-vendor-tab[data-on="1"]{border-color:var(--vdh-accent);color:var(--vdh-accent);background:var(--vdh-accent-soft)}
.vdh-footbar{font-size:11px;color:var(--vdh-fg-faint);display:flex;gap:10px;flex-wrap:wrap}
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
  tag.dataset.plugin = 'dsh-vendor-hub'
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