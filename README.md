# Agajay VPS Panel

Professional VPS-style hosting panel. Upload, run and manage server scripts (Python / Node / Bash) directly from a clean web dashboard.

## Owner Login
- **Username:** `Agajayofficial`
- **Password:** `agajay`

The owner has unlimited access (♾️) and can create user accounts with custom expiry days and file upload limits.

## Deploy on Railway

1. Push this repo to GitHub.
2. On [Railway](https://railway.app) → **New Project → Deploy from GitHub** → select this repo.
3. Railway auto-detects `nixpacks.toml` and installs Node.js + Python + pip.
4. Done. Open the generated URL.

## Features

- Owner / user role system
- Per-user expiry (days) and file-upload limits
- Multi-file upload (large files supported)
- Run `python`, `node`, `bash` scripts from the dashboard
- Install modules: `pip install <name>` or `pkg install <name>` (apt)
- Real-time live logs (Server-Sent Events)
- Pricing page built in
- Clean professional dark UI

## Local dev

```bash
npm install
node server.js
# open http://localhost:3000
```

Data persists to `data/users.json` and `data/servers.json`. Uploaded files live in `uploads/<username>/`.
