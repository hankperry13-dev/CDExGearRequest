/**
 * Form Hub — backend (Google Apps Script)
 *
 * Links Google Forms and Google Sheets, copies every new response into one
 * "hub" spreadsheet in your Google Drive, sends notifications, and exposes a
 * small JSON API that the Form Hub web app (phone / laptop) talks to.
 *
 * Setup: paste this file into a new Apps Script project, run `setup` once,
 * then deploy as a web app. Full steps are in the repository README.
 */

var HUB_NAME = 'Form Hub — Responses';
var SYNC_EVERY_MINUTES = 5;
var MAX_DATA_CHARS = 45000; // Sheets cells hold at most 50,000 characters.

var SOURCE_HEADERS = ['id', 'type', 'name', 'url', 'targetId', 'tab', 'enabled', 'notify',
  'cursor', 'addedAt', 'lastSyncAt', 'count'];
var RESPONSE_HEADERS = ['responseId', 'sourceId', 'sourceName', 'submittedAt', 'data', 'read',
  'receivedAt'];

var DEFAULT_SETTINGS = {
  appUrl: '',
  emailEnabled: true,
  emailTo: '',
  ntfyEnabled: false,
  ntfyServer: 'https://ntfy.sh',
  ntfyTopic: '',
  ntfyToken: '',
  webhookEnabled: false,
  webhookUrl: ''
};

/* ------------------------------------------------------------------ */
/* One-time setup                                                      */
/* ------------------------------------------------------------------ */

/** Run this once from the Apps Script editor. Safe to run again. */
function setup() {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('API_KEY');
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
    props.setProperty('API_KEY', key);
  }
  var hub = getHub_();
  ensureSyncTrigger_();
  var settings = getSettings_();
  if (!settings.emailTo) {
    settings.emailTo = Session.getEffectiveUser().getEmail();
    saveSettings_(settings);
  }
  Logger.log('Form Hub is set up.');
  Logger.log('Hub spreadsheet: ' + hub.getUrl());
  Logger.log('API key (paste into the app): ' + key);
  Logger.log('Next: Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone).');
}

/** Generates a new API key. Every device must reconnect afterwards. */
function rotateApiKey() {
  PropertiesService.getScriptProperties().deleteProperty('API_KEY');
  setup();
}

/* ------------------------------------------------------------------ */
/* Web API                                                             */
/* ------------------------------------------------------------------ */

function doGet() {
  return json_({
    ok: true,
    app: 'Form Hub',
    message: 'The Form Hub backend is running. Paste this URL and your API key into the Form Hub app.'
  });
}

/**
 * All app requests arrive here as a JSON body: { key, action, ...params }.
 * The app sends them as text/plain so browsers skip the CORS preflight.
 */
