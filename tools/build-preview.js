#!/usr/bin/env node
/*
 * Builds a single self-contained HTML file that runs Gear Desk in any browser with sample
 * data — no Google account needed. The real Code.gs runs in the page against in-memory
 * stand-ins for Google Sheets and Gmail; emails land in a "Demo outbox" instead of sending.
 *
 *   node tools/build-preview.js [output.html]      (default: dist/preview.html)
 */
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..');
const src = (f) => fs.readFileSync(path.join(root, 'apps-script', f), 'utf8');
const out = path.resolve(process.argv[2] || path.join(root, 'dist', 'preview.html'));

// Evaluate the template scriptlets (<?= ?> / <?!= ?>) the same way HtmlService would.
const createGasMock = require('../tests/gas-mock');
const brandJson = src('Brand.html');
const ctx = Object.assign({ Intl }, createGasMock({ files: { Brand: brandJson } }).globals);
vm.createContext(ctx);
vm.runInContext(src('Code.gs'), ctx);
ctx.include = (name) => src(name + '.html');
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
let html = src('Index.html').replace(/<\?(!?)=\s*([\s\S]*?)\s*;?\s*\?>/g, (m, raw, expr) => {
  const v = vm.runInContext(expr, ctx);
  return raw ? v : escAttr(v);
});

