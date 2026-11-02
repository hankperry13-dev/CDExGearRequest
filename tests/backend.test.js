// Runs apps-script/Code.gs against in-memory Google services:  node tests/backend.test.js
const fs = require('fs'), path = require('path'), vm = require('vm');
const createGasMock = require('./gas-mock');

function boot(opts) {
  const gas = createGasMock(Object.assign({ files: { Brand: fs.readFileSync(path.join(__dirname, '../apps-script/Brand.html'), 'utf8') } }, opts));
  const ctx = Object.assign({ console, Intl }, gas.globals);
  vm.createContext(ctx);
  for (const f of ['Code.gs']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script', f), 'utf8'), ctx, { filename: f });
  }
  const call = (action, payload) => {
    const res = ctx.api(action, payload);
    // google.script.run only passes plain JSON across; make sure nothing else sneaks through.
    if (JSON.stringify(res) !== JSON.stringify(JSON.parse(JSON.stringify(res)))) throw new Error('non-JSON result');
    return res;
  };
  const ok = (action, payload) => {
    const res = call(action, payload);
    if (!res.ok) throw new Error(action + ' failed: ' + res.error);
    return res.result;
  };
  return { gas, ctx, call, ok };
}

let failures = 0;
function check(cond, msg) {
  if (cond) console.log('  ok  ', msg);
  else { failures++; console.error('  FAIL', msg); }
}
const inDays = (d) => new Date(Date.now() + d * 864e5).toISOString();

// ---------------------------------------------------------------------------
console.log('setup + inventory');
const { gas, ctx, call, ok } = boot({ user: 'hank@example.edu' });
ctx.setup();
const ss = gas.db();
check(ss && ss.getSheetByName('Inventory') && ss.getSheetByName('Rentals') && ss.getSheetByName('Activity'), 'spreadsheet created with three tabs');
check(ok('bootstrap').me === 'hank@example.edu', 'bootstrap returns signed-in user');

const cam = ok('saveItem', { staff: 'Hank', item: { name: 'Canon EOS R6', category: 'Cameras', assetTag: '0012', totalQty: 3 } }).item;
const mic = ok('saveItem', { staff: 'Hank', item: { name: 'Rode Wireless GO II', category: 'Audio', totalQty: 2 } }).item;
const tri = ok('saveItem', { staff: 'Hank', item: { name: 'Manfrotto tripod', category: 'Tripods & Support', totalQty: 1 } }).item;
check(cam.available === 3 && cam.assetTag === '0012', 'item saved, asset tag keeps leading zeros');
check(/already used/.test(call('saveItem', { item: { name: 'Dup', assetTag: '0012', totalQty: 1 } }).error), 'duplicate asset tag rejected');
check(/name/.test(call('saveItem', { item: { totalQty: 1 } }).error), 'item needs a name');

// A row typed straight into the sheet gets picked up and given an id.
const inv = ss.getSheetByName('Inventory');
const hdr = inv.data[0];
const typed = hdr.map(h => ({ name: 'HDMI cable', category: 'Cables & Adapters', totalQty: 10 })[h] ?? '');
inv.data.push(typed);
let boot1 = ok('bootstrap');
const hdmi = boot1.items.find(i => i.name === 'HDMI cable');
check(hdmi && /^itm_/.test(hdmi.id) && hdmi.available === 10, 'hand-typed sheet row gets an id and counts');

// ---------------------------------------------------------------------------
console.log('checkout');
check(/email/.test(call('checkout', { borrowerName: 'Ana', borrowerEmail: 'nope', staff: 'Hank', dueAt: inDays(2), items: [{ itemId: cam.id, qty: 1 }] }).error), 'bad email rejected');
check(/Only 3/.test(call('checkout', { borrowerName: 'Ana', borrowerEmail: 'ana@example.edu', staff: 'Hank', dueAt: inDays(2), items: [{ itemId: cam.id, qty: 4 }] }).error), 'cannot overbook');
check(/past/.test(call('checkout', { borrowerName: 'Ana', borrowerEmail: 'ana@example.edu', staff: 'Hank', dueAt: inDays(-1), items: [{ itemId: cam.id, qty: 1 }] }).error), 'past due date rejected');