function doPost(e) {
  var req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'Request body is not valid JSON.' });
  }
  var expected = PropertiesService.getScriptProperties().getProperty('API_KEY');
  if (!expected || req.key !== expected) {
    return json_({ ok: false, error: 'Wrong API key.', code: 'auth' });
  }
  try {
    var result = route_(req.action, req);
    return json_({ ok: true, result: result });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function route_(action, req) {
  switch (action) {
    case 'status': return apiStatus_();
    case 'listSources': return listSources_().map(publicSource_);
    case 'listResponses': return apiListResponses_(req);
    case 'addSource': return withLock_(function () { return publicSource_(addSource_(req.url, req.importExisting !== false)); });
    case 'updateSource': return withLock_(function () { return publicSource_(updateSource_(req.id, req)); });
    case 'removeSource': return withLock_(function () { return removeSource_(req.id, !!req.deleteResponses); });
    case 'markRead': return withLock_(function () { return markRead_(req.ids, !!req.all, req.read !== false, req.sourceId); });
    case 'deleteResponses': return withLock_(function () { return deleteResponses_(req.ids || []); });
    case 'syncNow': return { added: syncAll() };
    case 'getSettings': return getSettings_();
    case 'saveSettings': return saveSettings_(req.settings || {});
    case 'testNotification': return testNotification_();
    default: throw new Error('Unknown action: ' + action);
  }
}

function apiStatus_() {
  var props = PropertiesService.getScriptProperties();
  var hub = getHub_();
  return {
    user: Session.getEffectiveUser().getEmail(),
    hubUrl: hub.getUrl(),
    sources: listSources_().length,
    lastSyncAt: props.getProperty('LAST_SYNC_AT') || '',
    lastNotifyError: props.getProperty('LAST_NOTIFY_ERROR') || '',
    emailQuotaLeft: MailApp.getRemainingDailyQuota()
  };
}

function apiListResponses_(req) {
  var rows = readTable_(responsesSheet_());
  var unreadBySource = {};
  var totalUnread = 0;
  rows.forEach(function (r) {
    if (!truthy_(r.read)) {
      unreadBySource[r.sourceId] = (unreadBySource[r.sourceId] || 0) + 1;
      totalUnread++;
    }
  });

  var q = String(req.q || '').toLowerCase().trim();
  var filtered = rows.filter(function (r) {
    if (req.sourceId && r.sourceId !== req.sourceId) return false;
    if (req.unread && truthy_(r.read)) return false;
    if (q && (r.sourceName + ' ' + r.data).toLowerCase().indexOf(q) === -1) return false;
    return true;
  });
  filtered.sort(function (a, b) { return toMillis_(b.submittedAt) - toMillis_(a.submittedAt); });

  var limit = Math.min(Number(req.limit) || 50, 500);
  var offset = Number(req.offset) || 0;
  return {
    total: filtered.length,
    unread: totalUnread,
    unreadBySource: unreadBySource,
    items: filtered.slice(offset, offset + limit).map(function (r) {
      var data;
      try { data = JSON.parse(r.data); } catch (err) { data = [['Response', String(r.data)]]; }
      return {
        id: String(r.responseId),
        sourceId: r.sourceId,
        sourceName: r.sourceName,
        submittedAt: isoDate_(r.submittedAt),
        receivedAt: isoDate_(r.receivedAt),
        read: truthy_(r.read),
        data: data
      };
    })
  };
}

/* ------------------------------------------------------------------ */
/* Sources (linked forms and sheets)                                   */
/* ------------------------------------------------------------------ */

function parseSourceUrl_(input) {
  var url = String(input || '').trim();
  if (!url) throw new Error('Paste a Google Form or Google Sheet link.');
  if (/\/forms\/d\/e\//.test(url) || /forms\.gle\//.test(url)) {
    throw new Error('That is the public link people use to fill out the form. Open the form in ' +
      'edit mode instead and copy that address (it looks like docs.google.com/forms/d/…/edit).');
  }
  var m = url.match(/\/forms\/d\/([a-zA-Z0-9_-]{20,})/);
  if (m) return { type: 'form', targetId: m[1] };
  m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/);
  if (m) {
    var gid = url.match(/[#&?]gid=(\d+)/);
    return { type: 'sheet', targetId: m[1], tab: gid ? gid[1] : '' };
  }
  if (/^[a-zA-Z0-9_-]{20,}$/.test(url)) {
    try { SpreadsheetApp.openById(url); return { type: 'sheet', targetId: url, tab: '' }; } catch (err) {}
    try { FormApp.openById(url); return { type: 'form', targetId: url }; } catch (err) {}
  }
  throw new Error('That does not look like a Google Form or Google Sheet link.');
}

function addSource_(url, importExisting) {
  var parsed = parseSourceUrl_(url);
  var src = {
    id: 'src_' + Utilities.getUuid().slice(0, 8),
    type: parsed.type,
    targetId: parsed.targetId,
    enabled: true,
    notify: true,
    addedAt: new Date(),
    lastSyncAt: '',
    count: 0
  };

  if (parsed.type === 'form') {
    var form = openForm_(parsed.targetId);
    src.name = form.getTitle() || 'Untitled form';
    src.url = form.getEditUrl();
    src.tab = '';
    src.cursor = 0;
  } else {
    var ss = openSpreadsheet_(parsed.targetId);
    var sheet = pickSheet_(ss, parsed.tab);
    src.name = ss.getName() + ' › ' + sheet.getName();
    src.url = ss.getUrl() + '#gid=' + sheet.getSheetId();
    src.tab = String(sheet.getSheetId());
    src.cursor = 1; // header row
  }

  listSources_().forEach(function (s) {
    if (s.type === src.type && s.targetId === src.targetId && String(s.tab) === String(src.tab)) {
      throw new Error('This ' + src.type + ' is already linked as "' + s.name + '".');
    }
  });

  appendObject_(sourcesSheet_(), SOURCE_HEADERS, src);
  ensureSubmitTrigger_(src);
  syncSource_(src, { notify: false, markRead: true, skipExisting: !importExisting });
  return findSource_(src.id);
}

function updateSource_(id, changes) {
  var src = findSource_(id);
  if (!src) throw new Error('Source not found.');
  ['enabled', 'notify'].forEach(function (k) {
    if (typeof changes[k] === 'boolean') src[k] = changes[k];
  });
  if (typeof changes.name === 'string' && changes.name.trim()) src.name = changes.name.trim();
  writeSource_(src);
  return src;
}

function removeSource_(id, deleteResponses) {
  var src = findSource_(id);
  if (!src) throw new Error('Source not found.');
  sourcesSheet_().deleteRow(src._row);

  var stillUsed = listSources_().some(function (s) { return s.targetId === src.targetId; });
  if (!stillUsed) {
    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (t.getHandlerFunction() === 'handleFormSubmit' && t.getTriggerSourceId() === src.targetId) {
        ScriptApp.deleteTrigger(t);
      }
    });
  }
  var removed = 0;
  if (deleteResponses) {
    removed = deleteResponseRows_(function (r) { return r.sourceId === id; });
  }
  return { removed: removed };
}

