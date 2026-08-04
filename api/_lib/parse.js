// 一句話記帳的解析器。
// 從原型的前端邏輯移植過來，讓 LINE 和 App 用同一套規則，
// 兩邊對「珍奶65」的理解才會一致。

export const CATEGORIES = {
  餐點: "🍱", 飲料: "🧋", 交通: "🚇", 購物: "🛍️",
  娛樂: "🎬", 美妝: "💄", 健康: "💊", 其他: "✨",
  薪水: "💼", 獎金: "🎁", 股息: "📈",
};

const KEYWORDS = [
  ["餐點", ["早餐", "午餐", "晚餐", "便當", "飯", "麵", "麥當勞", "早午餐", "火鍋", "披薩", "壽司", "炸雞", "滷肉", "水餃", "brunch", "晚飯", "午飯", "宵夜", "小吃"]],
  ["飲料", ["珍奶", "奶茶", "咖啡", "星巴克", "手搖", "可樂", "拿鐵", "飲料", "茶", "果汁", "豆漿", "美式", "冰茶"]],
  ["交通", ["捷運", "公車", "計程車", "uber", "加油", "停車", "高鐵", "火車", "悠遊卡", "油錢", "機車", "客運", "youbike"]],
  ["購物", ["蝦皮", "momo", "網購", "衣服", "鞋", "包包", "日用品", "超市", "全聯", "costco", "好市多", "家樂福", "屈臣氏"]],
  ["娛樂", ["電影", "遊戲", "演唱會", "ktv", "netflix", "spotify", "展覽", "書", "訂閱", "唱歌"]],
  ["美妝", ["化妝", "保養", "口紅", "面膜", "美髮", "剪髮", "指甲", "香水", "洗髮", "美甲"]],
  ["健康", ["藥", "看醫生", "健身", "診所", "維他命", "牙醫", "按摩", "保健", "掛號"]],
  ["薪水", ["薪水", "月薪", "工資"]],
  ["獎金", ["獎金", "年終", "紅包", "分紅"]],
  ["股息", ["股息", "配息", "股利"]],
];

const INCOME_CATEGORIES = new Set(["薪水", "獎金", "股息"]);

/** 取得台北時區的今天（YYYY-MM-DD）。Vercel 跑在 UTC，不轉換的話半夜記的帳會掉到前一天。 */
export function todayInTaipei(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function shiftDay(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function categoryOf(word) {
  const w = word.toLowerCase();
  for (const [category, keys] of KEYWORDS) {
    if (keys.some((k) => w.includes(k) || k.includes(w))) return category;
  }
  return "其他";
}

/**
 * 把一句話拆成多筆記帳。
 *   「早餐60 珍奶65」        → 兩筆，今天
 *   「昨天 午餐120」          → 一筆，昨天
 *   「薪水52000」             → 一筆收入
 * 看不懂就回空陣列，由呼叫端決定怎麼回應。
 */
export function parseSentence(text, today = todayInTaipei()) {
  if (!text) return [];

  let date = today;
  if (/昨天|昨日/.test(text)) date = shiftDay(today, -1);
  else if (/前天/.test(text)) date = shiftDay(today, -2);

  const cleaned = text.replace(/昨天|昨日|前天|今天/g, " ");
  const entries = [];
  // 「文字 + 數字」為一筆；中間可以有空白，也可以沒有
  const re = /([一-鿿A-Za-z]+)\s*([0-9]+(?:\.[0-9]+)?)/g;
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    const amount = parseFloat(m[2]);
    if (!(amount > 0)) continue;
    const category = categoryOf(m[1]);
    entries.push({
      happened_on: date,
      category,
      emoji: CATEGORIES[category] || "✨",
      note: m[1],
      amount,
      is_income: INCOME_CATEGORIES.has(category),
    });
  }
  return entries;
}

/** 記完帳之後，豚豚要說的那句話。 */
export function summarize(entries) {
  const money = (n) => "NT$" + Math.round(n).toLocaleString("en-US");
  const lines = entries.map(
    (e) => `${e.emoji} ${e.note} ${e.is_income ? "+" : ""}${money(e.amount)}`
  );
  const spent = entries
    .filter((e) => !e.is_income)
    .reduce((sum, e) => sum + e.amount, 0);

  if (entries.length === 1) {
    return `記好了！\n${lines[0]}`;
  }
  return `記好了 ${entries.length} 筆！\n${lines.join("\n")}\n\n共花了 ${money(spent)} 🧡`;
}
