export interface Env {
  DB: D1Database;
  STRIPE_WEBHOOK_SECRET: string;
  GEMINI_API_KEY: string;
  STRIPE_PAYMENT_LINK?: string;
}

const STRIPE_PAYMENT_LINK = "https://buy.stripe.com/eVqaEXafF6jw6kV0jG5J603";

const jsonResponse = (data: unknown, status = 200) => {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
    },
  });
};

// Web Crypto API による Stripe 署名検証
async function verifyStripeSignature(payload: string, sigHeader: string, secret: string): Promise<boolean> {
  try {
    const parts = sigHeader.split(",").reduce((acc: Record<string, string>, item) => {
      const [k, v] = item.trim().split("=");
      if (k && v) acc[k] = v;
      return acc;
    }, {});

    const timestamp = parts["t"];
    const expectedSig = parts["v1"];
    if (!timestamp || !expectedSig) return false;

    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - parseInt(timestamp, 10)) > 300) return false;

    const signedPayload = `${timestamp}.${payload}`;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(signedPayload));
    const computedSig = Array.from(new Uint8Array(signatureBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    return computedSig === expectedSig;
  } catch (e) {
    return false;
  }
}

function generateSecureApiKey(): string {
  const randomBytes = new Uint8Array(24);
  crypto.getRandomValues(randomBytes);
  const hex = Array.from(randomBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `app_live_${hex}`;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return jsonResponse({ ok: true });
    }

    // 1. Stripe Webhook: 決済完了で即時 Pro API キー自動発行・プロビジョニング
    if (url.pathname === "/api/webhook" && request.method === "POST") {
      const rawBody = await request.text();
      const sigHeader = request.headers.get("Stripe-Signature") || "";

      const isValid = await verifyStripeSignature(rawBody, sigHeader, env.STRIPE_WEBHOOK_SECRET);
      if (!isValid) {
        return jsonResponse({ error: "Invalid signature" }, 400);
      }

      const event = JSON.parse(rawBody);

      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        const customerEmail = session.customer_details?.email || session.customer_email;
        const customerId = session.customer || "cust_" + crypto.randomUUID().slice(0, 8);

        if (customerEmail) {
          const newApiKey = generateSecureApiKey();
          const userId = "usr_" + crypto.randomUUID();

          await env.DB.prepare(`
            INSERT INTO users (id, email, api_key, plan, usage_count, usage_limit, stripe_customer_id, updated_at)
            VALUES (?, ?, ?, 'pro', 0, 999999, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(email) DO UPDATE SET
              plan = 'pro',
              usage_limit = 999999,
              api_key = excluded.api_key,
              stripe_customer_id = excluded.stripe_customer_id,
              updated_at = CURRENT_TIMESTAMP
          `).bind(userId, customerEmail, newApiKey, customerId).run();

          console.log(`[ZERO-TOUCH PROVISION] User ${customerEmail} upgraded to PRO. API Key: ${newApiKey}`);
        }
      }

      return jsonResponse({ received: true });
    }

    // 2. コアAPI: Conventional Commit 生成 & 利用枠制限
    if (url.pathname === "/api/generate" && request.method === "POST") {
      const apiKey = request.headers.get("X-API-Key") || request.headers.get("Authorization")?.replace("Bearer ", "");
      const body = await request.json() as { diff?: string; email?: string };

      if (!body.diff) {
        return jsonResponse({ error: "Diff content is required" }, 400);
      }

      let user: any = null;

      if (apiKey) {
        user = await env.DB.prepare("SELECT * FROM users WHERE api_key = ?").bind(apiKey).first();
      } else if (body.email) {
        user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(body.email).first();
        if (!user) {
          const freeApiKey = generateSecureApiKey();
          const newId = "usr_" + crypto.randomUUID();
          await env.DB.prepare(`
            INSERT INTO users (id, email, api_key, plan, usage_count, usage_limit)
            VALUES (?, ?, ?, 'free', 0, 10)
          `).bind(newId, body.email, freeApiKey).run();

          user = { id: newId, email: body.email, api_key: freeApiKey, plan: "free", usage_count: 0, usage_limit: 10 };
        }
      } else {
        return jsonResponse({ error: "API Key or Email required" }, 401);
      }

      if (!user) {
        return jsonResponse({ error: "Invalid API Key" }, 403);
      }

      if (user.usage_count >= user.usage_limit) {
        return jsonResponse({
          error: "Monthly usage limit reached. Upgrade to Pro for unlimited access.",
          upgrade_url: STRIPE_PAYMENT_LINK,
          current_usage: user.usage_count,
          limit: user.usage_limit,
        }, 429);
      }

      const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;
      const prompt = `You are an expert Git commit generator. Analyze the following diff and output a single, highly accurate Conventional Commit message (e.g. feat(auth): add stripe webhook verification). No markdown backticks, no intro, just the message.\n\nDiff:\n${body.diff.slice(0, 10000)}`;

      const aiRes = await fetch(geminiEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 100, temperature: 0.2 },
        }),
      });

      if (!aiRes.ok) {
        return jsonResponse({ error: "AI Inference failed" }, 500);
      }

      const aiData: any = await aiRes.json();
      const commitMessage = aiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "chore: update codebase";

      await env.DB.prepare("UPDATE users SET usage_count = usage_count + 1 WHERE id = ?").bind(user.id).run();

      return jsonResponse({
        commit_message: commitMessage,
        plan: user.plan,
        usage: user.usage_count + 1,
        limit: user.usage_limit,
      });
    }

    // 3. 24/7 自律型 AI サポート: チケット自動完結
    if (url.pathname === "/api/support" && request.method === "POST") {
      const { email, query } = await request.json() as { email: string; query: string };

      if (!query) {
        return jsonResponse({ error: "Query is required" }, 400);
      }

      const systemPrompt = `You are the autonomous 24/7 support lead for 'AI Commit Pro'.
You solve customer inquiries immediately and politely without escalating to human founders.
Product knowledge:
- Core product: AI commit & PR generator CLI (npx ai-commit-pro-cli) and Web app.
- Free Plan: 10 requests / month.
- Pro Plan: $11/month, unlimited usage, instant API key generation via Stripe checkout.
- Webhook auto-provisions API keys with prefix 'app_live_'.
- CLI usage: Stage diffs ('git add .') then run 'npx ai-commit-pro-cli'.
- If they ask for human support: Assure them that issues are processed instantly by this system and guide them step-by-step.
Keep answers concise, actionable, and courteous.`;

      const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;
      const aiRes = await fetch(geminiEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ parts: [{ text: `User query: ${query}` }] }],
          generationConfig: { maxOutputTokens: 300, temperature: 0.3 },
        }),
      });

      const aiData: any = await aiRes.json();
      const answer = aiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "Thank you for reaching out. Please verify your API key and retry.";

      const ticketId = "tkt_" + crypto.randomUUID();
      await env.DB.prepare(`
        INSERT INTO support_tickets (id, user_email, query, ai_response, resolved_status)
        VALUES (?, ?, ?, ?, 'auto_resolved')
      `).bind(ticketId, email || "anonymous", query, answer).run();

      return jsonResponse({
        ticket_id: ticketId,
        response: answer,
        status: "resolved",
      });
    }

    // 4. フロントエンド SPA 配信
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(getLandingPageHtml(STRIPE_PAYMENT_LINK), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};

