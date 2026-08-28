export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/generate" && request.method === "POST") {
      try {
        if (!env.GEMINI_API_KEY) {
          const resText = "エラー: Cloudflareの環境変数 GEMINI_API_KEY が設定されていません。";
          return new Response(JSON.stringify({ commit: resText, commitMessage: resText, message: resText, result: resText }), {
            headers: { "Content-Type": "application/json" }
          });
        }

        const body = await request.json();
        const diff = body.diff || body.diffText;

        if (!diff) {
          const resText = "エラー: diffの内容が空です。";
          return new Response(JSON.stringify({ commit: resText, commitMessage: resText, message: resText, result: resText }), {
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

        let commitText = "";
        if (!geminiRes.ok || data.error) {
          commitText = `Gemini APIエラー: ${data.error?.message || `HTTP ${geminiRes.status}`}`;
        } else {
          commitText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "コミットメッセージを取得できませんでした。";
        }

        const id = crypto.randomUUID().slice(0, 8);
        if (env.DB && commitText && !commitText.startsWith("Gemini APIエラー")) {
          try {
            await env.DB.prepare("INSERT INTO commits (id, diff, result, created_at) VALUES (?, ?, ?, ?)").bind(id, diff, commitText, new Date().toISOString()).run();
          } catch (dbErr) {
            console.error("DB Error:", dbErr);
          }
        }

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
        const errMsg = `システムエラー: ${err.message}`;
        return new Response(JSON.stringify({ commit: errMsg, commitMessage: errMsg, message: errMsg, result: errMsg }), {
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    return env.ASSETS.fetch(request);
  }
};