let co = ok('checkout', {
  borrowerName: 'Ana Ruiz', borrowerEmail: 'Ana@Example.edu', borrowerPhone: '+1 555 0100', borrowerGroup: 'FILM 210',
  staff: 'Hank', dueAt: inDays(2), notes: 'Short film shoot', sendEmail: true,
  items: [{ itemId: cam.id, qty: 2 }, { itemId: mic.id, qty: 1 }, { itemId: tri.id, qty: 1 }]
});
check(co.rental.id === 'CDX-0001' && co.rental.status === 'Out', 'rental created with id CDX-0001');
check(co.rental.borrowerEmail === 'ana@example.edu' && co.rental.borrowerPhone === '+1 555 0100', 'email lower-cased, phone kept as text');
const items1 = Object.fromEntries(co.snapshot.items.map(i => [i.id, i]));
check(items1[cam.id].available === 1 && items1[cam.id].checkedOut === 2 && items1[tri.id].available === 0, 'inventory drops as gear goes out');
check(gas.sent.length === 1 && /checkout CDX-0001/.test(gas.sent[0].subject) && gas.sent[0].to === 'ana@example.edu', 'checkout summary emailed');
check(/isn’t available/.test(call('checkout', { borrowerName: 'Bo', borrowerEmail: 'bo@example.edu', staff: 'Hank', dueAt: inDays(1), items: [{ itemId: tri.id, qty: 1 }] }).error), 'unavailable item blocked');

// sheet columns stay readable
const invRows = ss.getSheetByName('Inventory').data;
const col = h => invRows[0].indexOf(h);
const camRow = invRows.find(r => r[col('id')] === cam.id);
check(camRow[col('checkedOut')] === 2 && camRow[col('available')] === 1, 'sheet shows live checked-out / available');
const rRows = ss.getSheetByName('Rentals').data;
check(/2× Canon EOS R6 \(0012\)/.test(rRows[1][rRows[0].indexOf('itemsSummary')]), 'rental sheet has a readable item summary');

// ---------------------------------------------------------------------------
console.log('partial return + receipt');
const before = gas.sent.length;
let ret = ok('confirmReturn', {
  id: 'CDX-0001', staff: 'Jules', notes: 'Mic was a bit dusty',
  lines: [{ itemId: cam.id, qty: 2, condition: 'Good' }, { itemId: mic.id, qty: 1, condition: 'Damaged', note: 'cracked clip' }]
});
check(ret.rental.status === 'Partially returned', 'partial return keeps rental open');
check(ret.email.sent && gas.sent.length === before + 1, 'receipt emailed on confirmation');
const mail = gas.sent[gas.sent.length - 1];
check(/Return receipt CDX-0001/.test(mail.subject) && /Still out/.test(mail.htmlBody) && /Manfrotto/.test(mail.htmlBody), 'receipt lists what is still out');
check(mail.inlineImages && mail.inlineImages.studioLogo && /cid:studioLogo/.test(mail.htmlBody), 'receipt carries the Studio logo');
check(/Damaged/.test(mail.body) && /Jules/.test(mail.body), 'plain-text receipt has condition and staff');
const items2 = Object.fromEntries(ret.snapshot.items.map(i => [i.id, i]));
check(items2[cam.id].available === 3, 'returned cameras available again');
check(items2[mic.id].outOfService === 1 && items2[mic.id].available === 1 && /cracked clip/.test(items2[mic.id].notes), 'damaged mic moved out of service with a note');
check(/Only 1/.test(call('confirmReturn', { id: 'CDX-0001', staff: 'Jules', lines: [{ itemId: tri.id, qty: 2 }] }).error), 'cannot return more than is out');

