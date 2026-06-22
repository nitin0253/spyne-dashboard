# Spyne Production Dashboard

Two files. Deploys to Vercel in 2 minutes.

```
spyne-dashboard/
├── api/
│   └── data.js       ← Vercel serverless function (Google Sheets → analytics JSON)
├── index.html         ← Complete frontend (no build step)
├── package.json
├── vercel.json
└── .gitignore
```

## Deploy to Vercel

### 1. Share sheets with your service account
In each of the 6 Google Sheets, click **Share** and add your service account email as **Viewer**.

### 2. Push to GitHub
```bash
git init
git add .
git commit -m "init"
gh repo create spyne-dashboard --public --push
```

### 3. Import in Vercel
- Go to [vercel.com](https://vercel.com) → **Add New Project** → import the repo
- Framework preset: **Other**

### 4. Add Environment Variables
In Vercel project settings → **Environment Variables**, add:

| Name | Value |
|------|-------|
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | `your-sa@project.iam.gserviceaccount.com` |
| `GOOGLE_PRIVATE_KEY` | The full private key from your JSON credentials file |

For the private key, open your downloaded service account JSON, copy the `private_key` value (including `-----BEGIN...-----END...`), and paste it directly — Vercel handles the newlines.

### 5. Deploy
Click **Deploy**. Done.

---

## Adding a new month

Edit `api/data.js` — add one line to the `SHEETS` array:

```js
{ month: 'Jul-26', key: 'jul26', id: 'YOUR_SHEET_ID' },
```

Redeploy.

---

## Local dev

```bash
npm install -g vercel
vercel dev
# → http://localhost:3000
```

Create a `.env.local` file:
```
GOOGLE_SERVICE_ACCOUNT_EMAIL=...
GOOGLE_PRIVATE_KEY=...
```
