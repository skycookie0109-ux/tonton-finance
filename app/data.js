// 豚豚記帳 · 資料層
//
// 掛在 window.TT 上，給 index.html 的主程式使用。
// 刻意寫成傳統 script 而不是 module，這樣主程式那支 IIFE 可以直接取用，
// 不必為了一個相依把整個檔案改成 module。
//
// 安全性的重點：瀏覽器這一端用的是「她本人的登入 token」，不是萬能金鑰。
// 每張表都開了 RLS（user_id = auth.uid()），所以就算有人拿到這裡的任何
// 東西，也只查得到自己的資料——隔離是資料庫保證的，不是靠前端記得過濾。

(function () {
  "use strict";

  var SESSION_KEY = "tonton-session";
  var cfg = null;      // { url, key, configured }
  var session = null;  // { access_token, refresh_token, user_id, expires_at }

  /* ── 設定與登入狀態 ─────────────────────────────── */

  function loadSession() {
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      session = raw ? JSON.parse(raw) : null;
    } catch (e) {
      session = null;
    }
    return session;
  }

  function saveSession(s) {
    session = s;
    try {
      if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      else localStorage.removeItem(SESSION_KEY);
    } catch (e) { /* 無痕模式：這次能用就好 */ }
  }

  function sessionFromAuth(json) {
    return {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      user_id: json.user && json.user.id,
      // 提早 60 秒視為過期，免得剛好卡在邊界
      expires_at: Date.now() + ((json.expires_in || 3600) - 60) * 1000,
    };
  }

  async function config() {
    if (cfg) return cfg;
    var res = await fetch("/api/config");
    cfg = await res.json();
    return cfg;
  }

  async function auth(path, body) {
    var c = await config();
    var res = await fetch(c.url + "/auth/v1/" + path, {
      method: "POST",
      headers: { apikey: c.key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    var json = await res.json();
    if (!res.ok) {
      var msg = json.error_description || json.msg || json.error || "登入失敗";
      throw new Error(msg);
    }
    return json;
  }

  async function login(email, password) {
    var json = await auth("token?grant_type=password", {
      email: (email || "").trim(),
      password: password || "",
    });
    saveSession(sessionFromAuth(json));
    return session;
  }

  /**
   * 註冊。回傳 { needsConfirm: true } 代表 Supabase 設定了要收信驗證，
   * 這時候還不能直接進 App，得請她先去點信裡的連結。
   */
  async function signup(email, password) {
    var json = await auth("signup", {
      email: (email || "").trim(),
      password: password || "",
    });
    if (json.access_token) {
      saveSession(sessionFromAuth(json));
      return { needsConfirm: false };
    }
    return { needsConfirm: true };
  }

  async function refresh() {
    if (!session || !session.refresh_token) return null;
    try {
      var json = await auth("token?grant_type=refresh_token", {
        refresh_token: session.refresh_token,
      });
      saveSession(sessionFromAuth(json));
      return session;
    } catch (e) {
      // refresh token 也失效了，只能請她重新登入
      saveSession(null);
      return null;
    }
  }

  function logout() { saveSession(null); }
  function isLoggedIn() { return !!(session && session.access_token); }

  /* ── PostgREST ──────────────────────────────────── */

  async function rest(path, opts) {
    opts = opts || {};
    var c = await config();
    if (session && session.expires_at && Date.now() > session.expires_at) {
      await refresh();
    }
    if (!session) throw new Error("尚未登入");

    async function send() {
      return fetch(c.url + "/rest/v1/" + path, {
        method: opts.method || "GET",
        headers: Object.assign(
          {
            apikey: c.key,
            Authorization: "Bearer " + session.access_token,
            "Content-Type": "application/json",
            Prefer: opts.prefer || "return=representation",
          },
          opts.headers || {}
        ),
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
    }

    var res = await send();
    if (res.status === 401) {
      // token 過期了，換一張再試一次
      if (await refresh()) res = await send();
    }
    if (!res.ok) {
      var detail = await res.text();
      throw new Error("資料庫回應 " + res.status + "：" + detail);
    }
    if (res.status === 204) return null;
    var text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  /* ── 資料庫欄位 ↔ 畫面資料 ──────────────────────── */

  var MARKET_TO_UI = { TW: "台股", US: "美股", CRYPTO: "Crypto" };
  var MARKET_TO_DB = { 台股: "TW", 美股: "US", Crypto: "CRYPTO" };
  var CCY_OF = { TW: "TWD", US: "USD", CRYPTO: "USD" };

  function taipeiTime(iso) {
    if (!iso) return "";
    try {
      return new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hour12: false,
      }).format(new Date(iso));
    } catch (e) {
      return "";
    }
  }

  function txFromDb(r) {
    return {
      id: r.id, date: r.happened_on, time: taipeiTime(r.happened_at),
      cat: r.category, emo: r.emoji || "✨", note: r.note || r.category,
      amt: Number(r.amount), income: !!r.is_income, src: r.source || "app",
    };
  }
  function txToDb(t, userId) {
    return {
      user_id: userId, happened_on: t.date, category: t.cat, emoji: t.emo,
      note: t.note, amount: t.amt, is_income: !!t.income, source: t.src || "app",
    };
  }

  function holdingFromDb(r, unitNameById, priceByKey) {
    // 有行情就用行情，還沒抓到就退回成本價（報酬率會顯示 0%，
    // 至少不會編一個不存在的漲跌出來）
    const quote = priceByKey[r.market + ":" + r.symbol];
    return {
      id: r.id, mkt: MARKET_TO_UI[r.market] || "台股", sym: r.symbol,
      name: r.name || r.symbol, qty: Number(r.quantity), cost: Number(r.avg_cost),
      price: quote != null ? quote : Number(r.avg_cost),
      hasQuote: quote != null,
      ccy: r.currency || "TWD",
      fee: Number(r.fee_total || 0), buy: r.bought_on,
      unit: unitNameById[r.unit_id] || "", note: r.why_note || "",
    };
  }
  function holdingToDb(h, userId, unitIdByName) {
    return {
      user_id: userId, market: MARKET_TO_DB[h.mkt] || "TW", symbol: h.sym,
      name: h.name, quantity: h.qty, avg_cost: h.cost,
      currency: h.ccy || CCY_OF[MARKET_TO_DB[h.mkt]] || "TWD",
      fee_total: h.fee || 0, bought_on: h.buy,
      unit_id: unitIdByName[h.unit] || null, why_note: h.note || null,
    };
  }

  /* ── 一次把需要的資料抓回來 ─────────────────────── */

  async function loadAll() {
    var userId = session.user_id;
    var results = await Promise.all([
      rest("profiles?select=*&limit=1"),
      rest("transactions?select=*&order=happened_on.desc,happened_at.desc&limit=2000"),
      rest("units?select=*&order=sort_order.asc,id.asc"),
      rest("holdings?select=*&order=id.asc"),
      rest("trades?select=*&order=traded_on.desc"),
      rest("dividends?select=*&order=paid_on.desc"),
      rest("quick_actions?select=*&order=sort_order.asc,id.asc"),
      rest("subscriptions?select=*&active=eq.true&order=day_of_month.asc"),
      rest("goals?select=*&order=id.asc"),
      rest("asset_snapshots?select=taken_on,total&order=taken_on.asc&limit=400"),
      rest("price_cache?select=market,symbol,price"),
      rest("fx_cache?select=pair,rate"),
    ]);
    var profile = results[0][0] || null;
    var unitRows = results[2];

    var unitNameById = {}, unitIdByName = {};
    unitRows.forEach(function (u) {
      unitNameById[u.id] = u.name;
      unitIdByName[u.name] = u.id;
    });

    var priceByKey = {};
    (results[10] || []).forEach(function (p) {
      priceByKey[p.market + ":" + p.symbol] = Number(p.price);
    });
    var usdTwd = null;
    (results[11] || []).forEach(function (f) {
      if (f.pair === "USDTWD") usdTwd = Number(f.rate);
    });

    return {
      userId: userId,
      profile: profile,
      tx: results[1].map(txFromDb),
      unitRows: unitRows,
      units: unitRows.map(function (u) { return u.name; }),
      unitNameById: unitNameById,
      unitIdByName: unitIdByName,
      usdTwd: usdTwd,
      holdings: results[3].map(function (r) { return holdingFromDb(r, unitNameById, priceByKey); }),
      trades: results[4].map(function (r) {
        return {
          id: r.id, date: r.traded_on, sym: r.symbol, name: r.name || r.symbol,
          mkt: MARKET_TO_UI[r.market] || "台股", qty: Number(r.quantity),
          sellPx: Number(r.price), costPx: Number(r.cost_price || 0),
          ccy: r.currency || "TWD", realized: Number(r.realized_pl || 0),
        };
      }),
      divs: results[5].map(function (r) {
        return {
          id: r.id, date: r.paid_on, sym: r.symbol, name: r.name || r.symbol,
          mkt: MARKET_TO_UI[r.market] || "台股",
          ccy: r.currency || "TWD", amt: Number(r.amount),
        };
      }),
      quick: results[6].map(function (r) {
        return {
          id: r.id, label: r.label, cat: r.category,
          emo: r.emoji || "✨", amt: Number(r.amount),
        };
      }),
      subs: results[7].map(function (r) {
        return {
          id: r.id, name: r.name, cat: r.category, emo: r.emoji || "🔁",
          amt: Number(r.amount), day: r.day_of_month,
        };
      }),
      goals: results[8].map(function (r) {
        return {
          id: r.id, title: r.title, emo: r.emoji || "🎯",
          target: Number(r.target), saved: Number(r.saved), due: r.due_on,
        };
      }),
      snapshots: results[9].map(function (r) {
        return { d: r.taken_on, v: Number(r.total) };
      }),
    };
  }

  /* ── 寫入 ───────────────────────────────────────── */
  // 每個都回傳資料庫寫入後的那一列，這樣畫面拿得到真正的 id，
  // 之後編輯／刪除才有東西可以對。

  async function createTx(t, userId) {
    var rows = await rest("transactions", { method: "POST", body: txToDb(t, userId) });
    return txFromDb(rows[0]);
  }
  async function updateTx(id, t, userId) {
    var rows = await rest("transactions?id=eq." + id, { method: "PATCH", body: txToDb(t, userId) });
    return rows[0] ? txFromDb(rows[0]) : null;
  }
  function removeTx(id) {
    return rest("transactions?id=eq." + id, { method: "DELETE", prefer: "return=minimal" });
  }

  async function createHolding(h, userId, unitIdByName) {
    var rows = await rest("holdings", { method: "POST", body: holdingToDb(h, userId, unitIdByName) });
    return rows[0].id;
  }
  function updateHolding(id, h, userId, unitIdByName) {
    return rest("holdings?id=eq." + id, { method: "PATCH", body: holdingToDb(h, userId, unitIdByName) });
  }
  function removeHolding(id) {
    return rest("holdings?id=eq." + id, { method: "DELETE", prefer: "return=minimal" });
  }

  async function createUnit(name, userId) {
    var rows = await rest("units", { method: "POST", body: { user_id: userId, name: name } });
    return rows[0].id;
  }
  function renameUnit(id, name) {
    return rest("units?id=eq." + id, { method: "PATCH", body: { name: name } });
  }
  function removeUnit(id) {
    return rest("units?id=eq." + id, { method: "DELETE", prefer: "return=minimal" });
  }

  async function createTrade(t, userId) {
    var rows = await rest("trades", {
      method: "POST",
      body: {
        user_id: userId, market: MARKET_TO_DB[t.mkt] || "TW", symbol: t.sym,
        name: t.name, side: "sell", quantity: t.qty, price: t.sellPx,
        cost_price: t.costPx, currency: t.ccy, realized_pl: t.realized,
        traded_on: t.date,
      },
    });
    return rows[0].id;
  }

  /**
   * 把這個帳號的所有資料刪光，回到剛註冊的狀態。
   *
   * 刻意不動兩樣東西：帳號本身（不然她就登不進來了），
   * 以及 LINE 綁定（重新開始之後豚豚還是認得她，不用再綁一次）。
   *
   * 每一句都帶 user_id 條件，加上 RLS 也會擋，所以就算這裡寫錯，
   * 也不可能刪到別人的資料。
   */
  async function wipeAll(userId) {
    // 先刪引用別人的，再刪被引用的，避免外鍵擋住
    const tables = [
      "transactions", "trades", "dividends", "holdings",
      "goals", "quick_actions", "subscriptions", "asset_snapshots", "units",
    ];
    for (const table of tables) {
      await rest(`${table}?user_id=eq.${userId}`, {
        method: "DELETE",
        prefer: "return=minimal",
      });
    }
    await rest(`profiles?id=eq.${userId}`, {
      method: "PATCH",
      body: { cash_balance: 0, month_budget: 0 },
      prefer: "return=minimal",
    });
  }

  function updateProfile(userId, patch) {
    return rest("profiles?id=eq." + userId, { method: "PATCH", body: patch, prefer: "return=minimal" });
  }

  async function createQuick(q, userId) {
    var rows = await rest("quick_actions", {
      method: "POST",
      body: { user_id: userId, label: q.label, category: q.cat, emoji: q.emo, amount: q.amt },
    });
    return rows[0].id;
  }
  function removeQuick(id) {
    return rest("quick_actions?id=eq." + id, { method: "DELETE", prefer: "return=minimal" });
  }
  async function createGoal(g, userId) {
    var rows = await rest("goals", {
      method: "POST",
      body: { user_id: userId, title: g.title, emoji: g.emo, target: g.target, saved: g.saved || 0, due_on: g.due || null },
    });
    return rows[0].id;
  }
  function updateGoal(id, patch) {
    return rest("goals?id=eq." + id, { method: "PATCH", body: patch, prefer: "return=minimal" });
  }
  function removeGoal(id) {
    return rest("goals?id=eq." + id, { method: "DELETE", prefer: "return=minimal" });
  }
  async function createSub(s, userId) {
    var rows = await rest("subscriptions", {
      method: "POST",
      body: { user_id: userId, name: s.name, category: s.cat, emoji: s.emo, amount: s.amt, day_of_month: s.day },
    });
    return rows[0].id;
  }
  function removeSub(id) {
    return rest("subscriptions?id=eq." + id, { method: "DELETE", prefer: "return=minimal" });
  }

  window.TT = {
    config: config, loadSession: loadSession, isLoggedIn: isLoggedIn,
    login: login, signup: signup, logout: logout,
    createQuick: createQuick, removeQuick: removeQuick,
    createGoal: createGoal, updateGoal: updateGoal, removeGoal: removeGoal,
    createSub: createSub, removeSub: removeSub,
    loadAll: loadAll,
    createTx: createTx, updateTx: updateTx, removeTx: removeTx,
    createHolding: createHolding, updateHolding: updateHolding, removeHolding: removeHolding,
    createUnit: createUnit, renameUnit: renameUnit, removeUnit: removeUnit,
    createTrade: createTrade, updateProfile: updateProfile, wipeAll: wipeAll,
    get userId() { return session && session.user_id; },
  };
})();
