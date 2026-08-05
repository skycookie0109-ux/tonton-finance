// 每晚 21:00（台北）豚豚主動敲她一次。
//
// 這支是整個產品的核心。她不會主動打開 App，也不會主動想到要記帳，
// 所以豚豚得自己走過去問一句。她回一行字，webhook 就把帳記好了。
//
// 週日晚上改送週報：把整週的花費濃縮成三句話，不用她自己看報表。
//
// Vercel 免費方案的排程一天只能跑一次，所以週報不另開排程，
// 而是在這支裡面判斷今天是不是週日。

const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";

function toOrigin(raw) {
  const value = (raw || "").trim();
  if (!value) return "";
  try {
    return new URL(value).origin;
  } catch {
    return value.replace(/\/+$/, "");
  }
}

const SUPABASE_URL = toOrigin(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
);
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CHANNEL_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

function headers() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
  };
}

async function query(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: headers() });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

async function push(userId, text) {
  const res = await fetch(LINE_PUSH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CHANNEL_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ to: userId, messages: [{ type: "text", text }] }),
  });
  if (!res.ok) {
    // 額度用完、被封鎖、token 過期都會走到這裡，記下來才查得到原因
    console.error("push failed", res.status, await res.text());
    return false;
  }
  return true;
}

/** 台北時間的今天。Vercel 跑在 UTC，直接用會差 8 小時。 */
function taipeiToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}
function taipeiWeekday(now = new Date()) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei", weekday: "short",
  }).format(now); // Sun / Mon / ...
}
function shiftDay(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
const money = (n) => "NT$" + Math.round(n).toLocaleString("en-US");

/* ── 每天晚上的那一句 ─────────────────────────────── */

function nightlyMessage(name, todayRows) {
  if (todayRows.length === 0) {
    return (
      `晚安 🌙 今天花了什麼呢？\n\n` +
      `跟我說一聲就好，像這樣：\n` +
      `「珍奶65 捷運32」\n\n` +
      `今天沒花錢的話，回我「沒有」也可以 🙌`
    );
  }
  const spent = todayRows
    .filter((t) => !t.is_income)
    .reduce((sum, t) => sum + Number(t.amount), 0);
  const lines = todayRows
    .slice(0, 5)
    .map((t) => `${t.emoji} ${t.note} ${money(t.amount)}`);
  const more = todayRows.length > 5 ? `\n…還有 ${todayRows.length - 5} 筆` : "";
  return (
    `晚安 🌙 今天記了 ${todayRows.length} 筆，共 ${money(spent)}\n\n` +
    lines.join("\n") + more +
    `\n\n還有漏掉的嗎？補一句就好 ✨`
  );
}

/* ── 週日的三句話週報 ─────────────────────────────── */

function weeklyMessage(name, weekRows, prevSpent) {
  const spent = weekRows
    .filter((t) => !t.is_income)
    .reduce((sum, t) => sum + Number(t.amount), 0);

  if (weekRows.length === 0) {
    return `這週的小報告 🗞️\n\n這禮拜沒有紀錄，可能是忙壞了 🫠\n新的一週，我們慢慢來就好 🌱`;
  }

  // 花最多的那一類，通常也是她最有感的那一類
  const byCat = {};
  weekRows.forEach((t) => {
    if (t.is_income) return;
    byCat[t.category] = (byCat[t.category] || 0) + Number(t.amount);
  });
  const top = Object.keys(byCat).sort((a, b) => byCat[b] - byCat[a])[0];

  const days = new Set(weekRows.map((t) => t.happened_on)).size;
  let compare = "";
  if (prevSpent > 0) {
    const diff = spent - prevSpent;
    const pct = Math.round(Math.abs(diff) / prevSpent * 100);
    compare = diff > 0
      ? `比上週多花了 ${money(diff)}（+${pct}%），不過偶爾犒賞自己也沒關係 ☕`
      : `比上週少花了 ${money(-diff)}（-${pct}%），很棒 ✨`;
  } else {
    compare = `這是我們一起記帳的第一份週報 🌱`;
  }

  return (
    `這週的小報告 🗞️\n\n` +
    `1. 這禮拜花了 ${money(spent)}，記了 ${weekRows.length} 筆、${days} 天有紀錄。\n` +
    `2. 花最多的是「${top}」，共 ${money(byCat[top])}。\n` +
    `3. ${compare}\n\n` +
    `新的一週，${name}繼續陪妳 🧡`
  );
}

/* ── 進入點 ──────────────────────────────────────── */

export async function GET(request) {
  // 這支會主動發訊息給她，所以必須擋住外人。
  // 沒設 CRON_SECRET 就直接拒絕跑——寧可排程不動，也不要讓任何人
  // 打這個網址就能連環轟炸她的 LINE。
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("CRON_SECRET not set — refusing to run");
    return new Response("cron secret not configured", { status: 500 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("unauthorized", { status: 401 });
  }
  if (!SUPABASE_URL || !SUPABASE_KEY || !CHANNEL_TOKEN) {
    console.error("missing env: supabase url/key or line token");
    return new Response("not configured", { status: 500 });
  }

  const today = taipeiToday();
  const isSunday = taipeiWeekday() === "Sun";
  const results = [];

  // 只找綁定了 LINE、而且沒有關掉提醒的人
  const people = await query(
    "profiles?select=id,display_name,skin,line_user_id&line_user_id=not.is.null"
  );

  for (const person of people) {
    try {
      let text;
      if (isSunday) {
        const from = shiftDay(today, -6);
        const week = await query(
          `transactions?select=happened_on,category,emoji,note,amount,is_income` +
          `&user_id=eq.${person.id}&happened_on=gte.${from}&happened_on=lte.${today}`
        );
        const prevFrom = shiftDay(today, -13), prevTo = shiftDay(today, -7);
        const prev = await query(
          `transactions?select=amount,is_income&user_id=eq.${person.id}` +
          `&happened_on=gte.${prevFrom}&happened_on=lte.${prevTo}`
        );
        const prevSpent = prev
          .filter((t) => !t.is_income)
          .reduce((sum, t) => sum + Number(t.amount), 0);
        text = weeklyMessage(person.display_name || "豚豚", week, prevSpent);
      } else {
        const rows = await query(
          `transactions?select=emoji,note,amount,is_income` +
          `&user_id=eq.${person.id}&happened_on=eq.${today}&order=happened_at.asc`
        );
        text = nightlyMessage(person.display_name || "豚豚", rows);
      }
      const ok = await push(person.line_user_id, text);
      results.push({ user: person.id, sent: ok });
    } catch (err) {
      console.error("nightly failed for", person.id, err);
      results.push({ user: person.id, sent: false, error: String(err) });
    }
  }

  return new Response(
    JSON.stringify({ date: today, sunday: isSunday, results }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}
