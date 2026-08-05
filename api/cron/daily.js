// 每天收盤後跑一次，做四件她不該自己動手的事：
//
//   1. 更新行情（台股、美股、加密貨幣）與美元匯率
//   2. 把今天到期的訂閱與固定支出自動記帳
//   3. 寫一筆資產快照——這是真實資產曲線唯一的來源
//   4. 順序刻意如此：快照一定要在行情更新之後，
//      不然會把錯的價格永久寫進歷史，那種錯誤事後補不回來
//
// 行情來源全部挑不需要金鑰的：證交所／櫃買中心 OpenAPI、CoinGecko、stooq。
// 少一把金鑰就少一個會過期、會外流、會忘記續約的東西。
//
// 每個來源各自 try/catch：台股抓不到不該害得加密貨幣也不更新。

function toOrigin(raw) {
  const value = (raw || "").trim();
  if (!value) return "";
  try { return new URL(value).origin; } catch { return value.replace(/\/+$/, ""); }
}

const SUPABASE_URL = toOrigin(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
);
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function headers(extra = {}) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}
async function query(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: headers() });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}
async function upsert(table, rows) {
  if (!rows.length) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: headers({ Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`upsert ${table} → ${res.status} ${await res.text()}`);
}
async function insert(table, rows) {
  if (!rows.length) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: headers({ Prefer: "return=minimal" }),
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`insert ${table} → ${res.status} ${await res.text()}`);
}
async function patch(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: headers({ Prefer: "return=minimal" }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`patch ${path} → ${res.status} ${await res.text()}`);
}

function taipeiToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

/* ── 行情來源 ───────────────────────────────────── */

/** 台股：證交所（上市）＋櫃買中心（上櫃）的每日收盤 OpenAPI，都不用金鑰。 */
async function fetchTwPrices(symbols) {
  const out = {};
  if (!symbols.size) return out;

  const sources = [
    { url: "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL",
      code: (r) => r.Code, close: (r) => r.ClosingPrice },
    { url: "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes",
      code: (r) => r.SecuritiesCompanyCode ?? r.Code,
      close: (r) => r.Close ?? r.ClosingPrice },
  ];

  for (const source of sources) {
    try {
      const res = await fetch(source.url, { headers: { accept: "application/json" } });
      if (!res.ok) { console.error("tw source failed", source.url, res.status); continue; }
      const rows = await res.json();
      for (const row of rows) {
        const code = String(source.code(row) || "").trim();
        if (!symbols.has(code) || out[code]) continue;
        const price = parseFloat(String(source.close(row) || "").replace(/,/g, ""));
        if (price > 0) out[code] = price;
      }
    } catch (err) {
      console.error("tw source error", source.url, err);
    }
  }
  return out;
}

/** 加密貨幣：CoinGecko 的免費端點，不用金鑰。 */
const COIN_IDS = {
  BTC: "bitcoin", ETH: "ethereum", SOL: "solana", BNB: "binancecoin",
  XRP: "ripple", ADA: "cardano", DOGE: "dogecoin", DOT: "polkadot",
  AVAX: "avalanche-2", LINK: "chainlink", MATIC: "matic-network",
  USDT: "tether", USDC: "usd-coin",
};
async function fetchCryptoPrices(symbols) {
  const out = {};
  const wanted = [...symbols].filter((s) => COIN_IDS[s.toUpperCase()]);
  if (!wanted.length) return out;
  try {
    const ids = wanted.map((s) => COIN_IDS[s.toUpperCase()]).join(",");
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`
    );
    if (!res.ok) { console.error("coingecko failed", res.status); return out; }
    const json = await res.json();
    for (const symbol of wanted) {
      const price = json[COIN_IDS[symbol.toUpperCase()]]?.usd;
      if (price > 0) out[symbol] = price;
    }
  } catch (err) {
    console.error("coingecko error", err);
  }
  return out;
}

/** stooq 的 CSV 端點，美股與匯率共用，一樣不用金鑰。 */
async function fetchStooq(ticker) {
  try {
    const res = await fetch(
      `https://stooq.com/q/l/?s=${encodeURIComponent(ticker)}&f=sd2t2ohlcv&h&e=csv`
    );
    if (!res.ok) return null;
    const lines = (await res.text()).trim().split("\n");
    if (lines.length < 2) return null;
    const close = parseFloat(lines[1].split(",")[6]);
    return close > 0 ? close : null;
  } catch (err) {
    console.error("stooq error", ticker, err);
    return null;
  }
}
async function fetchUsPrices(symbols) {
  const out = {};
  for (const symbol of symbols) {
    const price = await fetchStooq(`${symbol.toLowerCase()}.us`);
    if (price) out[symbol] = price;
  }
  return out;
}

