export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS ヘッダー
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // 静的ファイル配信 (Web UI)
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not Found', { status: 404 });
    }

    // AI 生成エンドポイント
    if (url.pathname === '/api/generate' && request.method === 'POST') {
      try {
        const body = await request.json();
        const diff = body.diff;
        const apiKey = request.headers.get('Authorization')?.replace('Bearer ', '') || body.apiKey;

        if (!diff || typeof diff !== 'string') {
          return new Response(JSON.stringify({ error: 'Diff content is required' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Pro キー検証 (環境変数 PRO_KEYS またはプレフィックス pro_live_)
        const isPro = apiKey && (apiKey.startsWith('pro_live_') || apiKey === env.PRO_MASTER_KEY);

        // 無料ユーザーの diff サイズ・レート制御 (簡易防御)
        if (!isPro && diff.length > 5000) {
          return new Response(JSON.stringify({
            error: 'Free limit: Diff too large. Upgrade to Pro ($1/mo) for unlimited large diffs.',
            stripeUrl: 'https://buy.stripe.com/6oU5kDbjJeQ2aBbg1E5J601'
          }), {
            status: 402,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // AI プロンプト作成
        const prompt = `You are an expert developer. Analyze the following git diff and output ONLY a JSON object with two fields:
1. "commit": A standardized commit message strictly following Conventional Commits format (e.g., feat(auth): add token validation). Max 1 line.
2. "pr": A clear and concise Markdown summary of the changes suitable for a Pull Request description.

Git Diff:
\`\`\`
${diff.slice(0, 4000)}
\`\`\`

Respond ONLY with valid JSON format:
{"commit": "...", "pr": "..."}`;

        const aiResponse = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
          messages: [{ role: 'user', content: prompt }],
        });

        const rawText = aiResponse.response || '';
        let jsonRes;
        try {
          const match = rawText.match(/\{[\s\S]*\}/);
          jsonRes = match ? JSON.parse(match[0]) : { commit: rawText.slice(0, 100), pr: rawText };
        } catch {
          jsonRes = {
            commit: 'chore: update changes according to git diff',
            pr: rawText || 'Changes made according to staged diff.',
          };
        }

        return new Response(JSON.stringify({ ...jsonRes, isPro }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not Found', { status: 404 });
  },
};