const backend = `
<script>${fs.readFileSync(path.join(root, 'tests', 'gas-mock.js'), 'utf8')}</script>
<script>
(function () {
  var MOCK = createGasMock({ user: 'desk@studio.example.edu', owner: 'studio@example.edu',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, files: { Brand: ${JSON.stringify(brandJson)} } });
  var Logger = MOCK.globals.Logger, PropertiesService = MOCK.globals.PropertiesService,
    SpreadsheetApp = MOCK.globals.SpreadsheetApp, LockService = MOCK.globals.LockService,
    MailApp = MOCK.globals.MailApp, Session = MOCK.globals.Session, Utilities = MOCK.globals.Utilities,
    HtmlService = MOCK.globals.HtmlService;
${src('Code.gs')}
  window.__gearDesk = { api: api, mock: MOCK, setup: setup };
})();
</script>
<script>
(function () {
  var G = window.__gearDesk, api = G.api;
  var ok = function (a, p) { var r = api(a, p); if (!r.ok) throw new Error(a + ': ' + r.error); return r.result; };
  var at = function (days, hour) { var d = new Date(); d.setDate(d.getDate() + days); if (hour !== undefined) d.setHours(hour, 0, 0, 0); return d; };

  // ---- sample data ----
  G.setup();
  ok('saveSettings', { settings: { staff: ['Hank', 'Ashlee', 'Jordan'], replyTo: 'studio@example.edu',
    contactLine: 'The Studio · Library, Room 210 · Mon–Fri 9 AM – 6 PM' } });
  var gear = [
    ['Canon EOS R6 Mark II kit', 'Cameras', 'CDX-CAM-01', 3, 'Cage A'],
    ['Sony ZV-E10 vlog kit', 'Cameras', 'CDX-CAM-04', 4, 'Cage A'],
    ['GoPro HERO12', 'Cameras', 'CDX-CAM-09', 2, 'Cage A'],
    ['RF 24–105mm f/4 lens', 'Lenses', 'CDX-LEN-02', 2, 'Cage A'],
    ['Rode Wireless GO II', 'Audio', 'CDX-AUD-03', 4, 'Drawer 2'],
    ['Zoom H5 recorder', 'Audio', 'CDX-AUD-07', 3, 'Drawer 2'],
    ['Shure SM7B podcast mic', 'Audio', 'CDX-AUD-11', 2, 'Podcast booth'],
    ['Aputure Amaran 200d light', 'Lighting', 'CDX-LGT-01', 2, 'Shelf C'],
    ['Ring light, 18"', 'Lighting', 'CDX-LGT-05', 3, 'Shelf C'],
    ['Manfrotto video tripod', 'Tripods & Support', 'CDX-TRI-02', 5, 'Rack'],
    ['DJI RS 3 gimbal', 'Tripods & Support', 'CDX-GIM-01', 1, 'Cage B'],
    ['iPad Pro 12.9" + Pencil', 'Computers & Tablets', 'CDX-TAB-03', 4, 'Charging cart'],
    ['MacBook Pro 14" (Adobe CC)', 'Computers & Tablets', 'CDX-LAP-06', 3, 'Charging cart'],
    ['Meta Quest 3', 'VR / AR', 'CDX-VR-02', 2, 'Cage B'],
    ['HDMI cable, 10 ft', 'Cables & Adapters', '', 12, 'Bin 4'],
    ['SD card, 128 GB', 'Cables & Adapters', '', 10, 'Bin 1']
  ];
  var ids = {};
  gear.forEach(function (g) {
    ids[g[0]] = ok('saveItem', { staff: 'Hank', item: { name: g[0], category: g[1], assetTag: g[2], totalQty: g[3], location: g[4],
      outOfService: g[0] === 'Zoom H5 recorder' ? 1 : 0, notes: g[0] === 'Zoom H5 recorder' ? 'One unit has a loose headphone jack — sent for repair.' : '' } }).item.id;
  });
  var loans = [
    ['Maya Thompson', 'maya.thompson@example.edu', 'FILM 210', 'Ashlee', -4, -1, [['Canon EOS R6 Mark II kit', 1], ['RF 24–105mm f/4 lens', 1], ['SD card, 128 GB', 2]], 'Documentary project'],
    ['Devon Carter', 'devon.carter@example.edu', 'Podcast Club', 'Hank', -1, 0, [['Shure SM7B podcast mic', 2], ['Zoom H5 recorder', 1]], ''],
    ['Priya Nair', 'priya.nair@example.edu', 'ART 305', 'Jordan', -2, 2, [['iPad Pro 12.9" + Pencil', 1]], ''],
    ['Luis Ortega', 'luis.ortega@example.edu', 'Student Media', 'Hank', 0, 3, [['Sony ZV-E10 vlog kit', 1], ['Rode Wireless GO II', 2], ['Manfrotto video tripod', 1], ['SD card, 128 GB', 1]], 'Campus tour video'],
    ['Grace Kim', 'grace.kim@example.edu', 'COMM 120', 'Ashlee', -9, -6, [['Meta Quest 3', 1]], ''],
    ['Sam Patel', 'sam.patel@example.edu', '', 'Jordan', -12, -9, [['Aputure Amaran 200d light', 2], ['Manfrotto video tripod', 2]], '']
  ];
  var made = loans.map(function (L) {
    var r = ok('checkout', { borrowerName: L[0], borrowerEmail: L[1], borrowerGroup: L[2], staff: L[3], dueAt: at(1).toISOString(),
      notes: L[7], items: L[6].map(function (x) { return { itemId: ids[x[0]], qty: x[1] }; }) }).rental;
    ok('updateRental', { id: r.id, dueAt: at(L[5], 17).toISOString(), staff: L[3] });
    // backdate the checkout time in the sheet
    var sh = G.mock.db().getSheetByName('Rentals'), hdr = sh.data[0];
    sh.data.forEach(function (row) { if (row[0] === r.id) row[hdr.indexOf('checkedOutAt')] = at(L[4], 10 + (L[4] & 3)); });
    return r;
  });
  ok('confirmReturn', { id: made[4].id, staff: 'Hank', lines: [{ itemId: ids['Meta Quest 3'], qty: 1, condition: 'Good' }] });
  ok('confirmReturn', { id: made[5].id, staff: 'Ashlee', notes: 'One light came back with a bent stand leg.', lines: [
    { itemId: ids['Aputure Amaran 200d light'], qty: 2, condition: 'Good' }, { itemId: ids['Manfrotto video tripod'], qty: 2, condition: 'Needs attention', note: 'bent leg' }] });
  G.mock.sent.length = 0; // start the outbox empty

  // ---- google.script.run stand-in ----
  function runner(ok, fail) {
    return {
      withSuccessHandler: function (fn) { return runner(fn, fail); },
      withFailureHandler: function (fn) { return runner(ok, fn); },
      api: function (action, payload) {
        setTimeout(function () {
          var res;
          try { res = JSON.parse(JSON.stringify(api(action, JSON.parse(JSON.stringify(payload || {}))))); }
          catch (e) { if (fail) fail(e); return; }
          if (ok) ok(res);
          if (window.__demoOutbox) window.__demoOutbox.refresh();
        }, 220);
      }
    };
  }
  window.google = { script: { run: runner(null, null) } };
})();
</script>`;