/* ── 進入點 ──────────────────────────────────────── */

export async function GET(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("CRON_SECRET not set — refusing to run");
    return new Response("cron secret not configured", { status: 500 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("unauthorized", { status: 401 });
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return new Response("not configured", { status: 500 });
  }

  const today = taipeiToday();
  const dayOfMonth = Number(today.slice(8, 10));
  const summary = { date: today, prices: 0, fx: null, subscriptions: 0, snapshots: 0 };

  // ── 1. 行情 ───────────────────────────────────
  const holdings = await query("holdings?select=user_id,market,symbol,quantity,avg_cost,currency");
  const bucket = { TW: new Set(), US: new Set(), CRYPTO: new Set() };
  holdings.forEach((h) => bucket[h.market]?.add(h.symbol));

  const [tw, us, crypto] = await Promise.all([
    fetchTwPrices(bucket.TW),
    fetchUsPrices(bucket.US),
    fetchCryptoPrices(bucket.CRYPTO),
  ]);

  const priceRows = [
    ...Object.entries(tw).map(([symbol, price]) => ({ market: "TW", symbol, price, currency: "TWD" })),
    ...Object.entries(us).map(([symbol, price]) => ({ market: "US", symbol, price, currency: "USD" })),
    ...Object.entries(crypto).map(([symbol, price]) => ({ market: "CRYPTO", symbol, price, currency: "USD" })),
  ].map((r) => ({ ...r, updated_at: new Date().toISOString() }));

  if (priceRows.length) {
    await upsert("price_cache", priceRows);
    summary.prices = priceRows.length;
  }
  // 抓不到的留著上次的價格，總比顯示成本價（＝報酬率永遠 0%）好
  const missing = [...bucket.TW, ...bucket.US, ...bucket.CRYPTO].filter(
    (s) => !tw[s] && !us[s] && !crypto[s]
  );
  if (missing.length) console.warn("no quote for", missing.join(","));

  // ── 2. 匯率 ───────────────────────────────────
  const usdTwd = await fetchStooq("usdtwd");
  if (usdTwd) {
    await upsert("fx_cache", [
      { pair: "USDTWD", rate: usdTwd, updated_at: new Date().toISOString() },
    ]);
    summary.fx = usdTwd;
  }

  // 算資產時用剛抓到的價，抓不到就退回資料庫裡的舊價，再退回成本價
  const cached = await query("price_cache?select=market,symbol,price");
  const priceOf = (h) => {
    const fresh = { TW: tw, US: us, CRYPTO: crypto }[h.market]?.[h.symbol];
    if (fresh) return fresh;
    const old = cached.find((c) => c.market === h.market && c.symbol === h.symbol);
    return old ? Number(old.price) : Number(h.avg_cost);
  };
  const fxOf = (currency) => (currency === "USD" ? (usdTwd || 31.2) : 1);

  // ── 3. 今天到期的訂閱 ─────────────────────────
  const subs = await query(
    `subscriptions?select=*&active=eq.true&day_of_month=eq.${dayOfMonth}`
  );
  const newTx = [];
  for (const sub of subs) {
    // 同一個月只記一次，排程重跑也不會變成兩筆
    if (sub.last_posted_on && sub.last_posted_on.slice(0, 7) === today.slice(0, 7)) continue;
    newTx.push({
      user_id: sub.user_id, happened_on: today, category: sub.category,
      emoji: sub.emoji || "🔁", note: `${sub.name}（自動）`,
      amount: sub.amount, is_income: false, source: "auto",
    });
    await patch(`subscriptions?id=eq.${sub.id}`, { last_posted_on: today });
  }
  if (newTx.length) {
    await insert("transactions", newTx);
    summary.subscriptions = newTx.length;
  }

  // ── 4. 資產快照（一定放最後）───────────────────
  const profiles = await query("profiles?select=id,cash_balance");
  const snapshots = profiles.map((p) => {
    const investment = holdings
      .filter((h) => h.user_id === p.id)
      .reduce((sum, h) => sum + Number(h.quantity) * priceOf(h) * fxOf(h.currency), 0);
    const cash = Number(p.cash_balance || 0);
    return {
      user_id: p.id, taken_on: today,
      cash, investment: Math.round(investment), total: Math.round(cash + investment),
    };
  });
  if (snapshots.length) {
    await upsert("asset_snapshots", snapshots);
    summary.snapshots = snapshots.length;
  }

  return new Response(JSON.stringify(summary), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
