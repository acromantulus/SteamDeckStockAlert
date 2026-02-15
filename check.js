// check.js
// Minimal Steam Deck stock checker + SendGrid email alert.
// NOTE: This is a heuristic. Steam may change markup; if it breaks, tweak the checks.

import https from "https";
import crypto from "crypto";

const STEAM_URL = process.env.STEAM_URL; // e.g. https://store.steampowered.com/steamdeck
const SENDGRID_KEY = process.env.SENDGRID_KEY;
const TO_EMAIL = process.env.TO_EMAIL;
const FROM_EMAIL = process.env.FROM_EMAIL;

// Last known state stored in a file that we cache between runs.
const STATE_FILE = "last_state.json";

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(
      url,
      {
        headers: {
          // A realistic UA helps avoid some bot blocking.
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    ).on("error", reject);
  });
}

function detectInStock(html) {
  const lower = html.toLowerCase();

  // Heuristics: “out of stock” text often appears when unavailable.
  const looksOut =
    lower.includes("out of stock") ||
    lower.includes("currently unavailable") ||
    lower.includes("sold out");

  // Heuristic: presence of purchase/add-to-cart-ish UI.
  const looksBuy =
    lower.includes("add to cart") ||
    lower.includes("purchase") ||
    lower.includes("buy now");

  // If it doesn't look out-of-stock and it looks purchasable, treat as in-stock.
  return !looksOut && looksBuy;
}

async function sendEmail({ subject, text, toEmails }) {
  const payload = JSON.stringify({
    personalizations: [
      {
        to: toEmails.map((email) => ({ email })),
      },
    ],
    from: { email: FROM_EMAIL },
    subject,
    content: [{ type: "text/plain", value: text }],
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      "https://api.sendgrid.com/v3/mail/send",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SENDGRID_KEY}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve();
          else reject(new Error(`SendGrid failed: ${res.statusCode} ${body}`));
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function readState() {
  try {
    const fs = await import("fs/promises");
    const raw = await fs.readFile(STATE_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return { lastInStock: false, lastHash: "", lastDailyReportDate: "" };
  }
}

async function writeState(state) {
  const fs = await import("fs/promises");
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

(async () => {
  if (!STEAM_URL || !SENDGRID_KEY || !TO_EMAIL || !FROM_EMAIL) {
    throw new Error("Missing env vars: STEAM_URL, SENDGRID_KEY, TO_EMAIL, FROM_EMAIL");
  }

  const { status, body } = await fetch(STEAM_URL);
  if (status !== 200) throw new Error(`Steam fetch failed: HTTP ${status}`);

  const inStock = detectInStock(body);

  // Hash page content so you can debug changes if needed.
  const hash = crypto.createHash("sha256").update(body).digest("hex").slice(0, 16);

  const state = await readState();
  await sendEmail({
    subject: "TEST: Steam Deck watcher",
    text: 'Test email from GitHub Action.\n${STEAM_URL}\n(inStock={inStock}, hash=${hash})',
    toEmails: [process.env.TO_EMAIL, process.env.TO_SMS],
  });
  console.log("Test email sent.");
  const flippedToInStock = inStock && !state.lastInStock;

  console.log(`inStock=${inStock} prev=${state.lastInStock} hash=${hash}`);

  if (flippedToInStock) {
    const subject = "Steam Deck: BACK IN STOCK";
    const text = `IN STOCK: ${STEAM_URL}`;
    await sendEmail({
      subject,
      text,
      toEmails: [process.env.TO_EMAIL, process.env.TO_SMS],
    });
    console.log("Stock alert sent.");
  }

  // Daily status email at ~8am America/New_York (DST-safe)
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const get = (type) => parts.find((p) => p.type === type)?.value;
  const nyDate = `${get("year")}-${get("month")}-${get("day")}`; // YYYY-MM-DD
  const nyHour = Number(get("hour"));
  const nyMinute = Number(get("minute"));

  const inDailyWindow = nyHour === 8 && nyMinute < 15; // first 15 minutes after 8am
  const shouldSendDaily = inDailyWindow && state.lastDailyReportDate !== nyDate;

  if (shouldSendDaily) {
    const subject = "Steam Deck daily stock check";
    const text = `Daily check (${nyDate} 08:${String(nyMinute).padStart(2,"0")} ET)\n` +
                 `Status: ${inStock ? "IN STOCK" : "OUT OF STOCK"}\n` +
                 `${STEAM_URL}\n` +
                 `(page hash: ${hash})`;

    // Daily report -> EMAIL ONLY (no SMS spam)
    await sendEmail({ subject, text, toEmails: [process.env.TO_EMAIL] });
    console.log("Daily status email sent.");
    state.lastDailyReportDate = nyDate;
  }
  
  state.lastInStock = inStock;
  state.lastHash = hash;

  await writeState(state);
})();
