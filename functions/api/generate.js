export async function onRequestPost(context) {
  try {
    const { request, env } = context;
    const { diffText } = await request.json();

    if (!diffText || diffText.length > 8000) {
      return new Response(JSON.stringify({ error: "テキストが無効か、長すぎます。" }), { status: 400 });
    }

    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "APIキーが設定されていません。" }), { status: 500 });
    }

    // 先ほど動作確認できた最新モデル gemini-3.6-flash を使用
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;
    const prompt = `以下のGit Diff内容を解析し、Conventional Commitsに準拠したコミット文と簡潔なPR要約（Markdown形式）を作成してください:\n\n${diffText}`;

    const geminiRes = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });

    const data = await geminiRes.json();
    if (data.error) throw new Error(data.error.message || "Gemini API Error");

    const outputText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

    // 共有IDとタイトルの抽出
    const id = crypto.randomUUID().slice(0, 8);
    const firstLine = outputText.split('\n')[0].replace(/[`#*]/g, '').trim() || "Git Commit Summary";
    const title = firstLine.length > 70 ? firstLine.slice(0, 70) + "..." : firstLine;

    // Cloudflare D1 に自動保存（DBがバインドされている場合）
    if (env.DB) {
      await env.DB.prepare(
        "INSERT INTO snippets (id, title, diff_snippet, result_text) VALUES (?, ?, ?, ?)"
      ).bind(id, title, diffText.slice(0, 400), outputText).run();
    }

    return new Response(JSON.stringify({
      result: outputText,
      shareUrl: `/c/${id}`
    }), { headers: { "Content-Type": "application/json" } });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}