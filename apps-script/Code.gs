/**
 * Gear Desk — The Studio · Center for Digital Expression
 * Backend (Google Apps Script)
 *
 * Tracks studio gear rentals, keeps inventory counts up to date as gear goes
 * out and comes back, and emails the borrower a branded receipt when a staff
 * member confirms a return.
 *
 * Everything is stored in one Google Sheet ("The Studio — Gear Tracker") in
 * the Google account that deploys this script. The web app (Index.html) is
 * served by this same project, so the team only needs the web app link.
 *
 * Setup: see README.md. In short: paste the files into a new Apps Script
 * project, run `setup` once, then Deploy > New deployment > Web app.
 */

var DB_NAME = 'The Studio — Gear Tracker';

var ITEM_HEADERS = ['id', 'name', 'category', 'assetTag', 'serial', 'totalQty', 'outOfService',
  'checkedOut', 'available', 'location', 'notes', 'archived', 'createdAt', 'updatedAt'];

var RENTAL_HEADERS = ['id', 'status', 'borrowerName', 'borrowerEmail', 'borrowerPhone', 'borrowerGroup',
  'itemsSummary', 'checkedOutAt', 'dueAt', 'checkedOutBy', 'returnedAt', 'returnedBy', 'notes',
  'items', 'returns', 'receiptSentAt', 'lastEmailError', 'updatedAt'];

var LOG_HEADERS = ['at', 'staff', 'action', 'ref', 'details'];

var STATUS = { OUT: 'Out', PARTIAL: 'Partially returned', RETURNED: 'Returned', CANCELLED: 'Cancelled' };

// What staff can record for each returned piece of gear, and what it does to inventory.
var CONDITIONS = {
  'Good': 'back in service',
  'Needs attention': 'back in service, flagged in notes',
  'Damaged': 'moved to out-of-service',
  'Lost': 'removed from inventory'
};

var DEFAULT_SETTINGS = {
  orgName: 'The Studio',
  orgFullName: 'Center for Digital Expression',
  staff: [],
  categories: ['Cameras', 'Lenses', 'Audio', 'Lighting', 'Tripods & Support', 'Computers & Tablets',
    'VR / AR', 'Cables & Adapters', 'Other'],
  defaultLoanDays: 3,
  dueHour: 17,
  replyTo: '',
  receiptCc: '',
  contactLine: '',
  receiptFooter: 'Thanks for borrowing from The Studio! If anything on this receipt looks wrong, just reply to this email.',
  checkoutEmail: true
};

var MAX_CLOSED_RENTALS = 1500; // closed rentals sent to the app; older ones stay in the sheet.

/* ------------------------------------------------------------------ */
/* Setup and web app entry points                                      */
/* ------------------------------------------------------------------ */

/** Run once from the Apps Script editor to approve permissions and create the spreadsheet. */
function setup() {
  var ss = getDb_();
  var settings = getSettings_();
  if (!settings.replyTo) {
    var me = Session.getEffectiveUser().getEmail();
    if (me) saveSettings_({ replyTo: me });
  }
  Logger.log('Gear Desk is set up.');
  Logger.log('Spreadsheet: ' + ss.getUrl());
  Logger.log('Next: Deploy > New deployment > Web app (Execute as: Me).');
}