const demoUi = `
<style>
  .demo-bar { background: #FED277; color: #4D1979; font: 600 13px/1.4 'Outfit', Arial, sans-serif; text-align: center; padding: 7px 16px; }
  .demo-bar b { font-weight: 800; }
  .demo-outbox-btn { margin-left: 10px; border: 0; border-radius: 999px; padding: 4px 12px; background: #4D1979; color: #fff;
    font: 700 13px 'Outfit', Arial, sans-serif; cursor: pointer; display: inline-flex; gap: 6px; align-items: center; vertical-align: middle; }
  .demo-outbox-btn .n { background: #FED277; color: #4D1979; border-radius: 99px; min-width: 20px; height: 20px; line-height: 20px; text-align: center; font-size: 12px; }
  .demo-outbox-btn.is-new { animation: demoPing 1s ease-out 2; }
  @keyframes demoPing { 50% { transform: scale(1.08); } }
  .demo-outbox { position: fixed; inset: 0; z-index: 200; background: rgba(30,10,45,.6); display: flex; align-items: center; justify-content: center; padding: 16px; }
  .demo-outbox__panel { background: #fff; color: #231F20; width: min(1000px, 100%); height: min(860px, 100%); border-radius: 18px; overflow: hidden; display: grid; grid-template-columns: 280px 1fr; grid-template-rows: auto 1fr; font-family: 'Outfit', Arial, sans-serif; }
  .demo-outbox__head { grid-column: 1 / -1; display: flex; justify-content: space-between; align-items: center; padding: 14px 18px; background: #4D1979; color: #fff; }
  .demo-outbox__head button { border: 0; background: rgba(255,255,255,.15); color: #fff; border-radius: 99px; padding: 6px 14px; cursor: pointer; font: inherit; }
  .demo-outbox__list { border-right: 1px solid #E6E1D3; overflow: auto; background: #F6F5ED; }
  .demo-outbox__list button { display: block; width: 100%; text-align: left; border: 0; border-bottom: 1px solid #E6E1D3; background: none; padding: 12px 14px; cursor: pointer; font: 13px/1.4 'Outfit', Arial, sans-serif; color: #231F20; }
  .demo-outbox__list button[aria-current] { background: #fff; box-shadow: inset 4px 0 0 #854EA7; }
  .demo-outbox__list small { display: block; color: #675F6D; }
  .demo-outbox iframe { width: 100%; height: 100%; border: 0; background: #F6F5ED; }
  .demo-outbox__empty { padding: 30px; color: #675F6D; }
  @media (max-width: 700px) { .demo-outbox__panel { grid-template-columns: 1fr; grid-template-rows: auto auto 1fr; } .demo-outbox__list { max-height: 160px; border-right: 0; border-bottom: 1px solid #E6E1D3; } }
</style>
<script>
(function () {
  var mock = window.__gearDesk.mock;
  var bar = document.createElement('div');
  bar.className = 'demo-bar';
  bar.innerHTML = '<b>Preview with sample data.</b> Nothing is saved; emails land in the outbox instead of being sent.' +
    '<button type="button" class="demo-outbox-btn">Demo outbox <span class="n">0</span></button>';
  document.body.insertBefore(bar, document.body.firstChild);
  var btn = bar.querySelector('.demo-outbox-btn');
  var seen = 0, current = -1;

  function inline(m) {
    var html = m.htmlBody;
    Object.keys(m.inlineImages || {}).forEach(function (k) {
      html = html.split('cid:' + k).join('data:image/png;base64,' + m.inlineImages[k].b64);
    });
    return html;
  }
  function open(idx) {
    var list = mock.sent;
    var o = document.createElement('div');
    o.className = 'demo-outbox';
    o.innerHTML = '<div class="demo-outbox__panel" role="dialog" aria-label="Demo outbox"><div class="demo-outbox__head"><b>Demo outbox · ' + list.length + ' email' + (list.length === 1 ? '' : 's') + '</b><button type="button" data-x>Close</button></div>' +
      '<div class="demo-outbox__list"></div><div class="demo-outbox__view"></div></div>';
    document.body.appendChild(o);
    var listEl = o.querySelector('.demo-outbox__list'), view = o.querySelector('.demo-outbox__view');
    function show(i) {
      current = i;
      listEl.innerHTML = list.slice().reverse().map(function (m, j) {
        var k = list.length - 1 - j;
        return '<button type="button" data-i="' + k + '"' + (k === i ? ' aria-current="true"' : '') + '><b>' + m.subject.replace(/</g, '&lt;') + '</b><small>To ' + m.to + (m.cc ? ' · cc ' + m.cc : '') + '</small></button>';
      }).join('') || '<div class="demo-outbox__empty">No emails yet. Check something out or confirm a return.</div>';
      view.innerHTML = '';
      if (i >= 0 && list[i]) { var f = document.createElement('iframe'); f.title = 'Email preview'; f.srcdoc = inline(list[i]); view.appendChild(f); }
    }
    show(idx);
    o.addEventListener('click', function (e) {
      if (e.target === o || e.target.closest('[data-x]')) { o.remove(); return; }
      var b = e.target.closest('[data-i]'); if (b) show(Number(b.dataset.i));
    });
  }
  btn.addEventListener('click', function () { open(mock.sent.length - 1); });
  window.__demoOutbox = { refresh: function () {
    btn.querySelector('.n').textContent = mock.sent.length;
    if (mock.sent.length > seen) { btn.classList.remove('is-new'); void btn.offsetWidth; btn.classList.add('is-new'); }
    seen = mock.sent.length;
  } };
})();
</script>`;

const marker = '<script>\n/* Gear Desk — web app';
if (html.indexOf(marker) === -1) throw new Error('App script marker not found');
html = html.replace(marker, () => backend + '\n' + marker);
const end = html.lastIndexOf('</body>');
html = html.slice(0, end) + demoUi + '\n' + html.slice(end);
html = html.replace('<title>Gear Desk · The Studio</title>', '<title>Gear Desk Preview</title>');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log('Wrote ' + path.relative(process.cwd(), out) + ' (' + Math.round(html.length / 1024) + ' KB)');
