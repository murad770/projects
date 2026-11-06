// news-digest — fetch top international headlines from BBC, Reuters, and NYT,
// then email a clean digest to a recipient via your own SMTP account.
//
// Why RSS? These outlets publish public RSS feeds for their world/international
// sections. We read those directly — no scraping, no news API key, and the feed
// order reflects the outlet's own editorial ordering.
//
// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------
//   Preview in the terminal (no email sent, no credentials needed):
//     node digest.js --preview
//
//   Send the email:
//     node digest.js
//
// ---------------------------------------------------------------------------
// Configuration (environment variables — never hardcode secrets)
// ---------------------------------------------------------------------------
//   MAIL_TO        recipient            (default: murad404@yahoo.com)
//   MAIL_FROM      from address         (default: same as SMTP_USER)
//   SMTP_HOST      e.g. smtp.gmail.com, smtp.mail.yahoo.com
//   SMTP_PORT      e.g. 465 (SSL) or 587 (STARTTLS)   (default: 465)
//   SMTP_USER      your SMTP username / email
//   SMTP_PASS      your SMTP password or app password
//   PER_SOURCE     headlines to pull per outlet before merging (default: 10)
//   TOTAL          headlines in the final digest           (default: 10)
//
// NOTE on Yahoo/Gmail: use an *app password*, not your normal login password.
// Both require generating one in your account's security settings.

const https = require("https");
const path = require("path");
const fs = require("fs");
const nodemailer = require("nodemailer");

// Load a local .env file (if present) into process.env so a scheduled task can
// run unattended without the credentials being typed each time. Tiny, no dep.
// Real environment variables always win over the file.
loadEnvFile(path.join(__dirname, ".env"));

function loadEnvFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return; // no .env file — that's fine
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

const PREVIEW = process.argv.includes("--preview");
// --html writes a standalone HTML page. Optionally "--html some/path.html".
const WRITE_HTML = process.argv.includes("--html");

const MAIL_TO = process.env.MAIL_TO || "murad404@yahoo.com";
const PER_SOURCE = Number(process.env.PER_SOURCE || 10);
const TOTAL = Number(process.env.TOTAL || 10);
const HTML_OUT = resolveHtmlOutPath();

/**
 * Decide where to write the HTML page. Precedence:
 *   1. a path given right after --html on the command line
 *   2. the HTML_OUT environment variable (set once in .env for the daily task)
 *   3. digest.html in this folder
 * Relative paths resolve against this script's folder.
 */
function resolveHtmlOutPath() {
  const i = process.argv.indexOf("--html");
  const argPath = i !== -1 ? process.argv[i + 1] : null;
  const chosen =
    (argPath && !argPath.startsWith("--") && argPath) ||
    (process.env.HTML_OUT && process.env.HTML_OUT.trim()) ||
    "digest.html";
  return path.isAbsolute(chosen) ? chosen : path.join(__dirname, chosen);
}

// Public RSS feeds for each outlet's world/international section.
const FEEDS = [
  { source: "BBC", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  // Reuters no longer publishes a stable public RSS feed of its own, so we use
  // Google News as a Reuters-sourced relay for world news (site:reuters.com).
  { source: "Reuters", url: "https://news.google.com/rss/search?q=world%20when:1d%20site:reuters.com&hl=en-US&gl=US&ceid=US:en" },
  { source: "New York Times", url: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml" },
];

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/** GET a URL and resolve with the body text. Follows one level of redirects. */
function fetchText(url, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          // Some feeds reject requests without a User-Agent.
          "User-Agent":
            "Mozilla/5.0 (news-digest; +https://kiro.dev) Node.js RSS reader",
          Accept: "application/rss+xml, application/xml, text/xml, */*",
        },
        timeout: 15000,
      },
      (res) => {
        const { statusCode, headers } = res;
        if (
          statusCode >= 300 &&
          statusCode < 400 &&
          headers.location &&
          redirectsLeft > 0
        ) {
          res.resume(); // drain
          const next = new URL(headers.location, url).toString();
          resolve(fetchText(next, redirectsLeft - 1));
          return;
        }
        if (statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${statusCode} for ${url}`));
          return;
        }
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      }
    );
    req.on("timeout", () => req.destroy(new Error(`Timeout for ${url}`)));
    req.on("error", reject);
  });
}

/**
 * Turn a Google-News-relayed Reuters link into a clean reuters.com URL.
 *
 * Reuters no longer offers a public RSS feed, so Reuters items arrive via a
 * Google News relay whose article URLs are opaque redirect links that only
 * resolve through client-side JavaScript (not a plain HTTP redirect). Rather
 * than depend on that brittle, rate-limited unwrap, we point the reader at a
 * Reuters site search for the headline — always a valid reuters.com URL that
 * lands on the story.
 *
 * @param {string} url    the (possibly Google News) article URL
 * @param {string} title  the headline, used to build the search link
 */
function resolveLink(url, title) {
  if (!/news\.google\.com/i.test(url)) return url; // BBC/NYT already direct

  // Strip a trailing " - Reuters" the relay appends, then search Reuters.
  const query = String(title || "")
    .replace(/\s*-\s*Reuters\s*$/i, "")
    .trim();
  if (!query) return url;
  return `https://www.reuters.com/site-search/?query=${encodeURIComponent(query)}`;
}

// ---------------------------------------------------------------------------
// Parsing (tiny, dependency-free RSS/Atom extraction)
// ---------------------------------------------------------------------------

/** Decode the handful of XML entities that show up in headlines. */
function decodeEntities(str) {
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .trim();
}

/** Pull the first tag's inner text from an item block. */
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decodeEntities(m[1]) : "";
}

/** Extract items from an RSS (<item>) or Atom (<entry>) feed. */
function parseFeed(xml, source, limit) {
  const isAtom = /<entry[\s>]/i.test(xml) && !/<item[\s>]/i.test(xml);
  const blockRe = isAtom
    ? /<entry[\s\S]*?<\/entry>/gi
    : /<item[\s\S]*?<\/item>/gi;

  const blocks = xml.match(blockRe) || [];
  const items = [];

  for (const block of blocks) {
    const title = tag(block, "title");
    let link = tag(block, "link");
    // Atom puts the URL in href rather than inner text.
    if (!link) {
      const href = block.match(/<link[^>]*href="([^"]+)"/i);
      link = href ? decodeEntities(href[1]) : "";
    }
    if (title) items.push({ source, title, link });
    if (items.length >= limit) break;
  }
  return items;
}