function ensureSubmitTrigger_(src) {
  var exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'handleFormSubmit' && t.getTriggerSourceId() === src.targetId;
  });
  if (exists) return;
  var builder = ScriptApp.newTrigger('handleFormSubmit');
  if (src.type === 'form') {
    builder.forForm(src.targetId).onFormSubmit().create();
  } else {
    builder.forSpreadsheet(src.targetId).onFormSubmit().create();
  }
}

function ensureSyncTrigger_() {
  var exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'syncAll';
  });
  if (!exists) {
    ScriptApp.newTrigger('syncAll').timeBased().everyMinutes(SYNC_EVERY_MINUTES).create();
  }
}

/* ------------------------------------------------------------------ */
/* Syncing                                                             */
/* ------------------------------------------------------------------ */

/** Installable trigger: fires the moment a linked form gets a submission. */
function handleFormSubmit(e) {
  var targetId = null;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (e && t.getUniqueId() === e.triggerUid) targetId = t.getTriggerSourceId();
  });
  if (!targetId && e && e.source && e.source.getId) targetId = e.source.getId();
  withLock_(function () {
    listSources_().forEach(function (src) {
      if (src.targetId === targetId && truthy_(src.enabled)) {
        syncSource_(src, { notify: true });
      }
    });
  });
}

/**
 * Time-driven trigger (every few minutes) and the app's "Sync now" button.
 * Catches rows typed straight into a sheet and anything a trigger missed.
 */
function syncAll() {
  return withLock_(function () {
    var added = 0;
    listSources_().forEach(function (src) {
      if (!truthy_(src.enabled)) return;
      try {
        added += syncSource_(src, { notify: true });
      } catch (err) {
        console.error('Sync failed for ' + src.name + ': ' + err);
      }
    });
    PropertiesService.getScriptProperties().setProperty('LAST_SYNC_AT', new Date().toISOString());
    return added;
  });
}

/**
 * Copies responses newer than the source's cursor into the hub.
 * Forms: cursor = timestamp (ms) of the newest copied response.
 * Sheets: cursor = last copied row number.
 */
function syncSource_(src, opts) {
  opts = opts || {};
  var fresh = src.type === 'form' ? readFormResponses_(src) : readSheetRows_(src);
  var items = fresh.items;
  src.cursor = fresh.cursor;
  src.lastSyncAt = new Date();

  if (opts.skipExisting) items = [];
  if (items.length) {
    var now = new Date();
    var rows = items.map(function (it) {
      var data = JSON.stringify(it.data);
      if (data.length > MAX_DATA_CHARS) {
        data = JSON.stringify([['Note', 'Response too large to store in full.']]
          .concat(it.data.map(function (p) { return [p[0], String(p[1]).slice(0, 500)]; })))
          .slice(0, MAX_DATA_CHARS);
      }
      return [it.id, src.id, src.name, it.submittedAt, data, !!opts.markRead, now];
    });
    var sheet = responsesSheet_();
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, RESPONSE_HEADERS.length).setValues(rows);
    src.count = (Number(src.count) || 0) + rows.length;
  }
  writeSource_(src);

  if (items.length && opts.notify && truthy_(src.notify)) {
    notify_(src, items);
  }
  return items.length;
}

