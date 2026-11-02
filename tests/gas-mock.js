/*
 * In-memory stand-ins for the Google Apps Script services Code.gs uses.
 * Works in Node (tests) and in the browser (the clickable preview).
 *
 *   var gas = createGasMock({ user: 'desk@example.edu' });
 *   // copy gas.globals onto the scope that runs Code.gs
 */
(function (root) {
  'use strict';

  function uuid() {
    if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  // Mimics how Sheets stores values written with setValues (like typed input).
  function store(v) {
    if (typeof v !== 'string') return v;
    if (v.charAt(0) === "'") return v.slice(1);
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    if (/^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
    if (/^[=+]/.test(v)) return '#ERROR!';
    return v;
  }

  function createGasMock(opts) {
    opts = opts || {};
    var files = {}, props = {}, sent = [], log = [];
    var sheetSeq = 1;

    function Range(sheet, r, c, nr, nc) { this.sh = sheet; this.r = r; this.c = c; this.nr = nr || 1; this.nc = nc || 1; }
    Range.prototype.getValues = function () {
      var out = [];
      for (var i = 0; i < this.nr; i++) {
        var row = [];
        for (var j = 0; j < this.nc; j++) {
          var v = (this.sh.data[this.r - 1 + i] || [])[this.c - 1 + j];
          row.push(v === undefined || v === null ? '' : v);
        }
        out.push(row);
      }
      return out;
    };
    Range.prototype.setValues = function (vals) {
      if (vals.length !== this.nr || vals[0].length !== this.nc) throw new Error('Range size mismatch');
      for (var i = 0; i < vals.length; i++) {
        var t = this.sh.data[this.r - 1 + i] || (this.sh.data[this.r - 1 + i] = []);
        for (var j = 0; j < vals[i].length; j++) t[this.c - 1 + j] = store(vals[i][j]);
      }
      for (var k = 0; k < this.sh.data.length; k++) if (!this.sh.data[k]) this.sh.data[k] = [];
      return this;
    };
    Range.prototype.setFontWeight = function () { return this; };

    function Sheet(name) { this.name = name; this.data = []; this.id = sheetSeq++; }
    Sheet.prototype.getName = function () { return this.name; };
    Sheet.prototype.setName = function (n) { this.name = n; return this; };
    Sheet.prototype.getLastRow = function () {
      for (var i = this.data.length; i > 0; i--) {
        if ((this.data[i - 1] || []).some(function (v) { return v !== '' && v !== undefined && v !== null; })) return i;
      }
      return 0;
    };
    Sheet.prototype.getLastColumn = function () {
      return this.data.reduce(function (m, r) {
        for (var i = (r || []).length; i > m; i--) if (r[i - 1] !== '' && r[i - 1] !== undefined) return i;
        return m;
      }, 0);
    };
    Sheet.prototype.getRange = function (r, c, nr, nc) { return new Range(this, r, c, nr, nc); };
    Sheet.prototype.setFrozenRows = function () { return this; };
    Sheet.prototype.appendRow = function (row) {
      var r = this.getLastRow() + 1;
      new Range(this, r, 1, 1, row.length).setValues([row]);
      return this;
    };

    function Spreadsheet(name) {
      this.name = name;
      this.id = 'mock' + uuid().replace(/-/g, '');
      this.sheets = [new Sheet('Sheet1')];
      files[this.id] = this;
    }
    Spreadsheet.prototype.getId = function () { return this.id; };
    Spreadsheet.prototype.getUrl = function () { return 'https://docs.google.com/spreadsheets/d/' + this.id + '/edit'; };
    Spreadsheet.prototype.getSheets = function () { return this.sheets; };
    Spreadsheet.prototype.getSheetByName = function (n) {
      return this.sheets.filter(function (s) { return s.name === n; })[0] || null;
    };
    Spreadsheet.prototype.insertSheet = function (n) { var s = new Sheet(n); this.sheets.push(s); return s; };

    var tz = opts.timeZone || 'America/New_York';

    function formatDate(d, zone, pattern) {
      var parts = {};
      new Intl.DateTimeFormat('en-US', {
        timeZone: zone, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true
      }).formatToParts(d).forEach(function (p) { parts[p.type] = p.value; });
      if (pattern === 'yyyy-MM-dd') {
        var iso = {};
        new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
          .formatToParts(d).forEach(function (p) { iso[p.type] = p.value; });
        return iso.year + '-' + iso.month + '-' + iso.day;
      }
      return parts.weekday + ', ' + parts.month + ' ' + parts.day + ', ' + parts.year + ' at ' +
        parts.hour + ':' + parts.minute + ' ' + parts.dayPeriod;
    }

    var globals = {
      Logger: { log: function (m) { log.push(String(m)); } },
      PropertiesService: {
        getScriptProperties: function () {
          return {
            getProperty: function (k) { return props.hasOwnProperty(k) ? props[k] : null; },
            setProperty: function (k, v) { props[k] = String(v); },
            deleteProperty: function (k) { delete props[k]; }
          };
        }
      },
      SpreadsheetApp: {
        create: function (n) { return new Spreadsheet(n); },
        openById: function (id) { if (!files[id]) throw new Error('Not found'); return files[id]; }
      },
      LockService: { getScriptLock: function () { return { waitLock: function () {}, releaseLock: function () {} }; } },
      MailApp: {
        sendEmail: function (o) {
          if (opts.failMail) throw new Error(opts.failMail);
          sent.push(o);
        },
        getRemainingDailyQuota: function () { return 100 - sent.length; }
      },
      Session: {
        getActiveUser: function () { return { getEmail: function () { return opts.user || ''; } }; },
        getEffectiveUser: function () { return { getEmail: function () { return opts.owner || 'studio@example.edu'; } }; },
        getScriptTimeZone: function () { return tz; }
      },
      Utilities: {
        getUuid: uuid,
        formatDate: formatDate,
        base64Decode: function (b64) { return { b64: b64 }; },
        newBlob: function (bytes, type, name) { return { b64: bytes.b64, type: type, name: name }; }
      },
      HtmlService: {}
    };

    return {
      globals: globals,
      sent: sent,
      props: props,
      files: files,
      log: log,
      setOption: function (k, v) { opts[k] = v; },
      db: function () { return files[props.DB_ID]; }
    };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = createGasMock;
  else root.createGasMock = createGasMock;
})(typeof globalThis !== 'undefined' ? globalThis : this);
