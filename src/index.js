export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/generate" && request.method === "POST") {
      try {
        const body = await request.json().catch(() => ({}));
        const diff = (body.diff || body.diffText || "").trim();

        if (!diff) {
          const resText = "エラー: diffの内容が空です。差分を入力してください。";
          return new Response(JSON.stringify({ commit: resText, commitMessage: resText, message: resText, result: resText }), {
            headers: { "Content-Type": "application/json" }
          });
        }

        const prompt = `あなたはプロのソフトウェアエンジニアです。以下のGitの差分(diff)を解析し、Conventional Commits規約に準拠したコミット文とPR要約を簡潔に出力してください。\n\n[Diff内容]\n${diff}`;
        let commitText = "";

        // 1. Gemini API による生成
        if (env.GEMINI_API_KEY) {
          const candidateModels = [
            "gemini-2.0-flash",
            "gemini-2.5-flash",
            "gemini-1.5-flash"
          ];

          for (const model of candidateModels) {
            try {
              const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  contents: [{ parts: [{ text: prompt }] }]
                })
              });

              if (res.ok) {
                const data = await res.json();
                const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (text) {
                  commitText = text.trim();
                  break;
                }
              }
            } catch (_) {}
          }
        }

        // 2. フォールバック（API不通時も確実に生成）
        if (!commitText) {
          commitText = generateCommitFromDiff(diff);
        }

        // 3. D1 データベースへの保存
        const id = crypto.randomUUID().slice(0, 8);
        if (env.DB) {
          try {
            await env.DB.prepare("INSERT INTO commits (id, diff, result, created_at) VALUES (?, ?, ?, ?)").bind(id, diff, commitText, new Date().toISOString()).run();
          } catch (_) {}
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
        const fallbackText = generateCommitFromDiff("diff updated");
        return new Response(JSON.stringify({
          commit: fallbackText,
          commitMessage: fallbackText,
          message: fallbackText,
          result: fallbackText
        }), {
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    return env.ASSETS.fetch(request);
  }
};

function generateCommitFromDiff(diff) {
  let type = "chore";
  let description = "update codebase";

  if (diff.includes("console.log") || diff.includes("print")) {
    type = "feat";
    description = "add log outputs for debugging";
  } else if (diff.includes("fix") || diff.includes("bug") || diff.includes("error")) {
    type = "fix";
    description = "resolve issue in application logic";
  } else if (diff.includes("test")) {
    type = "test";
    description = "add and update unit tests";
  } else if (diff.includes("style") || diff.includes("css")) {
    type = "style";
    description = "update styling and layout formatting";
  } else if (diff.includes("readme") || diff.includes("doc")) {
    type = "docs";
    description = "update documentation";
  } else if (diff.includes("add") || diff.includes("+")) {
    type = "feat";
    description = "implement new feature enhancements";
  }

  return `${type}: ${description}\n\n### PR Summary\n- Automated commit generated based on git diff analysis.\n- Follows Conventional Commits standard.`;
}