function readFormResponses_(src) {
  var form = openForm_(src.targetId);
  var since = Number(src.cursor) || 0;
  var responses = since ? form.getResponses(new Date(since)) : form.getResponses();
  var cursor = since;
  var items = [];
  responses.forEach(function (r) {
    var ts = r.getTimestamp();
    if (ts.getTime() <= since) return;
    cursor = Math.max(cursor, ts.getTime());
    var data = [];
    var email = r.getRespondentEmail && r.getRespondentEmail();
    if (email) data.push(['Email', email]);
    r.getItemResponses().forEach(function (ir) {
      data.push([ir.getItem().getTitle() || 'Question', formatAnswer_(ir.getResponse())]);
    });
    items.push({ id: r.getId(), submittedAt: ts, data: data });
  });
  return { items: items, cursor: cursor };
}

function readSheetRows_(src) {
  var ss = openSpreadsheet_(src.targetId);
  var sheet = pickSheet_(ss, src.tab);
  var cursor = Number(src.cursor) || 1;
  var lastRow = sheet.getLastRow();
  if (lastRow < cursor) return { items: [], cursor: Math.max(lastRow, 1) }; // rows were deleted
  if (lastRow === cursor) return { items: [], cursor: cursor };

  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var headers = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
  var range = sheet.getRange(cursor + 1, 1, lastRow - cursor, lastCol);
  var shown = range.getDisplayValues();
  var raw = range.getValues();
  var items = [];
  shown.forEach(function (row, i) {
    if (row.every(function (v) { return v === ''; })) return;
    var submittedAt = null;
    raw[i].forEach(function (v) { if (!submittedAt && v instanceof Date) submittedAt = v; });
    var data = [];
    row.forEach(function (v, c) {
      if (v !== '') data.push([headers[c] || ('Column ' + (c + 1)), v]);
    });
    items.push({ id: src.id + ':' + (cursor + 1 + i), submittedAt: submittedAt || new Date(), data: data });
  });
  return { items: items, cursor: lastRow };
}

function formatAnswer_(answer) {
  if (Array.isArray(answer)) {
    var isGrid = answer.some(Array.isArray); // checkbox grid: one array per row
    return answer.map(function (a) { return Array.isArray(a) ? a.join(', ') : a; })
      .filter(function (a) { return a !== null && a !== ''; }).join(isGrid ? '; ' : ', ');
  }
  return answer === null || answer === undefined ? '' : String(answer);
}

function pickSheet_(ss, tab) {
  var sheets = ss.getSheets();
  if (tab) {
    for (var i = 0; i < sheets.length; i++) {
      if (String(sheets[i].getSheetId()) === String(tab)) return sheets[i];
    }
    throw new Error('That tab no longer exists in "' + ss.getName() + '".');
  }
  for (var j = 0; j < sheets.length; j++) {
    if (sheets[j].getFormUrl()) return sheets[j]; // prefer the "Form Responses" tab
  }
  return sheets[0];
}

/* ------------------------------------------------------------------ */
/* Responses                                                           */
/* ------------------------------------------------------------------ */

function markRead_(ids, all, read, sourceId) {
  var sheet = responsesSheet_();
  var n = sheet.getLastRow() - 1;
  if (n < 1) return { updated: 0 };
  var idCol = sheet.getRange(2, 1, n, 2).getValues(); // responseId, sourceId
  var readRange = sheet.getRange(2, RESPONSE_HEADERS.indexOf('read') + 1, n, 1);
  var readCol = readRange.getValues();
  var wanted = {};
  (ids || []).forEach(function (id) { wanted[String(id)] = true; });
  var updated = 0;
  for (var i = 0; i < n; i++) {
    var match = all ? (!sourceId || idCol[i][1] === sourceId) : wanted[String(idCol[i][0])];
    if (match && truthy_(readCol[i][0]) !== read) {
      readCol[i][0] = read;
      updated++;
    }
  }
  if (updated) readRange.setValues(readCol);
  return { updated: updated };
}

function deleteResponses_(ids) {
  var wanted = {};
  ids.forEach(function (id) { wanted[String(id)] = true; });
  return { removed: deleteResponseRows_(function (r) { return wanted[String(r.responseId)]; }) };
}

function deleteResponseRows_(predicate) {
  var sheet = responsesSheet_();
  var rows = readTable_(sheet).filter(predicate);
  rows.sort(function (a, b) { return b._row - a._row; }); // bottom-up keeps row numbers valid
  rows.forEach(function (r) { sheet.deleteRow(r._row); });
  return rows.length;
}

/* ------------------------------------------------------------------ */
/* Notifications                                                       */
/* ------------------------------------------------------------------ */

