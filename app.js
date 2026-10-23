/* Form Hub — web app. Plain JavaScript, no build step. */
(function () {
  'use strict';

  var STORE = 'formhub:';
  var PAGE_SIZE = 50;

  /* ---------------- Local storage (device-only conveniences) ---------------- */

  function load(key, fallback) {
    try {
      var v = localStorage.getItem(STORE + key);
      return v === null ? fallback : JSON.parse(v);
    } catch (e) { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(STORE + key, JSON.stringify(value)); } catch (e) { /* storage blocked */ }
  }
  function forget(key) {
    try { localStorage.removeItem(STORE + key); } catch (e) { /* storage blocked */ }
  }

  var state = {
    conn: load('conn', null),              // { url, key }
    device: load('device', { browserNotify: false, pollSeconds: 60 }),
    sources: load('sources', []),
    inbox: { items: load('inbox', []), total: 0, unread: 0, unreadBySource: {} },
    filter: { sourceId: '', unread: false, q: '' },
    seen: load('seen', []),                // response ids already announced on this device
    offline: false
  };

  /* ---------------- API ---------------- */

  function api(action, params) {
    if (!state.conn) return Promise.reject(new Error('Not connected.'));
    var body = Object.assign({ key: state.conn.key, action: action }, params || {});
    return fetch(state.conn.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      redirect: 'follow'
    }).then(function (res) {
      return res.text().then(function (text) {
        var json;
        try { json = JSON.parse(text); } catch (e) {
          throw new Error('The backend did not return data. Check the web app URL and that it is deployed with access "Anyone".');
        }
        if (!json.ok) {
          var err = new Error(json.error || 'Request failed.');
          err.code = json.code;
          throw err;
        }
        state.offline = false;
        setBanner('');
        return json.result;
      });
    }, function (err) {
      state.offline = true;
      setBanner('You appear to be offline — showing saved responses.');
      throw err;
    });
  }

  /* ---------------- Helpers ---------------- */

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var main = $('#main');

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function when(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return String(iso);
    var diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + ' min ago';
    if (diff < 86400) return Math.floor(diff / 3600) + ' h ago';
    if (diff < 86400 * 6) return d.toLocaleDateString(undefined, { weekday: 'short' }) + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  }

  function fullDate(iso) {
    var d = new Date(iso);
    return isNaN(d) ? String(iso || '') : d.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' });
  }

  var toastTimer;
  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 3500);
  }

  function setBanner(msg) {
    var el = $('#banner');
    el.textContent = msg;
    el.hidden = !msg;
  }

  function busy(btn, on) {
    if (!btn) return;
    if (on) {
      btn.dataset.label = btn.innerHTML;
      btn.innerHTML = '<span class="spinner" aria-hidden="true"></span><span>Working…</span>';
      btn.disabled = true;
    } else if (btn.dataset.label) {
      btn.innerHTML = btn.dataset.label;
      btn.disabled = false;
    }
  }

  function fail(err) {
    if (err && err.code === 'auth') {
      toast('The API key was rejected. Reconnect in Settings.');
    } else {
      toast(err && err.message ? err.message : 'Something went wrong.');
    }
  }

  function updateBadge() {
    var n = state.inbox.unread || 0;
    var b = $('#navBadge');
    b.textContent = n > 99 ? '99+' : String(n);
    b.hidden = !n;
    document.title = n ? '(' + n + ') Form Hub' : 'Form Hub';
    if (navigator.setAppBadge) {
      (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(function () {});
    }
  }

  function appUrl() { return location.origin + location.pathname; }

  function b64urlEncode(str) {
    return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64urlDecode(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    return decodeURIComponent(escape(atob(str)));
  }
  function deviceLink() {
    return appUrl() + '#connect=' + b64urlEncode(JSON.stringify({ u: state.conn.url, k: state.conn.key }));
  }

  var ICON = {
    sync: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.7-4.3L4 8M4 4v4h4M4 13a8 8 0 0 0 14.7 4.3L20 16m0 4v-4h-4"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5"/></svg>',
    download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19h14"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    inbox: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 13h4l1.5 3h5L16 13h4M4 13l2.5-8h11L20 13v6H4z"/></svg>'
  };

  /* ---------------- Routing ---------------- */

  function route() {
    var hash = location.hash || '';
    var m = hash.match(/^#connect=(.+)$/);
    if (m) {
      try {
        var c = JSON.parse(b64urlDecode(m[1]));
        if (c.u && c.k) {
          state.conn = { url: c.u, key: c.k };
          save('conn', state.conn);
          toast('This device is now connected.');
        }
      } catch (e) { toast('That setup link is not valid.'); }
      history.replaceState(null, '', appUrl() + '#/inbox');
      hash = '#/inbox';
    }

    var name = (hash.match(/^#\/(\w+)/) || [])[1] || 'inbox';
    if (!state.conn) name = 'connect';

    document.querySelectorAll('#nav a').forEach(function (a) {
      var on = a.dataset.route === name;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    $('#nav').hidden = name === 'connect';

    if (name === 'sources') renderSources();
    else if (name === 'settings') renderSettings();
    else if (name === 'connect') renderConnect();
    else renderInbox();
  }

  /* ---------------- Connect screen ---------------- */

  function renderConnect(errorMsg) {
    main.innerHTML =
      '<div class="connect">' +
      '<div class="panel">' +
      '<h1>Connect Form Hub</h1>' +
      '<p class="muted">Form Hub keeps your Google Form and Sheet responses in a spreadsheet in your own Google Drive. ' +
      'Connect this app to your Form Hub backend to see them here.</p>' +
      (errorMsg ? '<div class="error-box">' + esc(errorMsg) + '</div>' : '') +
      '<form id="connectForm">' +
      '<div class="field"><label for="cUrl">Backend web app URL</label>' +
      '<input id="cUrl" type="url" required placeholder="https://script.google.com/macros/s/…/exec" autocomplete="off">' +
      '<div class="hint">From Apps Script: Deploy → Manage deployments → Web app URL.</div></div>' +
      '<div class="field"><label for="cKey">API key</label>' +
      '<input id="cKey" type="password" required autocomplete="off" spellcheck="false">' +
      '<div class="hint">Shown in the Apps Script log after you run <code>setup</code>.</div></div>' +
      '<button class="btn primary" type="submit">Connect</button>' +
      '</form></div>' +
      '<div class="panel"><h2>Haven\'t set up the backend yet?</h2>' +
      '<p class="small muted">It takes about five minutes and runs free on your Google account. ' +
      'Follow the steps in the <a href="https://github.com/hankperry13-dev/CDExGearRequest#setup" target="_blank" rel="noopener">setup guide</a>. ' +
      'Already connected on another device? Open <b>Alerts &amp; settings → Link another device</b> there and scan the code.</p></div>' +
      '</div>';

    $('#connectForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = e.submitter || $('#connectForm button');
      state.conn = { url: $('#cUrl').value.trim(), key: $('#cKey').value.trim() };
      busy(btn, true);
      api('status').then(function () {
        save('conn', state.conn);
        toast('Connected.');
        location.hash = '#/inbox';
        route();
        refreshAll();
      }).catch(function (err) {
        state.conn = null;
        renderConnect(err.code === 'auth' ? 'That API key is not right.' : err.message);
      });
    });
  }

  /* ---------------- Inbox ---------------- */

  function renderInbox() {
    var f = state.filter;
    main.innerHTML =
      '<div class="page-head"><h1>Inbox</h1><span class="muted small" id="count"></span></div>' +
      '<div class="toolbar">' +
      '<input class="search" type="search" id="q" placeholder="Search responses" aria-label="Search responses" value="' + esc(f.q) + '">' +
      '<label class="check"><input type="checkbox" id="unreadOnly"' + (f.unread ? ' checked' : '') + '> Unread only</label>' +
      '<div class="actions">' +
      '<button class="btn" id="syncBtn" title="Check linked forms and sheets now">' + ICON.sync + '<span>Sync</span></button>' +
      '<button class="btn" id="readAllBtn">' + ICON.check + '<span>Mark all read</span></button>' +
      '<button class="btn" id="csvBtn" title="Download these responses as a CSV file">' + ICON.download + '<span>CSV</span></button>' +
      '</div></div>' +
      '<div class="chips" id="chips" role="group" aria-label="Filter by form"></div>' +
      '<div class="list" id="list"></div>' +
      '<div class="row" style="justify-content:center;margin-top:14px"><button class="btn" id="moreBtn" hidden>Load more</button></div>';

    var qTimer;
    $('#q').addEventListener('input', function (e) {
      clearTimeout(qTimer);
      qTimer = setTimeout(function () { state.filter.q = e.target.value; loadInbox(); }, 300);
    });
    $('#unreadOnly').addEventListener('change', function (e) { state.filter.unread = e.target.checked; loadInbox(); });
    $('#syncBtn').addEventListener('click', function (e) {
      var btn = e.currentTarget;
      busy(btn, true);
      api('syncNow').then(function (r) {
        toast(r.added ? r.added + ' new response' + (r.added === 1 ? '' : 's') : 'Up to date.');
        return loadInbox();
      }).catch(fail).then(function () { busy(btn, false); });
    });
    $('#readAllBtn').addEventListener('click', function (e) {
      var btn = e.currentTarget;
      busy(btn, true);
      api('markRead', { all: true, sourceId: state.filter.sourceId || undefined }).then(function () {
        return loadInbox();
      }).catch(fail).then(function () { busy(btn, false); });
    });
    $('#csvBtn').addEventListener('click', exportCsv);
    $('#moreBtn').addEventListener('click', function (e) { loadInbox(true, e.currentTarget); });
    $('#list').addEventListener('click', function (e) {
      var card = e.target.closest('.card');
      if (card) openDetail(card.dataset.id);
    });
    $('#chips').addEventListener('click', function (e) {
      var chip = e.target.closest('.chip');
      if (!chip) return;
      state.filter.sourceId = chip.dataset.id;
      drawChips();
      loadInbox();
    });

    drawChips();
    drawList();
    loadInbox();
  }

  function drawChips() {
    var el = $('#chips');
    if (!el) return;
    var counts = state.inbox.unreadBySource || {};
    var chips = [{ id: '', name: 'All', n: state.inbox.unread }].concat(state.sources.map(function (s) {
      return { id: s.id, name: s.name, n: counts[s.id] || 0 };
    }));
    el.hidden = state.sources.length < 2;
    el.innerHTML = chips.map(function (c) {
      return '<button class="chip" data-id="' + esc(c.id) + '" aria-pressed="' + (state.filter.sourceId === c.id) + '">' +
        esc(c.name) + (c.n ? '<span class="n">' + c.n + '</span>' : '') + '</button>';
    }).join('');
  }

  function drawList() {
    var el = $('#list');
    if (!el) return;
    var items = state.inbox.items;
    if (!items.length) {
      var noSources = !state.sources.length;
      el.innerHTML = '<div class="empty">' + ICON.inbox +
        (noSources
          ? '<p><b>No forms linked yet.</b></p><p><a class="btn primary" href="#/sources">Link a Google Form or Sheet</a></p>'
          : '<p>No responses ' + (state.filter.q || state.filter.unread || state.filter.sourceId ? 'match these filters.' : 'yet. New submissions will show up here.') + '</p>') +
        '</div>';
    } else {
      el.innerHTML = items.map(function (r) {
        var preview = (r.data || []).slice(0, 3).map(function (p) {
          return '<b>' + esc(p[0]) + ':</b> ' + esc(String(p[1]).slice(0, 140));
        }).join(' · ');
        return '<button class="card' + (r.read ? '' : ' unread') + '" data-id="' + esc(r.id) + '">' +
          '<div class="meta"><span class="src">' + (r.read ? '' : '<span class="sr-only">Unread: </span>') + esc(r.sourceName) + '</span><time datetime="' + esc(r.submittedAt) + '">' + esc(when(r.submittedAt)) + '</time></div>' +
          '<div class="preview">' + (preview || '<span class="muted">(empty response)</span>') + '</div>' +
          '</button>';
      }).join('');
    }
    var count = $('#count');
    if (count) count.textContent = state.inbox.total ? state.inbox.total + ' response' + (state.inbox.total === 1 ? '' : 's') : '';
    var more = $('#moreBtn');
    if (more) more.hidden = items.length >= state.inbox.total;
  }

  function loadInbox(append, btn) {
    var f = state.filter;
    busy(btn, true);
    return api('listResponses', {
      sourceId: f.sourceId || undefined,
      unread: f.unread || undefined,
      q: f.q || undefined,
      limit: PAGE_SIZE,
      offset: append ? state.inbox.items.length : 0
    }).then(function (res) {
      state.inbox.items = append ? state.inbox.items.concat(res.items) : res.items;
      state.inbox.total = res.total;
      state.inbox.unread = res.unread;
      state.inbox.unreadBySource = res.unreadBySource;
      if (!append && !f.sourceId && !f.unread && !f.q) save('inbox', res.items);
      updateBadge();
      drawChips();
      drawList();
    }).catch(function (err) {
      if (!state.offline) fail(err);
      drawList();
    }).then(function () { busy(btn, false); });
  }

  function exportCsv() {
    var items = state.inbox.items;
    if (!items.length) { toast('Nothing to export.'); return; }
    var cols = ['Form', 'Submitted'];
    items.forEach(function (r) {
      (r.data || []).forEach(function (p) { if (cols.indexOf(p[0]) === -1) cols.push(p[0]); });
    });
    var cell = function (v) {
      v = String(v === undefined || v === null ? '' : v);
      if (/^[=+\-@]/.test(v)) v = "'" + v; // keep spreadsheet apps from running it as a formula
      return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    };
    var lines = [cols.map(cell).join(',')].concat(items.map(function (r) {
      var map = {};
      (r.data || []).forEach(function (p) { map[p[0]] = p[1]; });
      map.Form = r.sourceName;
      map.Submitted = new Date(r.submittedAt).toLocaleString();
      return cols.map(function (c) { return cell(map[c]); }).join(',');
    }));
    var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'form-hub-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    if (items.length < state.inbox.total) toast('Exported the ' + items.length + ' responses loaded so far. Use “Load more” to include more.');
  }

  /* ---------------- Response detail ---------------- */

  function openDetail(id) {
    var r = state.inbox.items.find(function (x) { return x.id === id; });
    if (!r) return;
    var dlg = $('#detail');
    var src = state.sources.find(function (s) { return s.id === r.sourceId; });
    dlg.innerHTML =
      '<div class="detail-head"><div class="grow">' +
      '<h2 id="detailTitle">' + esc(r.sourceName) + '</h2>' +
      '<div class="muted small">' + esc(fullDate(r.submittedAt)) + '</div></div>' +
      '<button class="btn small" id="dClose" aria-label="Close">' + ICON.close + '</button></div>' +
      '<div class="detail-body"><dl class="answers">' +
      (r.data || []).map(function (p) {
        var v = String(p[1]);
        var link = /^https?:\/\/\S+$/.test(v) ? '<a href="' + esc(v) + '" target="_blank" rel="noopener">' + esc(v) + '</a>' : esc(v);
        return '<div><dt>' + esc(p[0]) + '</dt><dd>' + (v ? link : '<span class="muted">—</span>') + '</dd></div>';
      }).join('') +
      '</dl></div>' +
      '<div class="detail-actions">' +
      '<button class="btn" id="dCopy">Copy</button>' +
      '<button class="btn" id="dUnread">Mark unread</button>' +
      (src && src.url ? '<a class="btn" href="' + esc(src.url) + '" target="_blank" rel="noopener">Open in Google</a>' : '') +
      '<button class="btn danger" id="dDelete">Delete from hub</button>' +
      '</div>';

    var close = function () { dlg.close(); };
    $('#dClose', dlg).addEventListener('click', close);
    $('#dCopy', dlg).addEventListener('click', function () {
      var text = r.sourceName + '\n' + fullDate(r.submittedAt) + '\n\n' +
        (r.data || []).map(function (p) { return p[0] + ': ' + p[1]; }).join('\n');
      navigator.clipboard.writeText(text).then(function () { toast('Copied.'); }, function () { toast('Copy failed.'); });
    });
    $('#dUnread', dlg).addEventListener('click', function () {
      api('markRead', { ids: [r.id], read: false }).then(function () {
        r.read = false;
        state.inbox.unread++;
        close();
        updateBadge();
        drawList();
      }).catch(fail);
    });
    $('#dDelete', dlg).addEventListener('click', function (e) {
      if (!confirm('Delete this response from Form Hub? The original form or sheet is not changed.')) return;
      busy(e.currentTarget, true);
      api('deleteResponses', { ids: [r.id] }).then(function () {
        close();
        toast('Deleted.');
        loadInbox();
      }).catch(fail);
    });
    dlg.showModal();

    if (!r.read) {
      r.read = true;
      state.inbox.unread = Math.max(0, state.inbox.unread - 1);
      if (state.inbox.unreadBySource[r.sourceId]) state.inbox.unreadBySource[r.sourceId]--;
      updateBadge();
      drawList();
      drawChips();
      api('markRead', { ids: [r.id] }).catch(function () {});
    }
  }

  /* ---------------- Linked forms & sheets ---------------- */

  function renderSources() {
    main.innerHTML =
      '<div class="page-head"><h1>Linked forms &amp; sheets</h1></div>' +
      '<div class="panel"><h2>Link a new one</h2>' +
      '<form id="addForm">' +
      '<div class="field"><label for="srcUrl">Google Form or Google Sheet link</label>' +
      '<div class="row"><input class="grow" id="srcUrl" type="url" required placeholder="https://docs.google.com/forms/d/…/edit">' +
      '<button class="btn primary" type="submit">Link</button></div>' +
      '<div class="hint">For a form, copy the address bar while <b>editing</b> the form (not the share link). ' +
      'For a sheet, open the tab you want and copy the address bar.</div></div>' +
      '<label class="check"><input type="checkbox" id="importExisting" checked> Also import responses that are already there</label>' +
      '</form></div>' +
      '<div class="panel"><h2>Linked</h2><div id="srcList"><p class="muted">Loading…</p></div></div>' +
      '<div class="panel"><h2>Tips</h2><ul class="steps small">' +
      '<li>Link a form <i>or</i> its response sheet — not both — or each submission will show up twice.</li>' +
      '<li>Linking a sheet also catches rows people type in by hand (checked every 5 minutes).</li>' +
      '<li>You need to own or be an editor of whatever you link.</li></ul></div>';

    $('#addForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = $('#addForm button[type=submit]');
      busy(btn, true);
      api('addSource', { url: $('#srcUrl').value.trim(), importExisting: $('#importExisting').checked })
        .then(function (src) {
          toast('Linked “' + src.name + '”.');
          $('#srcUrl').value = '';
          return loadSources();
        }).catch(fail).then(function () { busy(btn, false); });
    });

    $('#srcList').addEventListener('change', function (e) {
      var input = e.target;
      var id = input.closest('[data-id]').dataset.id;
      var change = {};
      change[input.name] = input.checked;
      api('updateSource', Object.assign({ id: id }, change)).then(function (src) {
        toast(input.name === 'notify'
          ? (src.notify ? 'Notifications on for this one.' : 'Notifications off for this one.')
          : (src.enabled ? 'Syncing resumed.' : 'Syncing paused.'));
        replaceSource(src);
      }).catch(function (err) { input.checked = !input.checked; fail(err); });
    });

    $('#srcList').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-action=remove]');
      if (!btn) return;
      var id = btn.closest('[data-id]').dataset.id;
      var src = state.sources.find(function (s) { return s.id === id; });
      if (!confirm('Unlink “' + src.name + '”? Form Hub will stop collecting its responses. The form or sheet itself is not changed.')) return;
      var alsoDelete = confirm('Also delete the ' + src.count + ' response(s) already copied into Form Hub?\n\nOK = delete them, Cancel = keep them.');
      busy(btn, true);
      api('removeSource', { id: id, deleteResponses: alsoDelete }).then(function () {
        toast('Unlinked.');
        if (state.filter.sourceId === id) state.filter.sourceId = '';
        return loadSources();
      }).catch(function (err) { busy(btn, false); fail(err); });
    });

    drawSources();
    loadSources();
  }

  function replaceSource(src) {
    state.sources = state.sources.map(function (s) { return s.id === src.id ? src : s; });
    save('sources', state.sources);
  }

  function loadSources() {
    return api('listSources').then(function (list) {
      state.sources = list;
      save('sources', list);
      drawSources();
      drawChips();
    }).catch(function (err) { if (!state.offline) fail(err); drawSources(); });
  }

  function drawSources() {
    var el = $('#srcList');
    if (!el) return;
    if (!state.sources.length) {
      el.innerHTML = '<p class="muted">Nothing linked yet. Paste a link above to get started.</p>';
      return;
    }
    el.innerHTML = state.sources.map(function (s) {
      return '<div class="source" data-id="' + esc(s.id) + '">' +
        '<div><div class="name"><span class="type">' + esc(s.type) + '</span>' + esc(s.name) + '</div>' +
        '<div class="small muted">' + s.count + ' response' + (s.count === 1 ? '' : 's') +
        (s.lastSyncAt ? ' · checked ' + esc(when(s.lastSyncAt)) : '') + '</div></div>' +
        '<div class="row"><a class="btn small" href="' + esc(s.url) + '" target="_blank" rel="noopener">Open</a>' +
        '<button class="btn small danger" data-action="remove">Unlink</button></div>' +
        '<div class="controls">' +
        '<label class="switch"><input type="checkbox" name="notify"' + (s.notify ? ' checked' : '') + '><span class="track"></span>Notify me</label>' +
        '<label class="switch"><input type="checkbox" name="enabled"' + (s.enabled ? ' checked' : '') + '><span class="track"></span>Collecting</label>' +
        '</div></div>';
    }).join('');
  }

  /* ---------------- Settings ---------------- */

  function renderSettings() {
    var d = state.device;
    var canNotify = 'Notification' in window && 'serviceWorker' in navigator;
    main.innerHTML =
      '<div class="page-head"><h1>Alerts &amp; settings</h1></div>' +

      '<div class="panel"><h2>Notifications for new submissions</h2>' +
      '<p class="small muted">These are sent by your Google account the moment a linked form gets a response, ' +
      'even when this app is closed. Turn notifications on or off for each form under <a href="#/sources">Linked</a>.</p>' +
      '<form id="notifyForm"><fieldset id="notifyFields" disabled style="border:0;padding:0;margin:0">' +

      '<h3>Email</h3>' +
      '<div class="field"><label class="switch"><input type="checkbox" name="emailEnabled"><span class="track"></span>Email me</label></div>' +
      '<div class="field"><label for="emailTo">Send to</label><input id="emailTo" name="emailTo" type="text" placeholder="you@example.com, teammate@example.com">' +
      '<div class="hint">Separate several addresses with commas. Free Google accounts can send about 100 emails a day.</div></div>' +

      '<h3>Phone &amp; desktop push</h3>' +
      '<p class="small muted">Uses the free <a href="https://ntfy.sh" target="_blank" rel="noopener">ntfy</a> app ' +
      '(<a href="https://apps.apple.com/app/ntfy/id1625396347" target="_blank" rel="noopener">iPhone</a>, ' +
      '<a href="https://play.google.com/store/apps/details?id=io.heckel.ntfy" target="_blank" rel="noopener">Android</a>, or any browser). ' +
      'Pick a hard-to-guess topic name, then subscribe to the same topic in the ntfy app. Anyone who knows the topic name can read these alerts.</p>' +
      '<div class="field"><label class="switch"><input type="checkbox" name="ntfyEnabled"><span class="track"></span>Send push notifications</label></div>' +
      '<div class="field"><label for="ntfyTopic">Topic name</label>' +
      '<div class="row"><input class="grow" id="ntfyTopic" name="ntfyTopic" type="text" spellcheck="false" autocomplete="off">' +
      '<button class="btn" type="button" id="genTopic">Generate</button></div>' +
      '<div class="hint" id="ntfyLink"></div></div>' +
      '<details class="field"><summary class="small">Advanced: own ntfy server or access token</summary>' +
      '<div class="field" style="margin-top:10px"><label for="ntfyServer">Server</label><input id="ntfyServer" name="ntfyServer" type="url"></div>' +
      '<div class="field"><label for="ntfyToken">Access token (optional)</label><input id="ntfyToken" name="ntfyToken" type="password" autocomplete="off"></div>' +
      '</details>' +

      '<h3>Chat webhook</h3>' +
      '<p class="small muted">Post to a Slack, Discord or Google Chat channel. Paste the channel\'s incoming-webhook URL.</p>' +
      '<div class="field"><label class="switch"><input type="checkbox" name="webhookEnabled"><span class="track"></span>Post to a webhook</label></div>' +
      '<div class="field"><label for="webhookUrl">Webhook URL</label><input id="webhookUrl" name="webhookUrl" type="url" placeholder="https://hooks.slack.com/services/…"></div>' +

      '<h3>Link in notifications</h3>' +
      '<div class="field"><label for="appUrlField">Open-app link</label><input id="appUrlField" name="appUrl" type="url">' +
      '<div class="hint">Tapping a notification opens this address. Usually the address of this app.</div></div>' +

      '<div class="row"><button class="btn primary" type="submit">Save</button>' +
      '<button class="btn" type="button" id="testBtn">Send a test</button></div>' +
      '</fieldset></form></div>' +

      '<div class="panel"><h2>This device</h2>' +
      (canNotify
        ? '<div class="field"><label class="switch"><input type="checkbox" id="browserNotify"' + (d.browserNotify ? ' checked' : '') + '><span class="track"></span>Show notifications in this browser</label>' +
          '<div class="hint">Works while Form Hub is open or in a background tab. For alerts when it\'s closed, use push or email above.</div></div>'
        : '<p class="small muted">This browser can\'t show notifications. Use push or email above.</p>') +
      '<div class="field"><label for="poll">Check for new responses every</label>' +
      '<select id="poll" style="max-width:200px">' +
      [30, 60, 300, 900].map(function (s) {
        return '<option value="' + s + '"' + (d.pollSeconds === s ? ' selected' : '') + '>' + (s < 60 ? s + ' seconds' : s / 60 + ' minute' + (s === 60 ? '' : 's')) + '</option>';
      }).join('') + '</select></div>' +
      '<p class="small muted" id="installTip"></p></div>' +

      '<div class="panel"><h2>Connection</h2>' +
      '<dl class="status-grid" id="statusGrid"><dt>Status</dt><dd>Loading…</dd></dl>' +
      '<div class="row" style="margin-top:14px">' +
      '<button class="btn" id="linkDevice">Link another device</button>' +
      '<button class="btn danger" id="disconnect">Disconnect this device</button></div>' +
      '<div id="linkBox" hidden style="margin-top:14px">' +
      '<p class="small">Scan this with your phone\'s camera, or open the link on the other device. ' +
      '<b>It contains your API key</b> — only share it with your own devices.</p>' +
      '<div id="qr"></div>' +
      '<div class="row" style="margin-top:10px"><input class="grow" id="linkText" type="text" readonly aria-label="Setup link">' +
      '<button class="btn" id="copyLink">Copy</button></div></div>' +
      '</div>';

    var form = $('#notifyForm');
    var fill = function (s) {
      Object.keys(s).forEach(function (k) {
        var el = form.elements[k];
        if (!el) return;
        if (el.type === 'checkbox') el.checked = !!s[k]; else el.value = s[k] || '';
      });
      if (!s.appUrl) form.elements.appUrl.value = appUrl();
      showNtfyLink();
    };
    var showNtfyLink = function () {
      var topic = form.elements.ntfyTopic.value.trim();
      var server = (form.elements.ntfyServer.value.trim() || 'https://ntfy.sh').replace(/\/+$/, '');
      $('#ntfyLink').innerHTML = topic
        ? 'In the ntfy app tap <b>+</b> and enter <code>' + esc(topic) + '</code>, or open <a href="' + esc(server + '/' + topic) + '" target="_blank" rel="noopener">' + esc(server + '/' + topic) + '</a> in a browser.'
        : '';
    };
    form.elements.ntfyTopic.addEventListener('input', showNtfyLink);
    $('#genTopic').addEventListener('click', function () {
      var bytes = new Uint8Array(9);
      crypto.getRandomValues(bytes);
      form.elements.ntfyTopic.value = 'formhub-' + Array.from(bytes, function (b) { return b.toString(36).padStart(2, '0'); }).join('').slice(0, 14);
      form.elements.ntfyEnabled.checked = true;
      showNtfyLink();
    });

    api('getSettings').then(function (s) {
      fill(s);
      $('#notifyFields').disabled = false;
    }).catch(fail);

    var collect = function () {
      var out = {};
      ['emailEnabled', 'ntfyEnabled', 'webhookEnabled'].forEach(function (k) { out[k] = form.elements[k].checked; });
      ['emailTo', 'ntfyTopic', 'ntfyServer', 'ntfyToken', 'webhookUrl', 'appUrl'].forEach(function (k) { out[k] = form.elements[k].value.trim(); });
      return out;
    };
    var saveSettings = function () { return api('saveSettings', { settings: collect() }); };

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = form.querySelector('button[type=submit]');
      busy(btn, true);
      saveSettings().then(function (s) { fill(s); toast('Saved.'); }).catch(fail).then(function () { busy(btn, false); });
    });
    $('#testBtn').addEventListener('click', function (e) {
      var btn = e.currentTarget;
      busy(btn, true);
      saveSettings().then(function () { return api('testNotification'); }).then(function (r) {
        if (r.errors && r.errors.length) toast('Problem: ' + r.errors.join(' | '));
        else if (!r.sentTo.length) toast('Nothing is turned on yet.');
        else toast('Test sent by ' + r.sentTo.join(', ') + '.');
      }).catch(fail).then(function () { busy(btn, false); });
    });

    var bn = $('#browserNotify');
    if (bn) bn.addEventListener('change', function () {
      if (bn.checked && Notification.permission !== 'granted') {
        Notification.requestPermission().then(function (p) {
          if (p !== 'granted') { bn.checked = false; toast('Notifications are blocked for this site in your browser settings.'); }
          setDevice({ browserNotify: p === 'granted' });
        });
      } else {
        setDevice({ browserNotify: bn.checked });
      }
    });
    $('#poll').addEventListener('change', function (e) { setDevice({ pollSeconds: Number(e.target.value) }); startPolling(); });

    var standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    var ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    $('#installTip').innerHTML = standalone ? 'Form Hub is installed on this device.'
      : ios ? '<b>Install on iPhone/iPad:</b> tap the Share button, then “Add to Home Screen”.'
      : '<b>Install as an app:</b> use your browser\'s menu → “Install app” or “Add to Home screen”.';

    api('status').then(function (s) {
      $('#statusGrid').innerHTML =
        '<dt>Status</dt><dd style="color:var(--ok)">Connected</dd>' +
        '<dt>Google account</dt><dd>' + esc(s.user) + '</dd>' +
        '<dt>Responses stored in</dt><dd><a href="' + esc(s.hubUrl) + '" target="_blank" rel="noopener">Form Hub spreadsheet (Google Drive)</a></dd>' +
        '<dt>Last automatic check</dt><dd>' + (s.lastSyncAt ? esc(fullDate(s.lastSyncAt)) : 'Not yet') + '</dd>' +
        '<dt>Emails left today</dt><dd>' + esc(s.emailQuotaLeft) + '</dd>' +
        (s.lastNotifyError ? '<dt>Last alert problem</dt><dd style="color:var(--danger)">' + esc(s.lastNotifyError) + '</dd>' : '');
    }).catch(function (err) {
      $('#statusGrid').innerHTML = '<dt>Status</dt><dd style="color:var(--danger)">' + esc(err.message) + '</dd>';
    });

    $('#linkDevice').addEventListener('click', function () {
      var box = $('#linkBox');
      box.hidden = !box.hidden;
      if (box.hidden) return;
      var link = deviceLink();
      $('#linkText').value = link;
      loadQrLib().then(function () {
        $('#qr').innerHTML = '';
        new window.QRCode($('#qr'), { text: link, width: 220, height: 220, correctLevel: window.QRCode.CorrectLevel.L });
      }).catch(function () { $('#qr').hidden = true; });
    });
    $('#copyLink').addEventListener('click', function () {
      navigator.clipboard.writeText($('#linkText').value).then(function () { toast('Link copied.'); });
    });
    $('#disconnect').addEventListener('click', function () {
      if (!confirm('Disconnect this device? Your responses stay safe in Google Drive.')) return;
      ['conn', 'inbox', 'sources', 'seen'].forEach(forget);
      state.conn = null;
      state.inbox = { items: [], total: 0, unread: 0, unreadBySource: {} };
      state.sources = [];
      updateBadge();
      location.hash = '#/connect';
      route();
    });
  }

  function setDevice(changes) {
    state.device = Object.assign({}, state.device, changes);
    save('device', state.device);
  }

  var qrPromise;
  function loadQrLib() {
    if (window.QRCode) return Promise.resolve();
    qrPromise = qrPromise || new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
      s.onload = resolve;
      s.onerror = function () { qrPromise = null; reject(); };
      document.head.appendChild(s);
    });
    return qrPromise;
  }

  /* ---------------- Background checking & browser notifications ---------------- */

  var pollTimer;
  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(checkForNew, (state.device.pollSeconds || 60) * 1000);
  }

  function checkForNew() {
    if (!state.conn) return;
    api('listResponses', { unread: true, limit: 20 }).then(function (res) {
      state.inbox.unread = res.unread;
      state.inbox.unreadBySource = res.unreadBySource;
      updateBadge();
      var seen = {};
      state.seen.forEach(function (id) { seen[id] = true; });
      var fresh = res.items.filter(function (r) { return !seen[r.id]; });
      if (!fresh.length) return;

      state.seen = state.seen.concat(fresh.map(function (r) { return r.id; })).slice(-500);
      save('seen', state.seen);
      announce(fresh);

      // Refresh the inbox in place if it's on screen and unfiltered.
      if ($('#list') && !state.filter.q && !$('#detail').open) loadInbox();
    }).catch(function () {});
  }

  function announce(items) {
    if (!state.device.browserNotify || !('Notification' in window) || Notification.permission !== 'granted') return;
    var title = items.length === 1 ? 'New response · ' + items[0].sourceName : items.length + ' new responses';
    var body = items.length === 1
      ? (items[0].data || []).slice(0, 3).map(function (p) { return p[0] + ': ' + p[1]; }).join('\n')
      : items.slice(0, 4).map(function (r) { return r.sourceName; }).join(', ');
    var opts = { body: body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'formhub-new', renotify: true, data: { url: appUrl() + '#/inbox' } };
    navigator.serviceWorker.ready.then(function (reg) {
      return reg.showNotification(title, opts);
    }).catch(function () {
      try { new Notification(title, opts); } catch (e) { /* not supported */ }
    });
  }

  function refreshAll() {
    if (!state.conn) return;
    loadSources();
    // Remember what's already unread so we only announce genuinely new arrivals.
    api('listResponses', { unread: true, limit: 50 }).then(function (res) {
      var ids = res.items.map(function (r) { return r.id; });
      state.seen = Array.from(new Set(state.seen.concat(ids))).slice(-500);
      save('seen', state.seen);
      state.inbox.unread = res.unread;
      updateBadge();
    }).catch(function () {});
  }

  /* ---------------- Start ---------------- */

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
  window.addEventListener('hashchange', route);
  $('#detail').addEventListener('click', function (e) {
    if (e.target === e.currentTarget) e.currentTarget.close(); // tap on the backdrop
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') checkForNew();
  });

  route();
  refreshAll();
  startPolling();
})();