// ---------------------------------------------------------------------------
// Compose the digest
// ---------------------------------------------------------------------------

/** Interleave sources round-robin so the final 10 aren't all one outlet. */
function interleave(lists, total) {
  const result = [];
  let i = 0;
  while (result.length < total) {
    let addedThisRound = false;
    for (const list of lists) {
      if (list[i]) {
        result.push(list[i]);
        addedThisRound = true;
        if (result.length >= total) break;
      }
    }
    if (!addedThisRound) break; // all lists exhausted
    i++;
  }
  return result;
}

function buildTextBody(headlines, fetchedAt) {
  const lines = [
    "Top International News",
    `Fetched: ${fetchedAt}`,
    `Sources: ${FEEDS.map((f) => f.source).join(", ")} (world/international RSS feeds)`,
    "",
  ];
  headlines.forEach((h, idx) => {
    lines.push(`${idx + 1}. [${h.source}] ${h.title}`);
    if (h.link) lines.push(`   ${h.link}`);
  });
  lines.push("", "— Sent by your Kiro news-digest tool.");
  return lines.join("\n");
}

function buildHtmlBody(headlines, fetchedAt) {
  const items = headlines
    .map(
      (h, idx) => `
      <li style="margin:0 0 12px;">
        <span style="display:inline-block;font-size:11px;font-weight:600;text-transform:uppercase;
                     letter-spacing:.04em;color:#6366f1;">${escapeHtml(h.source)}</span><br/>
        <a href="${escapeAttr(h.link)}" style="color:#0f172a;text-decoration:none;font-size:15px;">
          ${idx + 1}. ${escapeHtml(h.title)}
        </a>
      </li>`
    )
    .join("");

  return `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:0 auto;color:#0f172a;">
    <h1 style="font-size:20px;margin:0 0 4px;">Top International News</h1>
    <p style="color:#64748b;font-size:12px;margin:0 0 16px;">
      Fetched ${escapeHtml(fetchedAt)} · Sources: ${FEEDS.map((f) => escapeHtml(f.source)).join(", ")}
    </p>
    <ol style="list-style:none;padding:0;margin:0;">${items}</ol>
    <p style="color:#94a3b8;font-size:11px;margin-top:20px;">Sent by your Kiro news-digest tool.</p>
  </div>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

/**
 * Build a full standalone HTML page (dark slate + indigo, matching the task
 * app) to save to disk and open in a browser. Unlike the email body, this can
 * use a <style> block, so it's a proper responsive page.
 */
function buildHtmlPage(headlines, fetchedAt) {
  const cards = headlines
    .map(
      (h, idx) => `
        <li class="item">
          <span class="rank">${idx + 1}</span>
          <div class="item__body">
            <span class="source source--${escapeAttr(
              h.source.toLowerCase().replace(/[^a-z]+/g, "-")
            )}">${escapeHtml(h.source)}</span>
            <a class="headline" href="${escapeAttr(h.link)}" target="_blank" rel="noopener">
              ${escapeHtml(h.title)}
            </a>
          </div>
        </li>`
    )
    .join("");

  const sources = FEEDS.map((f) => escapeHtml(f.source)).join(", ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Top International News</title>
  <style>
    :root {
      --bg: #0f172a; --surface: #1e293b; --surface-2: #334155;
      --text: #e2e8f0; --muted: #94a3b8; --accent: #6366f1; --accent-2: #818cf8;
      --radius: 14px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; padding: 48px 16px;
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      background: radial-gradient(1200px 600px at 50% -10%, #1e293b, var(--bg));
      color: var(--text);
    }
    .wrap { max-width: 720px; margin: 0 auto; }
    .card {
      background: var(--surface); border: 1px solid var(--surface-2);
      border-radius: 18px; padding: 28px 28px 12px;
      box-shadow: 0 20px 60px rgba(0,0,0,.35);
    }
    h1 { margin: 0 0 4px; font-size: 1.7rem; }
    .meta { color: var(--muted); font-size: .85rem; margin: 0 0 20px; }
    .list { list-style: none; margin: 0; padding: 0; }
    .item {
      display: flex; gap: 14px; align-items: flex-start;
      padding: 16px 0; border-top: 1px solid var(--surface-2);
    }
    .item:first-child { border-top: none; }
    .rank {
      flex: 0 0 auto; width: 30px; height: 30px; border-radius: 50%;
      display: grid; place-items: center; font-weight: 700; font-size: .85rem;
      background: var(--surface-2); color: var(--accent-2);
    }
    .item__body { min-width: 0; }
    .source {
      display: inline-block; font-size: .68rem; font-weight: 700;
      text-transform: uppercase; letter-spacing: .05em; color: var(--accent-2);
      padding: 2px 8px; border-radius: 999px; background: rgba(99,102,241,.15);
      margin-bottom: 6px;
    }
    .headline {
      display: block; color: var(--text); text-decoration: none;
      font-size: 1.02rem; line-height: 1.4;
    }
    .headline:hover { color: var(--accent-2); text-decoration: underline; }
    .footer { color: var(--muted); font-size: .78rem; text-align: center; margin-top: 18px; }
    .footer a { color: var(--accent-2); }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>Top International News</h1>
      <p class="meta">Fetched ${escapeHtml(fetchedAt)} · Sources: ${sources}</p>
      <ol class="list">${cards}
      </ol>
    </div>
    <p class="footer">Generated by your Kiro <strong>news-digest</strong> tool.</p>
  </div>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

async function sendEmail({ subject, text, html }) {
  const { SMTP_HOST, SMTP_USER, SMTP_PASS } = process.env;
  const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
  const MAIL_FROM = process.env.MAIL_FROM || SMTP_USER;

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw new Error(
      "Missing SMTP settings. Set SMTP_HOST, SMTP_USER, and SMTP_PASS " +
        "(and optionally SMTP_PORT). Run with --preview to skip email."
    );
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465, // true for 465, false for 587 (STARTTLS)
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  const info = await transporter.sendMail({
    from: MAIL_FROM,
    to: MAIL_TO,
    subject,
    text,
    html,
  });
  return info.messageId;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(
    `Fetching international headlines from ${FEEDS.length} sources…\n`
  );

  // Fetch all feeds in parallel; a single failing feed shouldn't sink the rest.
  const results = await Promise.allSettled(
    FEEDS.map((f) => fetchText(f.url).then((xml) => parseFeed(xml, f.source, PER_SOURCE)))
  );

  const lists = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value.length > 0) {
      console.log(`  ✓ ${FEEDS[i].source}: ${r.value.length} headlines`);
      lists.push(r.value);
    } else {
      const reason =
        r.status === "rejected" ? r.reason.message : "no items parsed";
      console.warn(`  ✗ ${FEEDS[i].source}: ${reason}`);
    }
  });

  if (lists.length === 0) {
    throw new Error("Could not fetch any headlines from any source.");
  }

  const headlines = interleave(lists, TOTAL);

  // Rewrite relay links (Google News -> a clean reuters.com search URL).
  headlines.forEach((h) => {
    h.link = resolveLink(h.link, h.title);
  });

  const fetchedAt = new Date().toLocaleString();
  const subject = `Top ${headlines.length} International News — ${new Date().toLocaleDateString()}`;
  const text = buildTextBody(headlines, fetchedAt);
  const html = buildHtmlBody(headlines, fetchedAt);

  console.log("\n===== Digest preview =====\n");
  console.log(text);
  console.log("\n==========================\n");

  // Write a standalone HTML page if requested.
  if (WRITE_HTML) {
    const page = buildHtmlPage(headlines, fetchedAt);
    fs.mkdirSync(path.dirname(HTML_OUT), { recursive: true }); // ensure folder exists
    fs.writeFileSync(HTML_OUT, page, "utf8");
    console.log(`HTML page written to: ${HTML_OUT}`);
    console.log(`Open it in your browser:  file:///${HTML_OUT.replace(/\\/g, "/")}`);
  }

  if (PREVIEW) {
    console.log(
      WRITE_HTML
        ? "\nPreview mode: HTML written, no email sent. Drop --preview to send."
        : "Preview mode: no email sent. Drop --preview to send."
    );
    return;
  }

  console.log(`\nSending to ${MAIL_TO}…`);
  const id = await sendEmail({ subject, text, html });
  console.log(`Sent. Message ID: ${id}`);
}

main().catch((err) => {
  console.error("\nError:", err && err.message ? err.message : err);
  process.exit(1);
});
