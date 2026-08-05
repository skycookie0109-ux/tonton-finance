// LINE Messaging API 的接收端。
//
// 刻意不用任何 npm 套件：只用 Node 內建的 crypto 和 fetch，
// 直接打 Supabase 的 REST API 與 LINE API。少一個相依套件，
// 就少一個「部署之後才發現壞掉」的地方。
//
// 用 Web 版的函式簽章（Request → Response），因為驗證 LINE 簽章
// 需要「一個位元組都沒被動過的原始 body」，await request.text() 拿得到，
// 傳統的 req.body 已經被解析過就對不起來了。

import crypto from "node:crypto";
import { parseSentence, summarize, todayInTaipei } from "../_lib/parse.js";

const LINE_REPLY_URL = "https://api.line.me/v2/bot/message/reply";

// 結尾的斜線要拿掉。Supabase 後台複製出來的網址常常帶著它，
// 接上 /rest/v1/... 就變成雙斜線，PostgREST 會回 PGRST125 說路徑無效。
const SUPABASE_URL = (
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  ""
).replace(/\/+$/, "");
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const CHANNEL_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

/** LINE 用 channel secret 對原始 body 做 HMAC-SHA256，驗證這則請求真的是 LINE 送來的。 */
function signatureIsValid(rawBody, signature) {
  if (!signature || !CHANNEL_SECRET) return false;
  const expected = crypto
    .createHmac("sha256", CHANNEL_SECRET)
    .update(rawBody, "utf8")
    .digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  // 長度不同時 timingSafeEqual 會直接丟例外，所以先擋掉
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function replyToLine(replyToken, text) {
  const res = await fetch(LINE_REPLY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CHANNEL_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text: text.slice(0, 4900) }],
    }),
  });
  if (!res.ok) {
    console.error("LINE reply failed", res.status, await res.text());
  }
}

function supabaseHeaders(extra = {}) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

/** 用 LINE 的 userId 找出這是誰。找不到就回 null，由呼叫端引導綁定。 */
async function findProfile(lineUserId) {
  const url =
    `${SUPABASE_URL}/rest/v1/profiles` +
    `?line_user_id=eq.${encodeURIComponent(lineUserId)}&select=id,display_name&limit=1`;
  const res = await fetch(url, { headers: supabaseHeaders() });
  if (!res.ok) {
    // 把實際打出去的網址一起印出來（金鑰在 header 裡，不會外流），
    // 不然只看到 404 很難分辨是路徑錯還是資料不存在
    console.error("profile lookup failed", res.status, url, await res.text());
    return null;
  }
  const rows = await res.json();
  return rows[0] || null;
}

async function insertTransactions(userId, entries) {
  const rows = entries.map((e) => ({
    user_id: userId,
    happened_on: e.happened_on,
    category: e.category,
    emoji: e.emoji,
    note: e.note,
    amount: e.amount,
    is_income: e.is_income,
    source: "line",
  }));
  const res = await fetch(`${SUPABASE_URL}/rest/v1/transactions`, {
    method: "POST",
    headers: supabaseHeaders({ Prefer: "return=minimal" }),
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const detail = await res.text();
    console.error("insert failed", res.status, detail);
    throw new Error(`insert failed: ${res.status} ${detail}`);
  }
}

const HELP_TEXT =
  "我看不太懂這句 🙈\n\n" +
  "試試看這樣寫：\n" +
  "・早餐60\n" +
  "・珍奶65 捷運32（一次記好幾筆）\n" +
  "・昨天 午餐120（補記）\n" +
  "・薪水52000（收入也可以）\n\n" +
  "有金額我就記得起來 🧡";

async function handleTextMessage(event) {
  const text = (event.message?.text || "").trim();
  const lineUserId = event.source?.userId;
  const replyToken = event.replyToken;
  if (!replyToken) return;

  const entries = parseSentence(text, todayInTaipei());
  if (entries.length === 0) {
    await replyToLine(replyToken, HELP_TEXT);
    return;
  }

  const profile = lineUserId ? await findProfile(lineUserId) : null;
  if (!profile) {
    // 還沒綁定：先把識別碼給她，由 John 在 Supabase 填進 profiles.line_user_id
    await replyToLine(
      replyToken,
      "我聽懂了，但還不知道妳是誰 🐾\n\n" +
        `請把這串識別碼給 John：\n${lineUserId || "（讀不到）"}\n\n` +
        "綁定之後，以後打一句話就能記帳了 ✨"
    );
    return;
  }

  try {
    await insertTransactions(profile.id, entries);
    await replyToLine(replyToken, summarize(entries));
  } catch (err) {
    console.error(err);
    await replyToLine(replyToken, "剛剛存的時候出了點問題 🙈 等一下再試一次好嗎？");
  }
}

// 這裡刻意匯出具名的 HTTP 方法，而不是 export default。
// Vercel 的 /api 函式把 export default 當成傳統的 (req, res) 簽章，
// 回傳值會被直接忽略、請求就一直掛著直到逾時。
// 具名匯出才會走 Web 版的 Request/Response——而我們需要 Web 版，
// 因為驗簽必須拿到未經解析的原始 body。

/** 讓瀏覽器直接開這個網址時有東西看，方便確認函式活著。 */
export function GET() {
  return new Response("豚豚的 LINE webhook 在這裡 🦛", {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export async function POST(request) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-line-signature");

  if (!signatureIsValid(rawBody, signature)) {
    console.warn("invalid signature");
    return new Response("bad signature", { status: 401 });
  }

  // 設定漏了就早點喊出來，不然只會看到「豚豚都不回話」
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new Response("bad json", { status: 400 });
  }

  const events = Array.isArray(body.events) ? body.events : [];

  // LINE 會等這個回應，超過 timeout 就重送。
  // 所以每個 event 各自 try/catch，一則失敗不影響其他則，最後一律回 200。
  await Promise.all(
    events.map(async (event) => {
      try {
        if (event.type === "message" && event.message?.type === "text") {
          await handleTextMessage(event);
        } else if (event.type === "follow" && event.replyToken) {
          await replyToLine(
            event.replyToken,
            "嗨～我是豚豚 🦛🍊\n\n" +
              "以後花錢了就跟我說一聲，像這樣：\n" +
              "「珍奶65 捷運32」\n\n" +
              "我會幫妳記好，妳什麼都不用打開 ✨"
          );
        }
      } catch (err) {
        console.error("event failed", event.type, err);
      }
    })
  );

  return new Response("ok", { status: 200 });
}
