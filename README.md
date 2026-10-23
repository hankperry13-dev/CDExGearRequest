# Form Hub

Collect Google Forms and Google Sheets responses in one place and open them on your phone or laptop. You can get an alert each time someone submits.

- **Link any number of Google Forms or Sheets.** Paste a link and Form Hub copies every new response into one spreadsheet in your own Google Drive.
- **Use it on any device.** The web app installs on iPhone, Android, Mac and Windows. It has an inbox, search, filters, unread tracking and CSV export, and it works offline with the last responses it saved.
- **Get notified about new submissions** by:
  - **Email**
  - **Phone/desktop push** through the free [ntfy](https://ntfy.sh) app
  - **A Slack / Discord / Google Chat channel**
  - **Browser notifications** while the app is open

  You can turn alerts on or off for each linked form.

Responses never pass through a third-party database. They stay in your Google account, in a spreadsheet called **Form Hub — Responses**.

## How it works

```
Google Form ──submit──▶ Apps Script backend (your Google account)
Google Sheet ─rows───▶   • copies response into "Form Hub — Responses" sheet
                         • sends email / push / webhook alerts
                         • JSON API  ◀──── Form Hub web app (phone & laptop)
```

| Folder / file | What it is |
|---|---|
| `apps-script/Code.gs`, `apps-script/appsscript.json` | Backend. You paste these into Google Apps Script. |
| `index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.webmanifest`, `icons/` | The web app. It is hosted free on GitHub Pages. |
| `tests/backend.test.js` | Tests the backend logic against mocked Google services (`node tests/backend.test.js`). |

## Setup

Setup takes about 10 minutes and only has to be done once.

### 1. Create the backend

1. Go to [script.google.com](https://script.google.com) and click **New project**. Name it `Form Hub`.
2. Replace everything in `Code.gs` with the contents of [`apps-script/Code.gs`](apps-script/Code.gs).
3. Click **Project Settings** (gear icon) and tick **Show "appsscript.json" manifest file in editor**. Go back to the editor, open `appsscript.json` and replace its contents with [`apps-script/appsscript.json`](apps-script/appsscript.json). Change `timeZone` if you're not on US Eastern time.
4. Choose the `setup` function in the toolbar and click **Run**. Approve the permissions when Google asks:
   - If you see "Google hasn't verified this app", click **Advanced → Go to Form Hub**. The script is your own.
5. Open **Execution log** and copy the **API key**. It also contains the link to your new hub spreadsheet.

### 2. Publish the backend as a web app

1. Click **Deploy → New deployment**, then click the gear and choose **Web app**.
2. Set **Execute as:** *Me*.
3. Set **Who has access:** *Anyone*. This is required so the phone app can reach it, and every request still needs your API key.
4. Click **Deploy** and copy the **Web app URL** (it ends in `/exec`).

### 3. Put the app online (GitHub Pages)

1. Merge this branch into `main`.
2. In this GitHub repository, go to **Settings → Pages**.
3. Set **Source:** *Deploy from a branch*, then choose **Branch:** `main` and the `/ (root)` folder. Click **Save**.
4. After a minute the app is live at **https://hankperry13-dev.github.io/CDExGearRequest/**.

### 4. Connect and link your forms

1. Open the app URL on your laptop. Paste the **Web app URL** and **API key**, then click **Connect**.
2. Go to **Linked** and paste a link:
   - **Google Form:** open the form in *edit* mode and copy the address bar (`docs.google.com/forms/d/…/edit`). The `forms.gle` share link won't work.
   - **Google Sheet:** open the tab you want and copy the address bar. Linking a sheet also catches rows typed in by hand, which are checked every 5 minutes.
   - Link a form **or** its response sheet, not both. Linking both makes every submission show up twice.
3. Go to **Alerts & settings** and turn on the alerts you want, then click **Send a test**.

### 5. Add it to your phone

1. On your laptop, open **Alerts & settings → Link another device** and scan the QR code with your phone. Your phone connects without typing anything.
2. Install the app:
   - **iPhone:** tap Share → **Add to Home Screen**.
   - **Android:** use the browser menu → **Install app**.
3. For alerts when the app is closed, install **ntfy** and subscribe to the topic shown in settings. Email alerts also work.

## Updating the backend

After you change `Code.gs`, go to **Deploy → Manage deployments**, click the pencil icon, set **Version: New version**, and click **Deploy**. The URL stays the same.

## Good to know

- **Speed:** Form submissions arrive almost instantly. A background check also runs every 5 minutes, so nothing is missed.
- **Email limits:** Free Google accounts can send about 100 emails a day (Workspace accounts: 1,500). For busy forms, use ntfy push.
- **Who can see your data:**
  - Anyone with your API key can read your responses. Only share the "Link another device" QR code with your own devices.
  - If a key leaks, run `rotateApiKey` in Apps Script and reconnect your devices.
  - Anyone who knows your ntfy topic can read push alerts, so use the **Generate** button to get a hard-to-guess topic.
- **Deleting in Form Hub** only removes the copy in the hub spreadsheet. The original form or sheet is never changed.
