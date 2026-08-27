export async function onRequestGet(context) {
  const { params, env } = context;
  const id = params.id;

  if (!env.DB) {
    return new Response("Database not connected", { status: 500 });
  }

  const row = await env.DB.prepare(
    "SELECT title, diff_snippet, result_text, created_at FROM snippets WHERE id = ?"
  ).bind(id).first();

  if (!row) {
    return new Response("404 Not Found - ページが見つかりません", { status: 404 });
  }

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>${row.title} - AI Git Commit Generator</title>
  <meta name="description" content="AIが生成したコミットメッセージとPR要約: ${row.title}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: system-ui, sans-serif; max-width: 760px; margin: 40px auto; padding: 0 16px; line-height: 1.6; color: #1f2937; }
    h1 { font-size: 22px; }
    pre { background: #f3f4f6; padding: 14px; border-radius: 6px; white-space: pre-wrap; font-size: 13px; border: 1px solid #e5e7eb; }
    .btn { display: inline-block; background: #2563eb; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-weight: 500; margin-top: 16px; }
  </style>
</head>
<body>
  <p><a href="/" style="color: #2563eb; text-decoration: none;">← トップに戻って新しく生成する</a></p>
  <h1>${row.title}</h1>
  <p style="color: #6b7280; font-size: 13px;">作成日時: ${row.created_at}</p>

  <h3>生成されたコミット文 & PR要約:</h3>
  <pre><code>${row.result_text.replace(/</g, "&lt;")}</code></pre>

  <h3>入力されたGit Diff:</h3>
  <pre><code>${row.diff_snippet.replace(/</g, "&lt;")}</code></pre>

  <a href="/" class="btn">自分も無料で生成してみる</a>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}