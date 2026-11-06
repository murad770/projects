# news-digest

Fetches top international headlines from **BBC**, **Reuters**, and **New York Times**
(via their public world/international RSS feeds) and emails a clean digest to a
recipient using **your own SMTP account**.

No news API key is needed. Email is sent through your own mail provider, so your
credentials stay with you — pass them as environment variables, never hardcoded.

## Install

```powershell
npm install
```

## Preview (no email, no credentials)

```powershell
node digest.js --preview
```

This fetches the feeds and prints the digest to the terminal so you can see
exactly what would be sent.

## Send the email

Set your SMTP credentials, then run without `--preview`.

### Yahoo Mail

1. Turn on an **app password**: Yahoo Account Security → "Generate app password".
   (Your normal Yahoo login password will not work for SMTP.)
2. Run:

```powershell
$env:SMTP_HOST = "smtp.mail.yahoo.com"
$env:SMTP_PORT = "465"
$env:SMTP_USER = "your-yahoo-address@yahoo.com"
$env:SMTP_PASS = "your-generated-app-password"
$env:MAIL_TO   = "murad404@yahoo.com"
node digest.js
```

### Gmail

1. Enable 2-step verification, then create an **app password**
   (Google Account → Security → App passwords).
2. Run:

```powershell
$env:SMTP_HOST = "smtp.gmail.com"
$env:SMTP_PORT = "465"
$env:SMTP_USER = "your-gmail-address@gmail.com"
$env:SMTP_PASS = "your-generated-app-password"
$env:MAIL_TO   = "murad404@yahoo.com"
node digest.js
```

## Run it automatically every day (Windows)

For an unattended daily send, the tool reads credentials from a local `.env`
file (never typed, never committed), and a scheduled task runs it each morning.

### 1. Create your `.env`

Copy the example and fill in your real SMTP details:

```powershell
Copy-Item .env.example .env
notepad .env
```

`.env` is gitignored, so your app password stays local. Real environment
variables (if set) always override the file.

### 2. Confirm it sends

```powershell
node digest.js
```

You should receive the digest at `MAIL_TO`. (It also writes `digest.html`.)

### 3. Register the daily task

```powershell
powershell -ExecutionPolicy Bypass -File .\schedule-daily.ps1
```

Defaults to **7:00 AM** daily. Pick another time with:

```powershell
powershell -ExecutionPolicy Bypass -File .\schedule-daily.ps1 -Time "06:30"
```

### 4. Test the scheduled task immediately

```powershell
Start-ScheduledTask -TaskName KiroNewsDigest
Get-Content .\digest.log -Tail 20
```

Each run appends its output to `digest.log` so you can confirm it worked.

### Remove the task later

```powershell
Unregister-ScheduledTask -TaskName KiroNewsDigest -Confirm:$false
```

### How the pieces fit together

- `run-digest.cmd` — the wrapper Task Scheduler runs; it `cd`s into this folder,
  runs `node digest.js --html`, and logs to `digest.log`.
- `schedule-daily.ps1` — registers/updates the Windows scheduled task.
- `.env` — your SMTP credentials and recipient (loaded automatically).

### The daily HTML page

Every daily run also refreshes an HTML page (the `--html` flag in the wrapper).
By default it writes `digest.html` in this folder. To send it somewhere fixed
and easy to bookmark, set `HTML_OUT` in your `.env`:

```
HTML_OUT=C:\Users\hmurad\news\today.html
```

Any missing folders in that path are created automatically, and the same file
is overwritten each day so your bookmark always shows the latest news.

> Note: the task is set to run when you're logged on, so it has normal network
> access. If you need it to run while logged off, open Task Scheduler, find
> **KiroNewsDigest**, and switch it to "Run whether user is logged on or not"
> (Windows will ask for your account password to store the task).

## Configuration

| Variable     | Default               | Meaning                                   |
| ------------ | --------------------- | ----------------------------------------- |
| `MAIL_TO`    | `murad404@yahoo.com`  | recipient address                         |
| `MAIL_FROM`  | same as `SMTP_USER`   | from address                              |
| `SMTP_HOST`  | —                     | SMTP server host                          |
| `SMTP_PORT`  | `465`                 | 465 (SSL) or 587 (STARTTLS)               |
| `SMTP_USER`  | —                     | SMTP username / email                     |
| `SMTP_PASS`  | —                     | SMTP password or app password             |
| `PER_SOURCE` | `10`                  | headlines pulled per outlet before merge  |
| `TOTAL`      | `10`                  | headlines in the final digest             |

## How it works

- Reads each outlet's RSS feed over HTTPS (no scraping).
- A small dependency-free parser extracts headline + link from RSS/Atom items.
- Headlines are interleaved round-robin so the top 10 is a mix of all sources,
  in each outlet's own editorial order.
- `nodemailer` sends a plain-text + HTML email via your SMTP account.

## Note on Reuters links

Reuters no longer publishes a stable public RSS feed, so Reuters headlines are
sourced via a Google News RSS relay filtered to `site:reuters.com`. Google
News article URLs are opaque redirect links that only resolve through
client-side JavaScript, so instead of linking to those, the digest points each
Reuters item at a **reuters.com site search for that headline** — a clean,
durable link that lands you on the story. BBC and NYT link directly to their
own article URLs.