function getLandingPageHtml(paymentLink: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Commit & PR Pro — Edge AI Commit Generator</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { background-color: #0d1117; color: #c9d1d9; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
  </style>
</head>
<body class="min-h-screen flex flex-col justify-between">
  <div class="max-w-4xl mx-auto px-4 py-12 w-full">
    <!-- Header -->
    <header class="flex justify-between items-center pb-8 border-b border-gray-800">
      <div class="flex items-center space-x-3">
        <span class="text-2xl font-bold text-white tracking-tight">⚡ AI Commit & PR Pro</span>
        <span class="text-xs bg-emerald-900/60 text-emerald-400 border border-emerald-700/50 px-2 py-0.5 rounded-full font-mono">v2.0 Live</span>
      </div>
      <a href="${paymentLink}" target="_blank" class="bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold px-4 py-2 rounded-lg shadow transition">
        Upgrade to Pro ($11/mo)
      </a>
    </header>

    <!-- Hero -->
    <section class="text-center my-12">
      <h1 class="text-4xl sm:text-5xl font-extrabold text-white tracking-tight leading-tight">
        Never write git commits or PR notes manually again.
      </h1>
      <p class="mt-4 text-lg text-gray-400 max-w-2xl mx-auto">
        Turn staged diffs into Conventional Commits & Changelogs in under 500ms using Edge AI. Built for professional developers and fast-moving teams.
      </p>
      <div class="mt-6 flex justify-center items-center gap-4">
        <div class="bg-gray-900 border border-gray-700 px-4 py-2 rounded-lg font-mono text-sm text-gray-300">
          $ npx ai-commit-pro-cli
        </div>
      </div>
    </section>

    <!-- Web Generator Tool -->
    <section class="bg-gray-900/80 border border-gray-800 rounded-xl p-6 shadow-xl mb-12">
      <h2 class="text-lg font-semibold text-white mb-4">Web Audit & Generator</h2>
      <div class="space-y-4">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <input id="apiKeyInput" type="text" placeholder="API Key (Leave empty for Free Tier)" class="bg-gray-950 border border-gray-800 rounded-lg p-3 text-sm text-white focus:outline-none focus:border-blue-500">
          <input id="emailInput" type="email" placeholder="Your Email (for Free tier tracking)" class="bg-gray-950 border border-gray-800 rounded-lg p-3 text-sm text-white focus:outline-none focus:border-blue-500">
        </div>
        <textarea id="diffInput" rows="5" placeholder="Paste your 'git diff --staged' here..." class="w-full bg-gray-950 border border-gray-800 rounded-lg p-3 text-sm font-mono text-white focus:outline-none focus:border-blue-500"></textarea>
        <button onclick="generateCommit()" id="genBtn" class="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-semibold py-3 rounded-lg transition">
          Generate Commit Message
        </button>
      </div>
      <div id="resultBox" class="mt-4 p-4 rounded-lg bg-gray-950 border border-gray-800 font-mono text-emerald-400 hidden"></div>
    </section>

    <!-- Pricing Card -->
    <section class="bg-gradient-to-b from-gray-900 to-gray-950 border border-gray-800 rounded-xl p-6 mb-12 text-center">
      <h3 class="text-xl font-bold text-white mb-2">Pro Developer Plan</h3>
      <p class="text-3xl font-extrabold text-white my-3">$11 <span class="text-sm text-gray-400 font-normal">/ month</span></p>
      <p class="text-sm text-gray-400 mb-6 max-w-md mx-auto">Unlimited commit generation, PR summary automation, and instant API access with zero rate limits.</p>
      <a href="${paymentLink}" target="_blank" class="inline-block bg-blue-600 hover:bg-blue-500 text-white font-semibold px-6 py-3 rounded-lg transition">
        Get Instant Pro Access
      </a>
    </section>

    <!-- 24/7 AI Support -->
    <section class="bg-gray-900/40 border border-gray-800 rounded-xl p-6">
      <div class="flex items-center space-x-2 mb-3">
        <div class="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></div>
        <h3 class="text-sm font-semibold text-white">24/7 Autonomous AI Support</h3>
      </div>
      <p class="text-xs text-gray-400 mb-4">Instant answers regarding Pro API keys, CLI setup, and billing queries.</p>
      <div class="flex gap-2">
        <input id="supportQuery" type="text" placeholder="e.g. How do I setup the CLI with my Pro key?" class="flex-1 bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500">
        <button onclick="askSupport()" class="bg-gray-800 hover:bg-gray-700 text-white text-sm px-4 py-2 rounded-lg transition">Ask</button>
      </div>
      <div id="supportAnswer" class="mt-3 text-sm text-gray-300 p-3 bg-gray-950 rounded-lg border border-gray-800/80 hidden"></div>
    </section>
  </div>

  <footer class="border-t border-gray-900 py-6 text-center text-xs text-gray-600">
    Zero-touch autonomous SaaS running on Cloudflare Edge & Gemini.
  </footer>

  <script>
    async function generateCommit() {
      const btn = document.getElementById('genBtn');
      const box = document.getElementById('resultBox');
      const diff = document.getElementById('diffInput').value;
      const apiKey = document.getElementById('apiKeyInput').value;
      const email = document.getElementById('emailInput').value;

      if (!diff) return alert('Please enter git diff output');
      btn.disabled = true;
      btn.innerText = 'Analyzing with Gemini...';
      box.classList.add('hidden');

      try {
        const res = await fetch('/api/generate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { 'X-API-Key': apiKey } : {})
          },
          body: JSON.stringify({ diff, email: email || 'anonymous@user.com' })
        });
        const data = await res.json();
        box.classList.remove('hidden');
        if (!res.ok) {
          box.innerHTML = '<span class="text-rose-400">' + (data.error || 'Error occurred') + '</span>';
        } else {
          box.innerHTML = '<strong>Generated:</strong> ' + data.commit_message + '<div class="text-xs text-gray-500 mt-2">Usage: ' + data.usage + '/' + data.limit + ' (' + data.plan + ')</div>';
        }
      } catch (err) {
        alert('Request failed');
      } finally {
        btn.disabled = false;
        btn.innerText = 'Generate Commit Message';
      }
    }

    async function askSupport() {
      const q = document.getElementById('supportQuery').value;
      const ansBox = document.getElementById('supportAnswer');
      if (!q) return;
      ansBox.classList.remove('hidden');
      ansBox.innerText = 'AI Support Agent is typing...';

      const res = await fetch('/api/support', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q })
      });
      const data = await res.json();
      ansBox.innerText = data.response || 'Unable to process query.';
    }
  </script>
</body>
</html>`;
}
