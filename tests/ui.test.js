// Drives the web app in Chromium against the real backend code (via the preview build):
//   node tests/ui.test.js            (needs Playwright; screenshots go to dist/screens/)
const path = require('path'), fs = require('fs'), { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const file = path.join(root, 'dist', 'preview.html');
const shots = path.join(root, 'dist', 'screens');
execFileSync(process.execPath, [path.join(root, 'tools', 'build-preview.js'), file], { stdio: 'inherit' });
fs.mkdirSync(shots, { recursive: true });

let failures = 0;
const check = (cond, msg) => { if (cond) console.log('  ok  ', msg); else { failures++; console.error('  FAIL', msg); } };

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g/.test(m.text())) errors.push(m.text()); });
  await page.goto('file://' + file);
  await page.waitForSelector('.rcard');

  console.log('desk');
  check(await page.locator('.rcard').count() === 4, 'four open loans listed');
  check(/Overdue/.test(await page.locator('.rcard').first().textContent()), 'overdue loan sorted first');
  await page.fill('[data-q=desk]', 'priya');
  check(await page.locator('.rcard').count() === 1, 'search filters loans');
  await page.fill('[data-q=desk]', '');

  console.log('checkout');
  await page.click('.tab[data-go=checkout]');
  await page.fill('[name=borrowerName]', 'Jamie Lee');
  await page.fill('[name=borrowerEmail]', 'jamie.lee@example.edu');
  await page.fill('#pickQ', 'gimbal');
  await page.click('.pick [data-act=add]');
  check(await page.locator('.pick [data-act=add]').isDisabled(), 'cannot add more than are free (1 gimbal)');
  await page.fill('#pickQ', 'sd card');
  await page.click('.pick [data-act=add]');
  await page.click('.line [data-act=inc] >> nth=1');
  check((await page.textContent('#cartSummary')).includes('3 pieces'), 'cart counts pieces');
  await page.click('[data-quick="7"]');
  await page.click('#coSubmit');
  await page.waitForSelector('.toast:not([hidden])');
  check(/Add your name/.test(await page.textContent('.toast')), 'staff name required');
  await page.fill('#coStaff', 'Hank');
  await page.click('#coSubmit');
  await page.waitForSelector('.rcard.is-flash');
  check(/CDX-0007 checked out to Jamie Lee · summary emailed/.test(await page.textContent('.toast')), 'checkout confirmed with email');
  check(await page.locator('.rcard').count() === 5, 'new loan on the desk');

  console.log('inventory updates');
  await page.click('.tab[data-go=inventory]');
  await page.fill('[data-q=inv]', 'gimbal');
  check(/All out/.test(await page.textContent('#invList')), 'gimbal now shows all out');
  await page.fill('[data-q=inv]', 'sd card');
  check(/5 available/.test(await page.textContent('#invList')), 'SD cards drop from 7 to 5');

  console.log('return with receipt');
  await page.click('.tab[data-go=desk]');
  await page.fill('[data-q=desk]', 'jamie');
  await page.click('.rcard [data-act=return]');
  await page.waitForSelector('dialog[open] .ret-line');
  await page.click('dialog [data-act=rdec] >> nth=1'); // one SD card stays out
  await page.selectOption('dialog [data-cond] >> nth=0', 'Damaged');
  check(/out of service/.test(await page.textContent('dialog')), 'damage effect explained');
  await page.fill('dialog [data-note]', 'Gimbal motor grinding');
  await page.fill('#retNotes', 'Thanks! One SD card still out.');
  check(/Confirm 2 items back/.test(await page.textContent('[data-act=confirmReturn]')), 'button says partial');
  await page.screenshot({ path: path.join(shots, 'return-dialog.png') });
  await page.click('[data-act=confirmReturn]');
  await page.waitForSelector('dialog .done');
  const done = await page.textContent('dialog');
  check(/Partly checked in/.test(done) && /Still out: 1× SD card/.test(done) && /Receipt emailed/.test(done), 'done screen shows partial + receipt sent');
  await page.screenshot({ path: path.join(shots, 'return-done.png') });
  await page.click('dialog [data-act=close]');

  const sent = await page.evaluate(() => window.__gearDesk.mock.sent.map((m) => ({ to: m.to, subject: m.subject, html: m.htmlBody })));
  check(sent.length === 2 && /Return receipt CDX-0007/.test(sent[1].subject) && sent[1].to === 'jamie.lee@example.edu', 'receipt email sent to borrower');
  check(/Still out/.test(sent[1].html) && /Thanks! One SD card still out/.test(sent[1].html) && /Damaged/.test(sent[1].html), 'receipt content is right');

  await page.click('.tab[data-go=inventory]');
  await page.fill('[data-q=inv]', 'gimbal');
  check(/All out/.test(await page.textContent('#invList')) && /1 in repair|<td class="num hide-sm">1</.test(await page.innerHTML('#invList')), 'damaged gimbal is out of service');

  console.log('finish return, history, outbox');
  await page.click('.tab[data-go=history]');
  await page.fill('[data-q=hist]', 'CDX-0007');
  await page.click('#histList tr[data-act=details]');
  await page.waitForSelector('dialog[open] .timeline');
  check(/Partly back|Partially returned/.test(await page.textContent('dialog')), 'details show partial status');
  await page.click('dialog [data-act=return]');
  await page.click('[data-act=confirmReturn]');
  await page.waitForSelector('dialog .done');
  check(/Return confirmed/.test(await page.textContent('dialog')), 'second return closes the loan');
  await page.click('dialog [data-act=close]');
  check(/Returned/.test(await page.textContent('#histList')), 'history shows returned');

  await page.click('.demo-outbox-btn');
  await page.waitForSelector('.demo-outbox iframe');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, 'receipt-email.png') });
  await page.click('.demo-outbox [data-x]');

  console.log('add item + settings');
  await page.click('.tab[data-go=inventory]');
  await page.click('[data-act=newItem] >> nth=0');
  await page.fill('#itemForm [name=name]', 'Sony A7 IV');
  await page.fill('#itemForm [name=category]', 'Cameras');
  await page.fill('#itemForm [name=assetTag]', '0042');
  await page.fill('#itemForm [name=totalQty]', '2');
  await page.click('[data-act=saveItem]');
  await page.waitForSelector('dialog:not([open])', { state: 'attached' });
  await page.fill('[data-q=inv]', 'a7');
  check(/Tag 0042/.test(await page.textContent('#invList')) && /2 available/.test(await page.textContent('#invList')), 'new item added with its tag');
  await page.click('.tab[data-go=settings]');
  await page.fill('[name=contactLine]', 'Room 210');
  await page.click('#setSubmit');
  const saved = await page.waitForFunction(() => /Settings saved/.test(document.querySelector('.toast').textContent), null, { timeout: 5000 }).then(() => true, () => false);
  check(saved, 'settings save (' + await page.textContent('.toast') + ')');

  console.log('mobile + dark');
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await phone.goto('file://' + file);
  await phone.waitForSelector('.rcard');
  const sw = await phone.evaluate(() => document.documentElement.scrollWidth);
  check(sw <= 390, 'no sideways scrolling on a phone (' + sw + 'px)');
  await phone.screenshot({ path: path.join(shots, 'phone-desk.png') });
  await phone.click('.tab[data-go=inventory]');
  check(await phone.evaluate(() => document.documentElement.scrollWidth) <= 390, 'inventory fits a phone');
  await phone.screenshot({ path: path.join(shots, 'phone-inventory.png') });
  await phone.click('.tab[data-go=checkout]');
  check(await phone.evaluate(() => document.documentElement.scrollWidth) <= 390, 'checkout fits a phone');
  const dark = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
  await dark.goto('file://' + file);
  await dark.waitForSelector('.rcard');
  await dark.screenshot({ path: path.join(shots, 'dark-desk.png') });

  check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  if (failures) { console.error('\n' + failures + ' check(s) failed'); process.exit(1); }
  console.log('\nAll UI checks passed. Screenshots in dist/screens/');
})().catch((e) => { console.error(e); process.exit(1); });
