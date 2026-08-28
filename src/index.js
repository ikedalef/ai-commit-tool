export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // APIリクエストの処理
    if (url.pathname === "/api/generate" && request.method === "POST") {
      try {
        const body = await request.json();
        const diff = body.diff || body.diffText;

        if (!diff) {
          return new Response(JSON.stringify({ error: "diff is required" }), {
            status: 400,
            headers: { "Content-Type": "application/json" }
          });
        }

        const prompt = `あなたはプロのソフトウェアエンジニアです。以下のGitの差分(diff)を解析し、Conventional Commits規約に準拠した簡潔なコミットメッセージを作成してください。\n\n[Diff内容]\n${diff}`;
        
        const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${env.GEMINI_API_KEY}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }]
          })
        });

        const data = await geminiRes.json();
        const commitText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "コミットメッセージの生成に失敗しました。";

        // D1 DB への保存処理
        const id = crypto.randomUUID().slice(0, 8);
        if (env.DB) {
          try {
            await env.DB.prepare("INSERT INTO commits (id, diff, result, created_at) VALUES (?, ?, ?, ?)").bind(id, diff, commitText, new Date().toISOString()).run();
          } catch (dbErr) {
            console.error("DB Error:", dbErr);
          }
        }

        // フロントエンドの全想定キー名に対応
        return new Response(JSON.stringify({
          commit: commitText,
          commitMessage: commitText,
          message: commitText,
          result: commitText,
          id: id
        }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // 静的ファイル（HTMLなど）の配信
    return env.ASSETS.fetch(request);
  }
};
