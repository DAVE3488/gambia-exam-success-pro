# Gambia Exam Success - setup and operations

Requires Node 22.5+ (uses built-in `node:sqlite`). No npm packages are needed.
Optional system tools for reading uploaded papers: `pdftotext`, `pdftoppm` (poppler) and `tesseract` (OCR, English only, first 40 pages).

## Run
    node server/index.js          # http://localhost:3000 by default
    npm test                      # API tests
    NODE_PATH=$(npm root -g) node tests/e2e.js   # browser test (needs Playwright + Chromium)

## Create the Chief Admin (jprothereal@gmail.com)
The chief account is never created by registering. Provision it once on the server:

    CHIEF_PASSWORD='choose-a-long-password' node scripts/provision-chief.js
    CHIEF_PASSWORD='new-password' node scripts/provision-chief.js --reset   # reset later

Then log in from the STAFF icon. Admin dashboard: sign in, then open Dashboard (`/#/admin`).

## Environment variables
| Variable | Purpose |
|---|---|
| PORT, HOST | Listen address (default 3000 / 127.0.0.1) |
| DATA_DIR | Where the SQLite database and uploaded files live. **Back this up.** |
| SECURE_COOKIES=1 | Set when served over HTTPS (required in production) |
| TRUST_PROXY=1 | Trust X-Forwarded-For from your reverse proxy (for rate limiting) |
| AI_API_URL, AI_API_KEY, AI_MODEL | Any OpenAI-compatible chat endpoint. Without all three, AI answer drafting and the AI tutor are reported as unavailable (HTTP 503); nothing is faked. |
| SMS_PROVIDER_URL, SMS_API_KEY | Reserved for phone verification. No SMS provider is integrated; verification returns 501. |
| WAVE_API_KEY, WAVE_WEBHOOK_SECRET, APS_API_KEY, APS_WEBHOOK_SECRET | Donation provider credentials (see below) |

## Deployment
Run behind an HTTPS reverse proxy (Caddy, nginx) with SECURE_COOKIES=1 and TRUST_PROXY=1. Keep the process alive with systemd or similar. Use a host with a persistent disk for DATA_DIR. Back up DATA_DIR regularly (stop writes or use `sqlite3 .backup`).

## Donations
Donation records and the D10-D50 / custom amount options exist, and the webhook endpoint verifies an HMAC signature. **The Wave/APS checkout adapter is not implemented**: initiating a payment returns 503 (no credentials) or 501 (adapter missing). A donation is never marked paid without a verified provider confirmation. A developer must implement the provider's checkout call and test the webhook against the real provider before donations can be accepted.

## Known limitations
- No email delivery: password resets are issued by an admin as a link (Inbox).
- Rate limiting is in memory and resets on restart.
- Offline mode covers the app shell and papers a student saved; quizzes need internet.
- No real past papers are bundled. Content must be uploaded, reviewed and approved by staff. Test fixtures are fictional.

## Hosting
No free host keeps a database file between restarts (checked Oct 2026; prices change). Render's free plan is fine for a throwaway demo only: data is wiped on restart. For real use, rent a small server (about $4-6 a month) with a persistent disk.

### Recommended: a small Linux server with Docker (Ubuntu 22.04 or newer)
1. Create the server (DigitalOcean, Hetzner or Scaleway), then connect with `ssh root@SERVER_IP`.
2. Install Docker: `curl -fsSL https://get.docker.com | sh`
3. Copy the project folder to the server (for example `scp -r gambia-exam-success root@SERVER_IP:/opt/`).
4. Build and run:
       cd /opt/gambia-exam-success
       docker build -t ges .
       docker run -d --name ges --restart unless-stopped -p 127.0.0.1:8080:8080 -v ges_data:/data ges
5. Create the Chief Admin: `docker exec -e CHIEF_PASSWORD='your-long-password' ges node scripts/provision-chief.js`
6. Put HTTPS in front (needed, because cookies are Secure). With a domain pointing at the server, the easiest is Caddy:
       apt install -y caddy
       echo 'yourdomain.com { reverse_proxy 127.0.0.1:8080 }' > /etc/caddy/Caddyfile && systemctl reload caddy
7. Open https://yourdomain.com and log in from the STAFF icon.
Back up with: `docker run --rm -v ges_data:/data -v $PWD:/b alpine tar czf /b/ges-backup.tgz /data`

### Fly.io
`fly.toml` is included, but Fly has no free tier after a 7-day trial and needs a card. Steps: `fly launch --no-deploy --copy-config`, `fly volumes create ges_data --size 1`, `fly deploy`, then `fly ssh console -C "env CHIEF_PASSWORD='...' node scripts/provision-chief.js"`.