function notify_(src, items) {
  var settings = getSettings_();
  var errors = [];
  var title = items.length === 1
    ? 'New response · ' + src.name
    : items.length + ' new responses · ' + src.name;
  var preview = items.slice(0, 3).map(function (it) {
    return it.data.slice(0, 4).map(function (p) {
      return p[0] + ': ' + String(p[1]).slice(0, 120);
    }).join('\n');
  }).join('\n— — —\n');
  if (items.length > 3) preview += '\n…and ' + (items.length - 3) + ' more';

  if (settings.emailEnabled && settings.emailTo) {
    try {
      MailApp.sendEmail({
        to: settings.emailTo,
        subject: title,
        body: preview + (settings.appUrl ? '\n\nOpen Form Hub: ' + settings.appUrl : ''),
        htmlBody: emailHtml_(src, items, settings.appUrl),
        name: 'Form Hub'
      });
    } catch (err) { errors.push('Email: ' + err.message); }
  }

  if (settings.ntfyEnabled && settings.ntfyTopic) {
    try {
      var headers = {};
      if (settings.ntfyToken) headers.Authorization = 'Bearer ' + settings.ntfyToken;
      var payload = { topic: settings.ntfyTopic, title: title, message: preview, tags: ['inbox_tray'] };
      if (settings.appUrl) payload.click = settings.appUrl;
      var res = UrlFetchApp.fetch(String(settings.ntfyServer || 'https://ntfy.sh').replace(/\/+$/, ''), {
        method: 'post', contentType: 'application/json', headers: headers,
        payload: JSON.stringify(payload), muteHttpExceptions: true
      });
      if (res.getResponseCode() >= 300) errors.push('Push (ntfy): HTTP ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200));
    } catch (err) { errors.push('Push (ntfy): ' + err.message); }
  }

  if (settings.webhookEnabled && settings.webhookUrl) {
    try {
      var text = '*' + title + '*\n' + preview + (settings.appUrl ? '\n' + settings.appUrl : '');
      var body;
      if (/discord(app)?\.com\/api\/webhooks/.test(settings.webhookUrl)) body = { content: text.slice(0, 1900) };
      else if (/hooks\.slack\.com|chat\.googleapis\.com/.test(settings.webhookUrl)) body = { text: text };
      else body = { text: text, title: title, source: src.name, responses: items.map(function (it) {
        return { id: it.id, submittedAt: it.submittedAt.toISOString(), data: it.data };
      }) };
      var wres = UrlFetchApp.fetch(settings.webhookUrl, {
        method: 'post', contentType: 'application/json', payload: JSON.stringify(body), muteHttpExceptions: true
      });
      if (wres.getResponseCode() >= 300) errors.push('Webhook: HTTP ' + wres.getResponseCode());
    } catch (err) { errors.push('Webhook: ' + err.message); }
  }

  var props = PropertiesService.getScriptProperties();
  if (errors.length) props.setProperty('LAST_NOTIFY_ERROR', new Date().toISOString() + ' — ' + errors.join(' | '));
  else props.deleteProperty('LAST_NOTIFY_ERROR');
  return errors;
}

function emailHtml_(src, items, appUrl) {
  var esc = function (s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
  };
  var html = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#1f2933">';
  items.slice(0, 10).forEach(function (it) {
    html += '<h3 style="margin:16px 0 6px">' + esc(src.name) + '</h3>' +
      '<div style="color:#616e7c;margin-bottom:8px">' + esc(it.submittedAt.toLocaleString()) + '</div>' +
      '<table cellpadding="6" style="border-collapse:collapse;width:100%;max-width:640px">';
    it.data.forEach(function (p) {
      html += '<tr><td style="border-bottom:1px solid #e4e7eb;font-weight:bold;vertical-align:top;width:35%">' +
        esc(p[0]) + '</td><td style="border-bottom:1px solid #e4e7eb">' + esc(p[1]) + '</td></tr>';
    });
    html += '</table>';
  });
  if (items.length > 10) html += '<p>…and ' + (items.length - 10) + ' more.</p>';
  if (appUrl) {
    html += '<p style="margin-top:20px"><a href="' + esc(appUrl) + '" style="background:#2563eb;color:#fff;' +
      'padding:10px 16px;border-radius:6px;text-decoration:none">Open Form Hub</a></p>';
  }
  return html + '</div>';
}

function testNotification_() {
  var fake = {
    id: 'test', submittedAt: new Date(),
    data: [['Message', 'This is a test notification from Form Hub.'], ['Sent at', new Date().toLocaleString()]]
  };
  var errors = notify_({ name: 'Test' }, [fake]);
  var s = getSettings_();
  return {
    sentTo: [s.emailEnabled && s.emailTo ? 'email' : '', s.ntfyEnabled && s.ntfyTopic ? 'push' : '',
      s.webhookEnabled && s.webhookUrl ? 'webhook' : ''].filter(String),
    errors: errors
  };
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

function getSettings_() {
  var stored = {};
  try { stored = JSON.parse(PropertiesService.getScriptProperties().getProperty('SETTINGS') || '{}'); } catch (err) {}
  var out = {};
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
    out[k] = stored.hasOwnProperty(k) ? stored[k] : DEFAULT_SETTINGS[k];
  });
  return out;
}

