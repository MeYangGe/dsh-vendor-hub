/**
 * Layout regression harness.
 *
 * The blank-panel defect had one cause: a content pane that claimed
 * `height:100%` inside a flex column pushed every page below the fold. This
 * renders the old and the new structure inside a host container shaped like the
 * harness's, measures where the body actually lands, and prints the numbers so a
 * headless browser can be asked for them:
 *
 *   node tests/layout-check.mjs            # writes tests/layout.html
 *   msedge --headless=new --dump-dom file:///.../tests/layout.html
 */

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PANEL_CSS } from '../src/client/styles.ts'

const here = dirname(fileURLToPath(import.meta.url))

const body = `
<h2>fixed host height (600px), OLD structure - header pane claims height:100%</h2>
<div class="host" data-case="old">
  <div class="mmp-root">
    <div class="mmp-panel mmp-legacy"><div class="mmp-head"><b>Magpie Connect</b> tabs 刷新</div></div>
    <div class="mmp-panel" id="old-body">
      <div class="mmp-tiles"><div class="mmp-tile"><b>—</b><span>剩余 Credits</span></div></div>
      <div class="mmp-block"><div class="mmp-block-head">账号额度</div></div>
    </div>
  </div>
</div>

<h2>fixed host height (600px), NEW structure - shell owns height, body scrolls</h2>
<div class="host" data-case="new">
  <div class="mmp-root mmp-shell">
    <div class="mmp-header"><div class="mmp-head"><b>Magpie Connect</b> tabs 刷新</div></div>
    <div class="mmp-scroll" id="new-scroll">
      <div class="mmp-panel" id="new-body">
        <div class="mmp-tiles"><div class="mmp-tile"><b>—</b><span>剩余 Credits</span></div></div>
        <div class="mmp-block"><div class="mmp-block-head">账号额度</div></div>
      </div>
    </div>
  </div>
</div>

<h2>height:auto host, NEW structure - must not collapse</h2>
<div class="host host-auto" data-case="new-auto">
  <div class="mmp-root mmp-shell">
    <div class="mmp-header"><div class="mmp-head"><b>Magpie Connect</b> tabs 刷新</div></div>
    <div class="mmp-scroll" id="auto-scroll">
      <div class="mmp-panel" id="auto-body">
        <div class="mmp-tiles"><div class="mmp-tile"><b>—</b><span>剩余 Credits</span></div></div>
        <div class="mmp-block"><div class="mmp-block-head">账号额度</div></div>
      </div>
    </div>
  </div>
</div>

<pre id="result">pending</pre>
<script>
  // The old stylesheet, reproduced only for the comparison case.
  const legacy = document.createElement('style');
  legacy.textContent = '.mmp-legacy{height:100%;overflow:auto}';
  document.head.appendChild(legacy);

  function measure(host, bodyId) {
    const box = host.getBoundingClientRect();
    const target = document.getElementById(bodyId);
    const rect = target.getBoundingClientRect();
    return {
      hostHeight: Math.round(box.height),
      bodyTopRelativeToHost: Math.round(rect.top - box.top),
      bodyVisible: rect.top < box.bottom,
      bodyHeight: Math.round(rect.height),
      scrollHeight: target.parentElement.scrollHeight,
      clientHeight: target.parentElement.clientHeight
    };
  }

  const hosts = document.querySelectorAll('.host');
  const out = {
    oldFixed: measure(hosts[0], 'old-body'),
    newFixed: measure(hosts[1], 'new-body'),
    newAuto: measure(hosts[2], 'auto-body')
  };
  document.getElementById('result').textContent = 'RESULT ' + JSON.stringify(out);
</script>
`

const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>mmp layout check</title>
<style>
  body{margin:0;padding:12px;font:13px/1.5 system-ui,sans-serif}
  h2{font-size:12px;color:#555;margin:14px 0 6px}
  .host{height:600px;display:flex;flex-direction:column;border:1px solid #bbb;overflow:hidden}
  .host-auto{height:auto;display:block}
</style>
<style>${PANEL_CSS}</style>
</head><body>${body}</body></html>`

writeFileSync(join(here, 'layout.html'), html, 'utf8')
console.log('layout.html written · ' + html.length + ' 字节')