function doGet() {
  return HtmlService.createTemplateFromFile('Index').evaluate()
    .setTitle('Gear Desk · The Studio')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

/** Used by Index.html to pull in Styles.html and App.html. */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/** Every call from the web app comes through here via google.script.run.api(action, payload). */
function api(action, payload) {
  try {
    return { ok: true, result: route_(action, payload || {}) };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

function route_(action, p) {
  switch (action) {
    case 'bootstrap': return bootstrap_();
    case 'saveItem': return locked_(function () { return saveItem_(p.item || {}, p.staff); });
    case 'setItemArchived': return locked_(function () { return setItemArchived_(p.id, !!p.archived, p.staff); });
    case 'checkout': return locked_(function () { return checkout_(p); });
    case 'confirmReturn': return locked_(function () { return confirmReturn_(p); });
    case 'updateRental': return locked_(function () { return updateRental_(p); });
    case 'cancelRental': return locked_(function () { return cancelRental_(p); });
    case 'resendReceipt': return locked_(function () { return resendReceipt_(p); });
    case 'saveSettings': return locked_(function () { return { settings: saveSettings_(p.settings || {}) }; });
    default: throw new Error('Unknown action: ' + action);
  }
}

function bootstrap_() {
  var snap = snapshot_();
  var quota = -1;
  try { quota = MailApp.getRemainingDailyQuota(); } catch (err) { /* not authorized yet */ }
  snap.me = currentUserEmail_();
  snap.settings = getSettings_();
  snap.conditions = Object.keys(CONDITIONS).map(function (k) { return { name: k, effect: CONDITIONS[k] }; });
  snap.sheetUrl = getDb_().getUrl();
  snap.emailQuota = quota;
  return snap;
}

/* ------------------------------------------------------------------ */
/* Inventory                                                           */
/* ------------------------------------------------------------------ */

function saveItem_(input, staff) {
  var name = clean_(input.name, 120);
  if (!name) throw new Error('Give the item a name.');
  var total = toInt_(input.totalQty, NaN);
  if (!(total >= 0)) throw new Error('Quantity must be 0 or more.');
  var oos = toInt_(input.outOfService, 0);
  if (oos < 0) throw new Error('Out-of-service count can’t be negative.');

  var db = load_();
  var item = input.id ? findBy_(db.items, 'id', input.id) : null;
  if (input.id && !item) throw new Error('That item no longer exists. Refresh and try again.');

  var tag = clean_(input.assetTag, 60);
  if (tag) {
    var clash = db.items.filter(function (it) {
      return it.assetTag && it.assetTag.toLowerCase() === tag.toLowerCase() && (!item || it.id !== item.id);
    })[0];
    if (clash) throw new Error('Asset tag ' + tag + ' is already used by “' + clash.name + '”.');
  }

  var out = item ? item.checkedOut : 0;
  if (total < out + oos) {
    throw new Error(out + ' of this item ' + (out === 1 ? 'is' : 'are') + ' checked out' +
      (oos ? ' and ' + oos + ' out of service' : '') + ', so the total can’t be less than ' + (out + oos) + '.');
  }

  var now = new Date();
  var isNew = !item;
  if (isNew) {
    item = { id: 'itm_' + uuid_(8), createdAt: now, archived: false, checkedOut: 0 };
    db.items.push(item);
  }
  var before = isNew ? null : { totalQty: item.totalQty, outOfService: item.outOfService };
  item.name = name;
  item.category = clean_(input.category, 60);
  item.assetTag = tag;
  item.serial = clean_(input.serial, 80);
  item.totalQty = total;
  item.outOfService = oos;
  item.location = clean_(input.location, 80);
  item.notes = clean_(input.notes, 1000);
  item.updatedAt = now;
  computeCounts_(db);

  if (isNew) appendRow_(db.itemTable, item);
  else writeRow_(db.itemTable, item);
  writeCounts_(db);

  var detail = isNew ? 'Qty ' + total : diffText_(before, item);
  log_(staff, isNew ? 'Added item' : 'Edited item', item.assetTag || item.id, item.name + (detail ? ' · ' + detail : ''));
  return { item: publicItem_(item), snapshot: snapshotFrom_(db) };
}

function setItemArchived_(id, archived, staff) {
  var db = load_();
  var item = findBy_(db.items, 'id', id);
  if (!item) throw new Error('That item no longer exists.');
  if (archived && item.checkedOut > 0) throw new Error('This item is checked out right now. Archive it after it comes back.');
  item.archived = archived;
  item.updatedAt = new Date();
  writeRow_(db.itemTable, item);
  log_(staff, archived ? 'Archived item' : 'Restored item', item.assetTag || item.id, item.name);
  return { snapshot: snapshotFrom_(db) };
}

/* ------------------------------------------------------------------ */
/* Checkout                                                            */
/* ------------------------------------------------------------------ */

function checkout_(p) {
  var borrowerName = clean_(p.borrowerName, 120);
  var borrowerEmail = clean_(p.borrowerEmail, 160).toLowerCase();
  var staff = clean_(p.staff, 80);
  if (!borrowerName) throw new Error('Enter the borrower’s name.');
  if (!isEmail_(borrowerEmail)) throw new Error('Enter a valid email for the borrower so they can get a receipt.');
  if (!staff) throw new Error('Choose who is checking this out.');
  var due = new Date(p.dueAt);
  if (isNaN(due.getTime())) throw new Error('Choose a due date.');
  var now = new Date();
  if (due.getTime() < now.getTime() - 60000) throw new Error('The due date is in the past.');

  var wanted = {};
  (p.items || []).forEach(function (line) {
    var q = toInt_(line.qty, 0);
    if (q > 0) wanted[line.itemId] = (wanted[line.itemId] || 0) + q;
  });
  var ids = Object.keys(wanted);
  if (!ids.length) throw new Error('Add at least one item.');

  var db = load_();
  var lines = ids.map(function (id) {
    var it = findBy_(db.items, 'id', id);
    if (!it || it.archived) throw new Error('One of the items is no longer in inventory. Refresh and try again.');
    if (it.available < wanted[id]) {
      throw new Error(it.available === 0
        ? '“' + it.name + '” isn’t available right now.'
        : 'Only ' + it.available + ' × “' + it.name + '” available.');
    }
    return { itemId: it.id, name: it.name, assetTag: it.assetTag || '', qty: wanted[id], returned: 0, condition: '' };
  });

  var rental = {
    id: nextRentalId_(db),
    status: STATUS.OUT,
    borrowerName: borrowerName,
    borrowerEmail: borrowerEmail,
    borrowerPhone: clean_(p.borrowerPhone, 40),
    borrowerGroup: clean_(p.borrowerGroup, 120),
    checkedOutAt: now,
    dueAt: due,
    checkedOutBy: staff,
    returnedAt: '',
    returnedBy: '',
    notes: clean_(p.notes, 2000),
    items: lines,
    returns: [],
    receiptSentAt: '',
    lastEmailError: '',
    updatedAt: now
  };
  db.rentals.push(rental);
  appendRow_(db.rentalTable, rentalRow_(rental));
  computeCounts_(db);
  writeCounts_(db);
  log_(staff, 'Checked out', rental.id, borrowerName + ' · ' + itemsSummary_(lines));

  var email = null;
  if (p.sendEmail) {
    email = sendEmail_(rental, null);
    if (email.error) {
      rental.lastEmailError = email.error;
      writeRow_(db.rentalTable, rentalRow_(rental));
    }
  }
  return { rental: publicRental_(rental), email: email, snapshot: snapshotFrom_(db) };
}

/* ------------------------------------------------------------------ */
/* Returns                                                             */
/* ------------------------------------------------------------------ */

function confirmReturn_(p) {
  var staff = clean_(p.staff, 80);
  if (!staff) throw new Error('Choose who is checking this in.');
  var db = load_();
  var rental = findBy_(db.rentals, 'id', p.id);
  if (!rental) throw new Error('That rental no longer exists.');
  if (!isActive_(rental)) throw new Error('This rental is already ' + rental.status.toLowerCase() + '.');

  var now = new Date();
  var eventLines = [];
  (p.lines || []).forEach(function (line) {
    var q = toInt_(line.qty, 0);
    if (q <= 0) return;
    var ri = findBy_(rental.items, 'itemId', line.itemId);
    if (!ri) throw new Error('That item is not part of this rental.');
    var outstanding = ri.qty - ri.returned;
    if (q > outstanding) throw new Error('Only ' + outstanding + ' × “' + ri.name + '” still out.');
    var cond = CONDITIONS.hasOwnProperty(line.condition) ? line.condition : 'Good';
    ri.returned += q;
    ri.condition = cond;
    eventLines.push({ itemId: ri.itemId, name: ri.name, assetTag: ri.assetTag, qty: q, condition: cond,
      note: clean_(line.note, 300) });

    var item = findBy_(db.items, 'id', ri.itemId);
    if (item && (cond === 'Damaged' || cond === 'Lost')) {
      if (cond === 'Damaged') item.outOfService += q;
      else item.totalQty = Math.max(0, item.totalQty - q);
      item.updatedAt = now;
      var tagNote = Utilities.formatDate(now, tz_(), 'yyyy-MM-dd') + ': ' + q + ' ' + cond.toLowerCase() +
        ' on return of ' + rental.id + (line.note ? ' — ' + clean_(line.note, 200) : '');
      item.notes = item.notes ? item.notes + '\n' + tagNote : tagNote;
      writeRow_(db.itemTable, item);
    }
  });
  if (!eventLines.length) throw new Error('Choose at least one item that came back.');

  var event = { at: now.toISOString(), by: staff, notes: clean_(p.notes, 2000), lines: eventLines };
  rental.returns.push(event);
  var allBack = rental.items.every(function (ri) { return ri.returned >= ri.qty; });
  rental.status = allBack ? STATUS.RETURNED : STATUS.PARTIAL;
  rental.returnedAt = allBack ? now : '';
  rental.returnedBy = staff;
  rental.updatedAt = now;

  computeCounts_(db);
  writeRow_(db.rentalTable, rentalRow_(rental));
  writeCounts_(db);
  log_(staff, allBack ? 'Returned' : 'Partial return', rental.id, rental.borrowerName + ' · ' + itemsSummary_(eventLines));

  var email = null;
  if (p.sendReceipt !== false) {
    email = sendEmail_(rental, event);
    rental.receiptSentAt = email.sent ? now : rental.receiptSentAt;
    rental.lastEmailError = email.error || '';
    writeRow_(db.rentalTable, rentalRow_(rental));
  }
  return { rental: publicRental_(rental), email: email, snapshot: snapshotFrom_(db) };
}

function resendReceipt_(p) {
  var db = load_();
  var rental = findBy_(db.rentals, 'id', p.id);
  if (!rental) throw new Error('That rental no longer exists.');
  var event = rental.returns.length ? rental.returns[rental.returns.length - 1] : null;
  var email = sendEmail_(rental, event);
  if (email.sent && event) rental.receiptSentAt = new Date();
  rental.lastEmailError = email.error || '';
  writeRow_(db.rentalTable, rentalRow_(rental));
  log_(p.staff, event ? 'Resent receipt' : 'Resent checkout email', rental.id, email.error || 'to ' + email.to);
  return { rental: publicRental_(rental), email: email, snapshot: snapshotFrom_(db) };
}

/* ------------------------------------------------------------------ */
/* Edit / cancel rentals                                               */
/* ------------------------------------------------------------------ */

function updateRental_(p) {
  var db = load_();
  var rental = findBy_(db.rentals, 'id', p.id);
  if (!rental) throw new Error('That rental no longer exists.');
  var changes = [];
  if (p.dueAt !== undefined) {
    if (!isActive_(rental)) throw new Error('This rental is closed, so its due date can’t change.');
    var due = new Date(p.dueAt);
    if (isNaN(due.getTime())) throw new Error('Choose a valid due date.');
    if (toMillis_(rental.dueAt) !== due.getTime()) {
      changes.push('due ' + fmtDate_(due));
      rental.dueAt = due;
    }
  }
  if (p.borrowerEmail !== undefined) {
    var em = clean_(p.borrowerEmail, 160).toLowerCase();
    if (!isEmail_(em)) throw new Error('Enter a valid email address.');
    if (em !== rental.borrowerEmail) { changes.push('email ' + em); rental.borrowerEmail = em; }
  }
  if (p.borrowerPhone !== undefined) rental.borrowerPhone = clean_(p.borrowerPhone, 40);
  if (p.notes !== undefined && clean_(p.notes, 2000) !== rental.notes) {
    rental.notes = clean_(p.notes, 2000);
    changes.push('notes');
  }
  rental.updatedAt = new Date();
  writeRow_(db.rentalTable, rentalRow_(rental));
  if (changes.length) log_(p.staff, 'Updated rental', rental.id, changes.join(', '));
  return { rental: publicRental_(rental), snapshot: snapshotFrom_(db) };
}

function cancelRental_(p) {
  var db = load_();
  var rental = findBy_(db.rentals, 'id', p.id);
  if (!rental) throw new Error('That rental no longer exists.');
  if (rental.status !== STATUS.OUT || rental.returns.length) {
    throw new Error('Only rentals with nothing returned yet can be cancelled. Confirm the return instead.');
  }
  rental.status = STATUS.CANCELLED;
  rental.updatedAt = new Date();
  var reason = clean_(p.reason, 300);
  if (reason) rental.notes = (rental.notes ? rental.notes + '\n' : '') + 'Cancelled: ' + reason;
  computeCounts_(db);
  writeRow_(db.rentalTable, rentalRow_(rental));
  writeCounts_(db);
  log_(p.staff, 'Cancelled rental', rental.id, reason || rental.borrowerName);
  return { rental: publicRental_(rental), snapshot: snapshotFrom_(db) };
}

/* ------------------------------------------------------------------ */
/* Email (receipts and checkout summaries)                             */
/* ------------------------------------------------------------------ */

/** Sends a return receipt (event given) or a checkout summary (event null). Never throws. */
function sendEmail_(rental, event) {
  var settings = getSettings_();
  var to = rental.borrowerEmail;
  if (!isEmail_(to)) return { sent: false, to: to, error: 'No valid borrower email on this rental.' };
  var msg = buildEmail_(rental, event, settings);
  try {
    var opts = {
      to: to,
      subject: msg.subject,
      body: msg.text,
      htmlBody: msg.html,
      name: settings.orgName + ' · ' + settings.orgFullName,
      inlineImages: brandBlobs_()
    };
    if (isEmail_(settings.replyTo)) opts.replyTo = settings.replyTo;
    var cc = splitEmails_(settings.receiptCc);
    if (cc.length) opts.cc = cc.join(',');
    MailApp.sendEmail(opts);
    return { sent: true, to: to, cc: cc };
  } catch (err) {
    return { sent: false, to: to, error: 'Email failed: ' + (err && err.message || err) };
  }
}

function buildEmail_(rental, event, settings) {
  var org = settings.orgName;
  var first = rental.borrowerName.split(/\s+/)[0];
  var isReturn = !!event;
  var outstanding = rental.items.filter(function (ri) { return ri.returned < ri.qty; });
  var subject, eyebrow, headline, intro, rows, meta;

  if (isReturn) {
    var at = new Date(event.at);
    subject = 'Return receipt ' + rental.id + ' · ' + org;
    eyebrow = 'Return receipt';
    headline = outstanding.length ? 'Thanks, ' + first + '! Part of your loan is checked in.'
      : 'Thanks, ' + first + '! Your gear is checked in.';
    intro = 'This is your record of the gear you returned to ' + org + ' on ' + fmtDate_(at) + '.';
    rows = event.lines.map(function (l) { return [l.name, l.assetTag, l.qty, l.condition]; });
    meta = [
      ['Receipt no.', rental.id],
      ['Borrowed', fmtDate_(rental.checkedOutAt)],
      ['Was due', fmtDate_(rental.dueAt)],
      ['Returned', fmtDate_(at)],
      ['Checked in by', event.by]
    ];
  } else {
    subject = 'Your gear checkout ' + rental.id + ' · ' + org;
    eyebrow = 'Checkout summary';
    headline = 'You’re all set, ' + first + '!';
    intro = 'Here’s what you borrowed from ' + org + '. Please bring everything back by the due date below.';
    rows = rental.items.map(function (l) { return [l.name, l.assetTag, l.qty, '']; });
    meta = [
      ['Rental no.', rental.id],
      ['Borrowed', fmtDate_(rental.checkedOutAt)],
      ['Due back', fmtDate_(rental.dueAt)],
      ['Checked out by', rental.checkedOutBy]
    ];
  }

  var C = { plum: '#4D1979', violet: '#854EA7', lilac: '#CCA8E1', gold: '#FED277', cream: '#FDEAB6',
    paper: '#F6F5ED', sky: '#D3EFFF', blue: '#32A8EB', ink: '#231F20', muted: '#6B6470', line: '#E6E1D3' };
  var font = "'Glacial Indifference','Outfit','Helvetica Neue',Arial,sans-serif";
  var head = "'TAN Headline','Archivo Black','Arial Black',Arial,sans-serif";
  var e = esc_;

  var metaHtml = meta.map(function (m) {
    return '<tr><td style="padding:6px 0;color:' + C.muted + ';font-size:13px;width:38%">' + e(m[0]) + '</td>' +
      '<td style="padding:6px 0;font-size:14px;color:' + C.ink + ';font-weight:bold">' + e(m[1]) + '</td></tr>';
  }).join('');

  var itemHtml = rows.map(function (r) {
    var cond = r[3] ? '<span style="display:inline-block;padding:2px 10px;border-radius:99px;font-size:12px;' +
      'background:' + (r[3] === 'Good' ? '#E5F4EC;color:#1F6B45' : r[3] === 'Needs attention' ? C.cream + ';color:#6E4B00' : '#FDECEA;color:#9B1C13') +
      '">' + e(r[3]) + '</span>' : '';
    return '<tr>' +
      '<td style="padding:12px 0;border-top:1px solid ' + C.line + ';font-size:14px;color:' + C.ink + '">' + e(r[0]) +
      (r[1] ? '<div style="font-size:12px;color:' + C.muted + ';margin-top:2px">' + e(r[1]) + '</div>' : '') + '</td>' +
      '<td style="padding:12px 8px;border-top:1px solid ' + C.line + ';font-size:14px;text-align:center;color:' + C.ink + '">' + e(r[2]) + '</td>' +
      (isReturn ? '<td style="padding:12px 0;border-top:1px solid ' + C.line + ';text-align:right">' + cond + '</td>' : '') +
      '</tr>';
  }).join('');

  var stillOut = '';
  if (isReturn && outstanding.length) {
    stillOut = '<tr><td style="padding:8px 32px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" ' +
      'style="background:' + C.cream + ';border-radius:12px"><tr><td style="padding:16px 18px;font-family:' + font + '">' +
      '<div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#6E4B00;font-weight:bold">Still out</div>' +
      '<div style="font-size:14px;color:' + C.ink + ';margin-top:6px;line-height:1.6">' +
      outstanding.map(function (ri) { return e((ri.qty - ri.returned) + ' × ' + ri.name); }).join('<br>') + '</div>' +
      '<div style="font-size:13px;color:' + C.ink + ';margin-top:8px">Due back ' + e(fmtDate_(rental.dueAt)) + '</div>' +
      '</td></tr></table></td></tr>';
  }

  var dueBox = '';
  if (!isReturn) {
    dueBox = '<tr><td style="padding:8px 32px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" ' +
      'style="background:' + C.gold + ';border-radius:12px"><tr><td style="padding:16px 18px;font-family:' + font + '">' +
      '<div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:' + C.plum + ';font-weight:bold">Due back</div>' +
      '<div style="font-family:' + head + ';font-size:20px;color:' + C.plum + ';margin-top:4px">' + e(fmtDate_(rental.dueAt)) + '</div>' +
      '</td></tr></table></td></tr>';
  }

  var notes = isReturn ? event.notes : '';
  var notesHtml = notes ? '<tr><td style="padding:16px 32px 0;font-family:' + font + ';font-size:14px;color:' + C.ink + '">' +
    '<div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:' + C.muted + ';font-weight:bold;margin-bottom:6px">Note from the desk</div>' +
    e(notes).replace(/\n/g, '<br>') + '</td></tr>' : '';

  var html = '<!doctype html><html><head><meta charset="utf-8">' +
    '<link href="https://fonts.googleapis.com/css2?family=Archivo+Black&family=Outfit:wght@400;700&display=swap" rel="stylesheet">' +
    '</head><body style="margin:0;padding:0;background:' + C.paper + '">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + C.paper + '"><tr><td align="center" style="padding:24px 12px">' +
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid ' + C.line + '">' +
    '<tr><td style="background:' + C.plum + ';padding:28px 32px 22px" bgcolor="' + C.plum + '">' +
    '<img src="cid:studioLogo" width="190" alt="' + e(org) + '" style="display:block;width:190px;max-width:60%;height:auto;border:0">' +
    '<div style="font-family:' + font + ';font-size:11px;letter-spacing:3px;text-transform:uppercase;color:' + C.lilac + ';margin-top:12px">' + e(settings.orgFullName) + '</div>' +
    '</td></tr>' +
    '<tr><td style="font-size:0;line-height:0;height:6px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' +
    '<td height="6" style="background:' + C.gold + ';width:50%"></td><td height="6" style="background:' + C.blue + ';width:30%"></td><td height="6" style="background:' + C.lilac + '"></td>' +
    '</tr></table></td></tr>' +
    '<tr><td style="padding:28px 32px 4px;font-family:' + font + '">' +
    '<div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:' + C.violet + ';font-weight:bold">' + e(eyebrow) + '</div>' +
    '<div style="font-family:' + head + ';font-size:24px;line-height:1.25;color:' + C.ink + ';margin:8px 0 10px">' + e(headline) + '</div>' +
    '<div style="font-size:15px;line-height:1.55;color:' + C.ink + '">' + e(intro) + '</div>' +
    '</td></tr>' +
    '<tr><td style="padding:16px 32px 0;font-family:' + font + '"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">' + metaHtml + '</table></td></tr>' +
    '<tr><td style="padding:18px 32px 0;font-family:' + font + '"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">' +
    '<tr><td style="padding:0 0 8px;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:' + C.muted + '">Item</td>' +
    '<td style="padding:0 8px 8px;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:' + C.muted + ';text-align:center;width:48px">Qty</td>' +
    (isReturn ? '<td style="padding:0 0 8px;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:' + C.muted + ';text-align:right;width:140px">Condition</td>' : '') +
    '</tr>' + itemHtml + '</table></td></tr>' +
    stillOut + dueBox + notesHtml +
    '<tr><td style="padding:24px 32px 28px;font-family:' + font + '">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ' + C.line + '"><tr>' +
    '<td style="padding-top:18px;font-size:13px;line-height:1.55;color:' + C.muted + '">' + e(settings.receiptFooter).replace(/\n/g, '<br>') +
    (settings.contactLine ? '<br><span style="color:' + C.ink + '">' + e(settings.contactLine) + '</span>' : '') + '</td>' +
    '<td width="64" style="padding-top:18px;padding-left:12px;vertical-align:top"><img src="cid:cdxBadge" width="56" height="56" alt="" style="display:block;border:0"></td>' +
    '</tr></table></td></tr>' +
    '</table></td></tr></table></body></html>';

  var text = [eyebrow.toUpperCase() + ' — ' + org + ' · ' + settings.orgFullName, '', headline, intro, '']
    .concat(meta.map(function (m) { return m[0] + ': ' + m[1]; }))
    .concat(['', 'Items:'])
    .concat(rows.map(function (r) { return '  ' + r[2] + ' × ' + r[0] + (r[1] ? ' (' + r[1] + ')' : '') + (r[3] ? ' — ' + r[3] : ''); }))
    .concat(isReturn && outstanding.length ? ['', 'Still out (due ' + fmtDate_(rental.dueAt) + '):'].concat(
      outstanding.map(function (ri) { return '  ' + (ri.qty - ri.returned) + ' × ' + ri.name; })) : [])
    .concat(notes ? ['', 'Note from the desk: ' + notes] : [])
    .concat(['', settings.receiptFooter, settings.contactLine]).join('\n');

  return { subject: subject, html: html, text: text };
}

function brandBlobs_() {
  return {
    studioLogo: Utilities.newBlob(Utilities.base64Decode(BRAND_IMAGES.wordmarkWhite), 'image/png', 'the-studio.png'),
    cdxBadge: Utilities.newBlob(Utilities.base64Decode(BRAND_IMAGES.badge), 'image/png', 'cdx-badge.png')
  };
}

/** Used by Index.html for the logo images. */
function brandDataUri(name) {
  return 'data:image/png;base64,' + BRAND_IMAGES[name];
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
  var s = getSettings_();
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
    if (!changes.hasOwnProperty(k)) return;
    var def = DEFAULT_SETTINGS[k], v = changes[k];
    if (Array.isArray(def)) {
      var list = (Array.isArray(v) ? v : String(v || '').split(/\n|,/)).map(function (x) { return clean_(x, 80); })
        .filter(function (x, i, a) { return x && a.indexOf(x) === i; });
      s[k] = list;
    } else if (typeof def === 'boolean') s[k] = !!v;
    else if (typeof def === 'number') s[k] = toInt_(v, def);
    else s[k] = clean_(v, 2000);
  });
  if (!s.orgName) s.orgName = DEFAULT_SETTINGS.orgName;
  if (!s.orgFullName) s.orgFullName = DEFAULT_SETTINGS.orgFullName;
  s.defaultLoanDays = Math.min(Math.max(s.defaultLoanDays, 0), 365);
  s.dueHour = Math.min(Math.max(s.dueHour, 0), 23);
  if (s.replyTo && !isEmail_(s.replyTo)) throw new Error('Reply-to must be a single email address.');
  splitEmails_(s.receiptCc, true);
  PropertiesService.getScriptProperties().setProperty('SETTINGS', JSON.stringify(s));
  return s;
}

/* ------------------------------------------------------------------ */
/* Spreadsheet storage                                                 */
/* ------------------------------------------------------------------ */

var dbCache_ = null;

function getDb_() {
  if (dbCache_) return dbCache_;
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('DB_ID');
  var ss = null;
  if (id) {
    try { ss = SpreadsheetApp.openById(id); } catch (err) { ss = null; /* deleted — recreate below */ }
  }
  if (!ss) {
    ss = SpreadsheetApp.create(DB_NAME);
    ss.getSheets()[0].setName('Inventory');
    ss.insertSheet('Rentals');
    ss.insertSheet('Activity');
    props.setProperty('DB_ID', ss.getId());
  }
  ensureSheet_(ss, 'Inventory', ITEM_HEADERS);
  ensureSheet_(ss, 'Rentals', RENTAL_HEADERS);
  ensureSheet_(ss, 'Activity', LOG_HEADERS);
  return (dbCache_ = ss);
}

/** Creates the tab if needed and adds any missing header columns (keeps columns people added). */
function ensureSheet_(ss, name, headers) {
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  var lastCol = sheet.getLastColumn();
  var existing = lastCol ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String) : [];
  var missing = headers.filter(function (h) { return existing.indexOf(h) === -1; });
  if (missing.length) {
    sheet.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
    sheet.getRange(1, 1, 1, existing.length + missing.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function readTable_(name) {
  var sheet = getDb_().getSheetByName(name);
  var lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
  var values = lastRow ? sheet.getRange(1, 1, lastRow, lastCol).getValues() : [[]];
  var headers = values.shift().map(String);
  var rows = values.map(function (row, i) {
    var o = { _row: i + 2 };
    headers.forEach(function (h, c) { if (h) o[h] = row[c]; });
    return o;
  });
  return { sheet: sheet, headers: headers, rows: rows, lastRow: lastRow };
}

function writeRow_(t, obj) {
  var row = t.headers.map(function (h) { return cellValue_(obj[h]); });
  t.sheet.getRange(obj._row, 1, 1, row.length).setValues([row]);
}

function appendRow_(t, obj) {
  t.lastRow = Math.max(t.lastRow, 1) + 1;
  obj._row = t.lastRow;
  writeRow_(t, obj);
}

function cellValue_(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object' && !(v instanceof Date)) return JSON.stringify(v);
  // Sheets treats written text like typed text: "0012" would become 12, "+1 555…" a formula.
  // A leading apostrophe keeps it exactly as entered (the apostrophe itself isn't stored).
  if (typeof v === 'string' && /^([=+\-@\d]|true$|false$)/i.test(v)) return "'" + v;
  return v;
}

/** Loads inventory + rentals for one request and works out live counts. */
function load_() {
  var it = readTable_('Inventory');
  var items = [];
  it.rows.forEach(function (r) {
    if (!String(r.name || '').trim()) return; // blank row
    if (!r.id) { // a row typed straight into the sheet: give it an id
      r.id = 'itm_' + uuid_(8);
      it.sheet.getRange(r._row, it.headers.indexOf('id') + 1).setValues([[r.id]]);
    }
    r.id = String(r.id);
    r.name = String(r.name).trim();
    ['category', 'assetTag', 'serial', 'location', 'notes'].forEach(function (k) { r[k] = String(r[k] === undefined ? '' : r[k]).trim(); });
    r.totalQty = toInt_(r.totalQty, 1);
    r.outOfService = toInt_(r.outOfService, 0);
    r.archived = truthy_(r.archived);
    items.push(r);
  });

  var rt = readTable_('Rentals');
  var rentals = [];
  rt.rows.forEach(function (r) {
    if (!r.id) return;
    r.id = String(r.id);
    r.items = parseJson_(r.items, []).map(function (l) {
      return { itemId: String(l.itemId), name: String(l.name || ''), assetTag: String(l.assetTag || ''),
        qty: toInt_(l.qty, 0), returned: toInt_(l.returned, 0), condition: String(l.condition || '') };
    });
    r.returns = parseJson_(r.returns, []);
    ['borrowerName', 'borrowerEmail', 'borrowerPhone', 'borrowerGroup', 'checkedOutBy', 'returnedBy', 'notes',
      'lastEmailError', 'status'].forEach(function (k) { r[k] = String(r[k] === undefined ? '' : r[k]); });
    rentals.push(r);
  });

  var db = { items: items, rentals: rentals, itemTable: it, rentalTable: rt };
  computeCounts_(db);
  return db;
}

function computeCounts_(db) {
  var out = {};
  db.rentals.forEach(function (r) {
    if (!isActive_(r)) return;
    r.items.forEach(function (l) {
      var n = l.qty - l.returned;
      if (n > 0) out[l.itemId] = (out[l.itemId] || 0) + n;
    });
  });
  db.items.forEach(function (it) {
    it.checkedOut = out[it.id] || 0;
    it.available = Math.max(0, it.totalQty - it.outOfService - it.checkedOut);
  });
}

/** Writes the live checkedOut / available numbers into the Inventory tab so the sheet stays readable. */
function writeCounts_(db) {
  var t = db.itemTable;
  var n = t.lastRow - 1;
  if (n < 1) return;
  var byRow = {};
  db.items.forEach(function (it) { byRow[it._row] = it; });
  ['checkedOut', 'available'].forEach(function (h) {
    var c = t.headers.indexOf(h);
    if (c === -1) return;
    var col = [];
    for (var r = 2; r <= t.lastRow; r++) col.push([byRow[r] ? byRow[r][h] : '']);
    t.sheet.getRange(2, c + 1, n, 1).setValues(col);
  });
}

function rentalRow_(r) {
  var o = {};
  Object.keys(r).forEach(function (k) { o[k] = r[k]; });
  o.itemsSummary = itemsSummary_(r.items);
  return o;
}

function nextRentalId_(db) {
  var props = PropertiesService.getScriptProperties();
  var n = toInt_(props.getProperty('NEXT_RENTAL_NO'), 1);
  db.rentals.forEach(function (r) {
    var m = String(r.id).match(/(\d+)$/);
    if (m && Number(m[1]) >= n) n = Number(m[1]) + 1;
  });
  props.setProperty('NEXT_RENTAL_NO', String(n + 1));
  return 'CDX-' + ('0000' + n).slice(-4);
}

function log_(staff, action, ref, details) {
  try {
    getDb_().getSheetByName('Activity').appendRow([new Date(), clean_(staff, 80) || currentUserEmail_() || '', action, ref || '', details || '']);
  } catch (err) { /* logging must never break the main action */ }
}

/* ------------------------------------------------------------------ */
/* Snapshots sent to the web app (JSON only — no Date objects)         */
/* ------------------------------------------------------------------ */

function snapshot_() { return snapshotFrom_(load_()); }

function snapshotFrom_(db) {
  var active = [], closed = [];
  db.rentals.forEach(function (r) { (isActive_(r) ? active : closed).push(r); });
  closed.sort(function (a, b) { return toMillis_(b.updatedAt || b.checkedOutAt) - toMillis_(a.updatedAt || a.checkedOutAt); });
  return {
    items: db.items.map(publicItem_),
    rentals: active.concat(closed.slice(0, MAX_CLOSED_RENTALS)).map(publicRental_),
    serverTime: new Date().toISOString()
  };
}

function publicItem_(it) {
  return {
    id: it.id, name: it.name, category: it.category, assetTag: it.assetTag, serial: it.serial,
    totalQty: it.totalQty, outOfService: it.outOfService, checkedOut: it.checkedOut, available: it.available,
    location: it.location, notes: it.notes, archived: !!it.archived
  };
}

function publicRental_(r) {
  return {
    id: r.id, status: r.status, borrowerName: r.borrowerName, borrowerEmail: r.borrowerEmail,
    borrowerPhone: r.borrowerPhone, borrowerGroup: r.borrowerGroup,
    checkedOutAt: isoDate_(r.checkedOutAt), dueAt: isoDate_(r.dueAt), checkedOutBy: r.checkedOutBy,
    returnedAt: isoDate_(r.returnedAt), returnedBy: r.returnedBy, notes: r.notes,
    items: r.items, returns: r.returns, receiptSentAt: isoDate_(r.receiptSentAt),
    lastEmailError: r.lastEmailError, updatedAt: isoDate_(r.updatedAt)
  };
}

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

function isActive_(r) { return r.status === STATUS.OUT || r.status === STATUS.PARTIAL; }

function itemsSummary_(lines) {
  return lines.map(function (l) { return l.qty + '× ' + l.name + (l.assetTag ? ' (' + l.assetTag + ')' : ''); }).join(', ');
}

function diffText_(before, item) {
  var parts = [];
  if (before.totalQty !== item.totalQty) parts.push('qty ' + before.totalQty + ' → ' + item.totalQty);
  if (before.outOfService !== item.outOfService) parts.push('out of service ' + before.outOfService + ' → ' + item.outOfService);
  return parts.join(', ');
}

function findBy_(list, key, value) {
  for (var i = 0; i < list.length; i++) if (String(list[i][key]) === String(value)) return list[i];
  return null;
}

function locked_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function currentUserEmail_() {
  try { return Session.getActiveUser().getEmail() || ''; } catch (err) { return ''; }
}

function tz_() {
  try { return Session.getScriptTimeZone() || 'America/New_York'; } catch (err) { return 'America/New_York'; }
}

function fmtDate_(v) {
  var d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return '';
  return Utilities.formatDate(d, tz_(), "EEE, MMM d, yyyy 'at' h:mm a");
}

function clean_(v, max) {
  return String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u0009\u000B-\u001F]/g, '').trim().slice(0, max || 500);
}

function isEmail_(s) { return /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(String(s || '')); }

function splitEmails_(s, strict) {
  var list = String(s || '').split(/[\s,;]+/).filter(String);
  list.forEach(function (x) { if (strict && !isEmail_(x)) throw new Error('“' + x + '” is not a valid email address.'); });
  return list.filter(isEmail_);
}

function toInt_(v, fallback) {
  if (v === '' || v === null || v === undefined) return fallback;
  var n = Math.floor(Number(v));
  return isNaN(n) ? fallback : n;
}

function truthy_(v) { return v === true || v === 'TRUE' || v === 'true' || v === 1 || v === 'yes'; }

function parseJson_(v, fallback) {
  if (Array.isArray(v)) return v;
  try { var x = JSON.parse(v); return x === null || x === undefined ? fallback : x; } catch (err) { return fallback; }
}

function toMillis_(v) {
  if (v instanceof Date) return v.getTime();
  var t = Date.parse(v);
  return isNaN(t) ? 0 : t;
}

function isoDate_(v) {
  if (!v) return '';
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toISOString();
  var t = Date.parse(v);
  return isNaN(t) ? String(v) : new Date(t).toISOString();
}

function uuid_(n) { return Utilities.getUuid().replace(/-/g, '').slice(0, n); }

function esc_(s) {
  return String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