function saveSettings_(changes) {
  var current = getSettings_();
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
    if (!changes.hasOwnProperty(k)) return;
    current[k] = typeof DEFAULT_SETTINGS[k] === 'boolean' ? !!changes[k] : String(changes[k]).trim();
  });
  if (current.webhookUrl && !/^https:\/\//.test(current.webhookUrl)) throw new Error('Webhook URL must start with https://');
  if (current.ntfyServer && !/^https?:\/\//.test(current.ntfyServer)) throw new Error('Push server must start with https://');
  PropertiesService.getScriptProperties().setProperty('SETTINGS', JSON.stringify(current));
  return current;
}

/* ------------------------------------------------------------------ */
/* Hub spreadsheet helpers                                             */
/* ------------------------------------------------------------------ */

var hubCache_ = null;

function getHub_() {
  if (hubCache_) return hubCache_;
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('HUB_ID');
  if (id) {
    try { return (hubCache_ = SpreadsheetApp.openById(id)); } catch (err) { /* deleted — recreate below */ }
  }
  var ss = SpreadsheetApp.create(HUB_NAME);
  var first = ss.getSheets()[0];
  first.setName('Responses');
  initSheet_(first, RESPONSE_HEADERS);
  initSheet_(ss.insertSheet('Sources'), SOURCE_HEADERS);
  props.setProperty('HUB_ID', ss.getId());
  return (hubCache_ = ss);
}

function initSheet_(sheet, headers) {
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sheet.setFrozenRows(1);
}

function responsesSheet_() { return getHub_().getSheetByName('Responses'); }
function sourcesSheet_() { return getHub_().getSheetByName('Sources'); }

function readTable_(sheet) {
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2) return [];
  var values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  var headers = values.shift();
  return values.map(function (row, i) {
    var obj = { _row: i + 2 };
    headers.forEach(function (h, c) { obj[h] = row[c]; });
    return obj;
  });
}

function appendObject_(sheet, headers, obj) {
  sheet.appendRow(headers.map(function (h) { return obj[h] === undefined ? '' : obj[h]; }));
}

function listSources_() {
  return readTable_(sourcesSheet_()).map(function (s) {
    s.enabled = truthy_(s.enabled);
    s.notify = truthy_(s.notify);
    s.tab = String(s.tab);
    return s;
  });
}

function findSource_(id) {
  var found = null;
  listSources_().forEach(function (s) { if (s.id === id) found = s; });
  return found;
}

function writeSource_(src) {
  var row = src._row;
  if (!row) {
    var current = findSource_(src.id);
    if (!current) return;
    row = current._row;
  }
  var values = SOURCE_HEADERS.map(function (h) { return src[h] === undefined ? '' : src[h]; });
  sourcesSheet_().getRange(row, 1, 1, values.length).setValues([values]);
}

function publicSource_(s) {
  return {
    id: s.id, type: s.type, name: s.name, url: s.url, enabled: truthy_(s.enabled),
    notify: truthy_(s.notify), count: Number(s.count) || 0,
    addedAt: isoDate_(s.addedAt), lastSyncAt: isoDate_(s.lastSyncAt)
  };
}

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

function openForm_(id) {
  try { return FormApp.openById(id); } catch (err) {
    throw new Error('Could not open that form. Make sure you own it or are an editor.');
  }
}

function openSpreadsheet_(id) {
  try { return SpreadsheetApp.openById(id); } catch (err) {
    throw new Error('Could not open that spreadsheet. Make sure you own it or are an editor.');
  }
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function truthy_(v) { return v === true || v === 'TRUE' || v === 'true' || v === 1; }

function toMillis_(v) {
  if (v instanceof Date) return v.getTime();
  var t = Date.parse(v);
  return isNaN(t) ? 0 : t;
}

function isoDate_(v) {
  if (!v) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
