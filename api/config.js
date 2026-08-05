// 把前端需要的公開設定送出去。
//
// index.html 是純靜態檔案，沒有建置步驟，所以沒辦法在打包時把環境變數
// 塞進去。改成執行時跟這支函式要——設定仍然只存在 Vercel 環境變數裡，
// 換專案不用改任何一行程式碼。
//
// 這裡送出的兩個值本來就是要公開的：publishable key 設計上就會出現在
// 瀏覽器裡，資料的保護靠的是每張表上的 RLS，不是靠藏這把鑰匙。
// 能繞過 RLS 的 secret key 只留在伺服器端，永遠不會經過這裡。

function toOrigin(raw) {
  const value = (raw || "").trim();
  if (!value) return "";
  try {
    return new URL(value).origin;
  } catch {
    return value.replace(/\/+$/, "");
  }
}

export function GET() {
  const url = toOrigin(
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  );
  const key =
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    "";

  return new Response(JSON.stringify({ url, key, configured: !!(url && key) }), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // 設定很少變，但也不能永久快取，不然換金鑰要等很久才生效
      "cache-control": "public, max-age=60, s-maxage=60",
    },
  });
}
