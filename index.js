const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer-core");
const chromium = require("@sparticuz/chromium");

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;

// Cache — RRG updates bids ~daily on market days, 15min is plenty
let cache = null;
let cacheTime = null;
const CACHE_DURATION_MS = 15 * 60 * 1000;

// Prevent concurrent scrapes (e.g. two phones hit refresh at the same time)
let scrapeInProgress = false;
let scrapeQueue = [];

async function scrapeRRG() {
  let browser = null;
  try {
    browser = await puppeteer.launch({
      args: [...chromium.args, "--no-sandbox", "--disable-setuid-sandbox"],
      defaultViewport: { width: 1024, height: 768 },
      executablePath: await chromium.executablePath(),
      headless: true,
    });

    const page = await browser.newPage();

    // Block images/fonts/css to speed up load
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const type = req.resourceType();
      if (["image", "font", "stylesheet", "media"].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto("https://www.redrivergrain.com/index.cfm?show=11&mid=3", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    // Wait for a cash price cell to actually have a numeric value
    // RRG prices are loaded via DTN JS — poll until they appear (max 20s)
    await page.waitForFunction(
      () => {
        const cells = Array.from(document.querySelectorAll("td"));
        return cells.some((td) => /^\d+\.\d{2}$/.test(td.innerText.trim()));
      },
      { timeout: 20000, polling: 500 }
    );

    const data = await page.evaluate(() => {
      const results = {};
      let currentCommodity = null;

      const allRows = Array.from(document.querySelectorAll("tr"));

      for (const row of allRows) {
        const cells = Array.from(row.querySelectorAll("td"));
        if (!cells.length) continue;

        // Commodity header: row with an <i> or <em> tag containing commodity name
        const italicEl = row.querySelector("i, em, b");
        if (italicEl) {
          const name = italicEl.innerText.trim().toUpperCase();
          if (name.includes("CORN") || name.includes("SOYBEAN") || name.includes("WHEAT")) {
            currentCommodity = name;
            if (!results[currentCommodity]) results[currentCommodity] = [];
            continue;
          }
        }

        // Data row: needs exactly 5 usable cells (Delivery, FuturesMonth, FuturesChg, Basis, CashPrice)
        if (!currentCommodity || cells.length < 5) continue;

        const delivery     = cells[0]?.innerText?.trim();
        const futuresChange = cells[2]?.innerText?.trim();
        const basis        = cells[3]?.innerText?.trim();
        const cashPrice    = cells[4]?.innerText?.trim();

        // Must look like a real delivery row: starts with a letter, cash price is numeric
        if (
          !delivery ||
          !/^[A-Za-z]/.test(delivery) ||
          delivery.toLowerCase().includes("futures") ||
          delivery.toLowerCase().includes("delivery") ||
          !/^\d+\.\d+$/.test(cashPrice)
        ) continue;

        results[currentCommodity].push({
          delivery,
          futuresChange: futuresChange || "—",
          basis: basis || "—",
          cashPrice,
        });
      }

      return results;
    });

    return data;
  } finally {
    // Always close browser, even on error
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
  }
}

// Serialize concurrent scrape requests so only one runs at a time
function scrapeWithQueue() {
  return new Promise((resolve, reject) => {
    if (!scrapeInProgress) {
      scrapeInProgress = true;
      scrapeRRG()
        .then((data) => {
          cache = data;
          cacheTime = Date.now();
          scrapeInProgress = false;
          // Resolve all queued requests with the same result
          const q = scrapeQueue.splice(0);
          resolve(data);
          q.forEach((p) => p.resolve(data));
        })
        .catch((err) => {
          scrapeInProgress = false;
          const q = scrapeQueue.splice(0);
          reject(err);
          q.forEach((p) => p.reject(err));
        });
    } else {
      // Queue this request — it'll resolve when the in-flight scrape finishes
      scrapeQueue.push({ resolve, reject });
    }
  });
}

app.get("/bids", async (req, res) => {
  const now = Date.now();
  const forceRefresh = req.query.refresh === "1";

  // Serve cache if fresh and not a forced refresh
  if (!forceRefresh && cache && cacheTime && now - cacheTime < CACHE_DURATION_MS) {
    return res.json({
      data: cache,
      cached: true,
      fetchedAt: new Date(cacheTime).toISOString(),
    });
  }

  try {
    console.log(`[${new Date().toISOString()}] Scraping RRG...`);
    const data = await scrapeWithQueue();
    res.json({
      data,
      cached: false,
      fetchedAt: new Date(cacheTime).toISOString(),
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Scrape error:`, err.message);
    // Return stale cache rather than a blank error if we have anything
    if (cache) {
      return res.json({
        data: cache,
        cached: true,
        stale: true,
        fetchedAt: new Date(cacheTime).toISOString(),
        warning: "Live scrape failed; showing last known data.",
      });
    }
    res.status(500).json({ error: "Failed to fetch bids", detail: err.message });
  }
});

app.get("/health", (_, res) => res.json({ status: "ok", uptime: process.uptime() }));
app.get("/", (_, res) => res.json({ status: "RRG Scraper running", endpoints: ["/bids", "/bids?refresh=1", "/health"] }));

app.listen(PORT, () => console.log(`RRG scraper listening on port ${PORT}`));
