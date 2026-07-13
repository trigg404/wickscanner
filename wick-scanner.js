// ============================================================
//  Multi-Exchange 1m Wick Scanner
//
//  Flags coins printing large wicks (>= WICK_THRESHOLD_PCT of
//  price) on the 1-minute candle, in EITHER direction, across
//  Binance, Kraken, Gate, MEXC, OKX.
//
//  Design (to respect rate limits):
//    1. Pull each exchange's bulk 24h ticker (1 call each) to
//       find coins with high recent volatility (big 24h range).
//    2. For the top volatile candidates, pull the latest 1m
//       candle and measure the wick.
//    3. Flag wicks >= threshold -> Telegram alert.
//
//  Runs every RUN_INTERVAL_MS.
// ============================================================

const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN   || "YOUR_BOT_TOKEN";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "938922780";

const WICK_THRESHOLD_PCT = 0.5;      // wick must be >= this % of price
const TOP_VOLATILE       = 60;     // per-exchange: only check the N most volatile coins
const RUN_INTERVAL_MS    = 60000;  // scan every 1 minute
const ALERT_COOLDOWN_MS  = 10 * 60 * 1000; // don't repeat same coin+exchange within 10 min

const recentAlerts = new Map();

async function sendTelegram(text) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID, text,
        parse_mode: "Markdown", disable_web_page_preview: true,
      }),
    });
  } catch (e) { console.error("Telegram:", e.message); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// wick math from a single candle (o,h,l,c)
function wickInfo(o, h, l, c) {
  const upper = h - Math.max(o, c);
  const lower = Math.min(o, c) - l;
  const price = c || o;
  const upperPct = (upper / price) * 100;
  const lowerPct = (lower / price) * 100;
  return { upperPct, lowerPct, price };
}

// ── BINANCE ──────────────────────────────────────────────────
async function scanBinance() {
  try {
    const res = await fetch("https://api.binance.com/api/v3/ticker/24hr");
    const arr = await res.json();
    const usdt = arr.filter(t => t.symbol.endsWith("USDT"));
    // rank by 24h range %
    usdt.forEach(t => {
      const hi = parseFloat(t.highPrice), lo = parseFloat(t.lowPrice);
      t._range = lo > 0 ? ((hi - lo) / lo) * 100 : 0;
    });
    const top = usdt.sort((a,b)=>b._range-a._range).slice(0, TOP_VOLATILE);
    for (const t of top) {
      const sym = t.symbol;
      try {
        const k = await fetch(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=1m&limit=1`);
        const kl = await k.json();
        if (!kl[0]) continue;
        const [ , o, h, l, c ] = kl[0].map(Number);
        await checkWick("Binance", sym.replace("USDT",""), o, h, l, c);
      } catch (_) {}
      await sleep(120);
    }
  } catch (e) { console.error("Binance:", e.message); }
}

// ── MEXC (same API shape as Binance) ─────────────────────────
async function scanMexc() {
  try {
    const res = await fetch("https://api.mexc.com/api/v3/ticker/24hr");
    const arr = await res.json();
    const usdt = arr.filter(t => t.symbol.endsWith("USDT"));
    usdt.forEach(t => {
      const hi = parseFloat(t.highPrice), lo = parseFloat(t.lowPrice);
      t._range = lo > 0 ? ((hi - lo) / lo) * 100 : 0;
    });
    const top = usdt.sort((a,b)=>b._range-a._range).slice(0, TOP_VOLATILE);
    for (const t of top) {
      const sym = t.symbol;
      try {
        const k = await fetch(`https://api.mexc.com/api/v3/klines?symbol=${sym}&interval=1m&limit=1`);
        const kl = await k.json();
        if (!kl[0]) continue;
        const [ , o, h, l, c ] = kl[0].map(Number);
        await checkWick("MEXC", sym.replace("USDT",""), o, h, l, c);
      } catch (_) {}
      await sleep(120);
    }
  } catch (e) { console.error("MEXC:", e.message); }
}

// ── GATE ─────────────────────────────────────────────────────
async function scanGate() {
  try {
    const res = await fetch("https://api.gateio.ws/api/v4/spot/tickers");
    const arr = await res.json();
    const usdt = arr.filter(t => t.currency_pair.endsWith("_USDT"));
    usdt.forEach(t => {
      const hi = parseFloat(t.high_24h), lo = parseFloat(t.low_24h);
      t._range = lo > 0 ? ((hi - lo) / lo) * 100 : 0;
    });
    const top = usdt.sort((a,b)=>b._range-a._range).slice(0, TOP_VOLATILE);
    for (const t of top) {
      const pair = t.currency_pair;
      try {
        const k = await fetch(`https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${pair}&interval=1m&limit=1`);
        const kl = await k.json();
        if (!kl[0]) continue;
        // gate format: [time, volume, close, high, low, open, ...]
        const c = Number(kl[0][2]), h = Number(kl[0][3]), l = Number(kl[0][4]), o = Number(kl[0][5]);
        await checkWick("Gate", pair.replace("_USDT",""), o, h, l, c);
      } catch (_) {}
      await sleep(120);
    }
  } catch (e) { console.error("Gate:", e.message); }
}

// ── OKX ──────────────────────────────────────────────────────
async function scanOkx() {
  try {
    const res = await fetch("https://www.okx.com/api/v5/market/tickers?instType=SPOT");
    const j = await res.json();
    const usdt = (j.data||[]).filter(t => t.instId.endsWith("-USDT"));
    usdt.forEach(t => {
      const hi = parseFloat(t.high24h), lo = parseFloat(t.low24h);
      t._range = lo > 0 ? ((hi - lo) / lo) * 100 : 0;
    });
    const top = usdt.sort((a,b)=>b._range-a._range).slice(0, TOP_VOLATILE);
    for (const t of top) {
      const inst = t.instId;
      try {
        const k = await fetch(`https://www.okx.com/api/v5/market/candles?instId=${inst}&bar=1m&limit=1`);
        const kj = await k.json();
        const row = kj.data && kj.data[0];
        if (!row) continue;
        // okx format: [ts, o, h, l, c, ...]
        const o = Number(row[1]), h = Number(row[2]), l = Number(row[3]), c = Number(row[4]);
        await checkWick("OKX", inst.replace("-USDT",""), o, h, l, c);
      } catch (_) {}
      await sleep(120);
    }
  } catch (e) { console.error("OKX:", e.message); }
}

// ── KRAKEN ───────────────────────────────────────────────────
async function scanKraken() {
  try {
    // Kraken has no single bulk 1m endpoint; we pull its ticker list,
    // rank by 24h range, and fetch OHLC for top movers.
    const res = await fetch("https://api.kraken.com/0/public/Ticker");
    const j = await res.json();
    const entries = Object.entries(j.result || {})
      .filter(([pair]) => pair.endsWith("USD"))
      .map(([pair, d]) => {
        const hi = parseFloat(d.h[1]), lo = parseFloat(d.l[1]);
        return { pair, range: lo>0?((hi-lo)/lo)*100:0 };
      })
      .sort((a,b)=>b.range-a.range)
      .slice(0, TOP_VOLATILE);
    for (const e of entries) {
      try {
        const k = await fetch(`https://api.kraken.com/0/public/OHLC?pair=${e.pair}&interval=1`);
        const kj = await k.json();
        const key = Object.keys(kj.result||{}).find(x => x !== "last");
        const rows = key ? kj.result[key] : null;
        if (!rows || !rows.length) continue;
        const row = rows[rows.length - 1];
        // kraken OHLC: [time, open, high, low, close, ...]
        const o = Number(row[1]), h = Number(row[2]), l = Number(row[3]), c = Number(row[4]);
        await checkWick("Kraken", e.pair.replace("USD",""), o, h, l, c);
      } catch (_) {}
      await sleep(200);
    }
  } catch (e) { console.error("Kraken:", e.message); }
}

async function checkWick(exchange, symbol, o, h, l, c) {
  if (!o || !h || !l || !c) return;
  const { upperPct, lowerPct, price } = wickInfo(o, h, l, c);
  const maxWick = Math.max(upperPct, lowerPct);
  if (maxWick < WICK_THRESHOLD_PCT) return;

  const key = exchange + symbol;
  const last = recentAlerts.get(key);
  if (last && Date.now() - last < ALERT_COOLDOWN_MS) return;
  recentAlerts.set(key, Date.now());

  const dir = upperPct >= lowerPct ? "⬆️ upper wick (spike + rejection)" : "⬇️ lower wick (flush + bounce)";
  await sendTelegram([
    `🕯️ *Wick — ${symbol}* on ${exchange}`,
    dir,
    `Wick size: ${maxWick.toFixed(1)}% of price`,
    `Price: $${price.toPrecision(6)}`,
    `1m candle O:${o.toPrecision(5)} H:${h.toPrecision(5)} L:${l.toPrecision(5)} C:${c.toPrecision(5)}`,
  ].join("\n"));
  console.log(`  WICK ${symbol} ${exchange}: ${maxWick.toFixed(1)}%`);
}

async function scanCycle() {
  const t = new Date().toISOString();
  console.log(`[${t}] wick scan starting...`);
  await scanBinance();
  await scanMexc();
  await scanGate();
  await scanOkx();
  await scanKraken();
  console.log(`[${new Date().toISOString()}] wick scan done`);
}

async function main() {
  console.log(`Wick scanner started — threshold ${WICK_THRESHOLD_PCT}%, top ${TOP_VOLATILE} volatile per exchange`);
  await scanCycle();
  setInterval(scanCycle, RUN_INTERVAL_MS);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
