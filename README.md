# Gear Desk — The Studio · Center for Digital Expression

Gear Desk is a web app the Studio team uses to lend out gear. It does three things:

- **Tracks rentals.** You record who borrowed what and when it's due. Overdue loans move to the top of the list.
- **Keeps inventory up to date.** The number of items available goes down when gear is checked out and back up when it's returned. Gear marked damaged moves to *out of service*, and gear marked lost is subtracted from the total.
- **Emails the borrower a receipt when you confirm a return.** The receipt uses Studio branding and lists what came back, the condition of each item, anything still out, and who checked it in. You can also email a checkout summary with the due date when gear goes out.

It runs on Google Apps Script, so it's free and lives in the cloud. Your team opens one web link and signs in with Google. All data is stored in one Google Sheet, **The Studio — Gear Tracker**, which you can open, filter, and export at any time.

The screens and the receipt email follow the Studio's branding sheet: the *The Studio* script logo, the Center for Digital Expression computer badge, the plum/violet/gold/sky palette, and spaced uppercase labels.

## Try it first (no setup)

```bash
node tools/build-preview.js
```

Open `dist/preview.html` in a browser. The preview runs the real app with sample data. Nothing is saved there, and emails appear in a **Demo outbox** instead of being sent.

## What's in this repository

| Path | What it is |
|---|---|
| `apps-script/Code.gs` | Backend code: storage, inventory math, checkouts, returns, and receipt emails |
| `apps-script/Brand.html` | Logo images used by the app and the emails (generated from `brand/`) |
| `apps-script/Index.html`, `Styles.html`, `App.html` | The web app the team uses |
| `apps-script/appsscript.json` | Apps Script settings: permissions and time zone |
| `brand/` | Logo PNGs taken from the branding sheet |
| `tests/` | `backend.test.js` (backend logic) and `ui.test.js` (full browser run-through) |
| `tools/` | `build-preview.js` (the clickable preview) and `build-brand.js` (rebuilds `Brand.html` after a logo change) |

## Setup

Setup takes about 10 minutes and is done once.

> **Use the Studio's shared Google account if you have one.** Receipts are sent from the account that sets this up, and the spreadsheet lives in that account's Drive.

### 1. Create the Apps Script project

1. Go to [script.google.com](https://script.google.com) and click **New project**. Name it `Gear Desk`.
2. Click **Project Settings** (the gear icon) and tick **Show "appsscript.json" manifest file in editor**.
3. Go back to **Editor** and create one project file for each file in `apps-script/`, using the same name, then paste in its contents:
   - **Script** file: `Code`. The editor already has `Code.gs`; replace what's in it.
   - **HTML** files (`+` → *HTML*): `Index`, `Styles`, `App`, `Brand`. Type the name without `.html`. Replace the starter code Apps Script puts in each new file.
   - `Brand.html` is one long block of letters and numbers, which is the logo images. Copy all of it.
   - `appsscript.json`: replace what's in it.
4. In `appsscript.json`, change `timeZone` if the Studio isn't on US Eastern time. It must be a name from [this list](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones), such as `America/Chicago`. Keep the quotes and commas exactly as they are.

### 2. Approve permissions

1. Pick `setup` in the function menu at the top of the editor and click **Run**.
2. Approve the permissions Google asks for: the spreadsheet, sending email as you, and seeing your email address.
   - If you see "Google hasn't verified this app", click **Advanced → Go to Gear Desk**. It's your own script.
3. Open the **Execution log** to find the link to your new spreadsheet.

### 3. Publish the web app

1. Click **Deploy → New deployment**. Click the gear next to *Select type* and choose **Web app**.
2. Set **Execute as:** *Me*.
3. Set **Who has access:**
   - *Anyone within [your organization]* (recommended), or
   - *Anyone with a Google account* for personal Gmail setups.
4. Click **Deploy** and copy the **Web app URL**. This is the link for your team. Bookmark it on the desk computer and share it in your team chat.

### 4. First run

1. Open the link. Go to **Settings** and add:
   - Your team's names
   - The default loan length and due time
   - A reply-to address
   - A contact line (for example, room and hours) for the bottom of receipts
2. Add your gear in **Inventory**, one row per kind of item, with how many you own.

   Already have a list? Paste it into the **Inventory** tab of the spreadsheet. Fill in at least the `name`, `category`, and `totalQty` columns and leave `id` blank. Gear Desk assigns IDs the next time it loads.

## Using it day to day

- **Check out:** Go to **Check out**. Enter the borrower's name and email, tap **+** next to each item, choose a due date, and click **Check out**.
  - Returning borrowers autofill from their last loan.
  - You can't check out more than is on the shelf.
- **Confirm a return:** On **Out now**, click **Confirm return**.
  - Set how many of each item came back and its condition: *Good*, *Needs attention*, *Damaged*, or *Lost*.
  - Add an optional note and confirm. The receipt is emailed right away.
  - If only part of the gear comes back, the loan stays open and shows what's still out.
- **Fix mistakes:** Open **Details** on any loan to change the due date or email, resend the receipt, or cancel a loan entered by mistake.
- **Look things up:** **History** lists every loan. The **Activity** tab in the spreadsheet logs each action with who did it.

## Updating the app

After changing files here, paste the changed files into the Apps Script editor. Then go to **Deploy → Manage deployments**, click the pencil icon, choose **Version: New version**, and click **Deploy**. The link stays the same.

To change a logo, replace the PNG in `brand/`, run `node tools/build-brand.js`, and paste the new `Brand.html`.

## Good to know

- **Email limits:** Google allows about 100 emails a day from a personal account and 1,500 from a Workspace account. **Settings** shows how many are left today.
  - If an email fails, the return is still saved, and you can resend the receipt from the loan's **Details**.
- **Fonts:** The brand fonts (*The Youngest Script*, *Glacial Indifference*, *TAN Headline*) are used on computers that have them installed. Elsewhere, the app uses the free look-alikes *Outfit* and *Archivo Black*. The script logo is an image, so it always looks right.
- **Data:** Don't rename the spreadsheet's tabs or column headers. You can add your own columns, and they're kept.

## Tests

```bash
node tests/backend.test.js
```

```bash
node tests/ui.test.js
```

`ui.test.js` needs Playwright and saves screenshots to `dist/screens/`.