console.log('final return');
ret = ok('confirmReturn', { id: 'CDX-0001', staff: 'Jules', lines: [{ itemId: tri.id, qty: 1, condition: 'Good' }] });
check(ret.rental.status === 'Returned' && ret.rental.returnedAt && ret.rental.receiptSentAt, 'rental closed, receipt time stored');
check(!/Still out/.test(gas.sent[gas.sent.length - 1].htmlBody), 'final receipt has nothing still out');
check(/already returned/.test(call('confirmReturn', { id: 'CDX-0001', staff: 'J', lines: [{ itemId: tri.id, qty: 1 }] }).error), 'double return blocked');
check(ok('resendReceipt', { id: 'CDX-0001', staff: 'Hank' }).email.sent, 'receipt can be resent');

// ---------------------------------------------------------------------------
console.log('lost gear, edits, cancel, email failure');
co = ok('checkout', { borrowerName: 'Bo Chen', borrowerEmail: 'bo@example.edu', staff: 'Hank', dueAt: inDays(1), items: [{ itemId: hdmi.id, qty: 3 }] });
check(co.rental.id === 'CDX-0002', 'ids count up');
const newDue = inDays(5);
check(ok('updateRental', { id: 'CDX-0002', dueAt: newDue, staff: 'Hank' }).rental.dueAt === newDue, 'due date extended');
ret = ok('confirmReturn', { id: 'CDX-0002', staff: 'Hank', sendReceipt: false, lines: [{ itemId: hdmi.id, qty: 3, condition: 'Lost' }] });
const hd = ret.snapshot.items.find(i => i.id === hdmi.id);
check(hd.totalQty === 7 && hd.available === 7 && ret.email === null, 'lost gear removed from inventory, receipt skipped when unticked');

co = ok('checkout', { borrowerName: 'Cy', borrowerEmail: 'cy@example.edu', staff: 'Hank', dueAt: inDays(1), items: [{ itemId: cam.id, qty: 1 }] });
check(/checked out/.test(call('saveItem', { item: Object.assign({}, cam, { totalQty: 0 }) }).error), 'total cannot drop below what is out');
check(/checked out right now/.test(call('setItemArchived', { id: cam.id, archived: true }).error), 'cannot archive gear that is out');
const cancelled = ok('cancelRental', { id: co.rental.id, staff: 'Hank', reason: 'entered by mistake' });
check(cancelled.rental.status === 'Cancelled' && cancelled.snapshot.items.find(i => i.id === cam.id).available === 3, 'cancel frees the gear');

gas.setOption('failMail', 'Service invoked too many times');
co = ok('checkout', { borrowerName: 'Di', borrowerEmail: 'di@example.edu', staff: 'Hank', dueAt: inDays(1), items: [{ itemId: cam.id, qty: 1 }] });
ret = ok('confirmReturn', { id: co.rental.id, staff: 'Hank', lines: [{ itemId: cam.id, qty: 1 }] });
check(ret.rental.status === 'Returned' && !ret.email.sent && /too many/.test(ret.rental.lastEmailError), 'email failure still records the return');
gas.setOption('failMail', null);

// ---------------------------------------------------------------------------
console.log('settings + log');
check(/valid email/.test(call('saveSettings', { settings: { receiptCc: 'team@example.edu, nope' } }).error), 'bad cc rejected');
const s = ok('saveSettings', { settings: { staff: 'Hank\nJules\nHank', receiptCc: 'team@example.edu', defaultLoanDays: '7' } }).settings;
check(s.staff.join() === 'Hank,Jules' && s.defaultLoanDays === 7, 'settings saved and cleaned');
ok('checkout', { borrowerName: 'Ed', borrowerEmail: 'ed@example.edu', staff: 'Jules', dueAt: inDays(1), sendEmail: true, items: [{ itemId: mic.id, qty: 1 }] });
check(gas.sent[gas.sent.length - 1].cc === 'team@example.edu', 'team copied on emails');
const act = ss.getSheetByName('Activity').data;
check(act.length > 10 && act.some(r => r[2] === 'Partial return' && r[1] === 'Jules'), 'activity log records who did what');
const b = ok('bootstrap');
check(b.rentals[0].status === 'Out' && b.conditions.length === 4 && b.sheetUrl, 'bootstrap lists open rentals first');

if (failures) { console.error('\n' + failures + ' check(s) failed'); process.exit(1); }
console.log('\nAll backend checks passed.');
