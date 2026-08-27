export async function onRequestGet(context) {
  const { env, request } = context;
  const origin = new URL(request.url).origin;

  let urls = "";
  if (env.DB) {
    const { results } = await env.DB.prepare(
      "SELECT id, created_at FROM snippets ORDER BY created_at DESC LIMIT 500"
    ).all();

    urls = (results || []).map(r => `
    <url>
      <loc>${origin}/c/${r.id}</loc>
      <lastmod>${new Date(r.created_at).toISOString().split('T')[0]}</lastmod>
      <changefreq>monthly</changefreq>
    </url>`).join('');
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${origin}/</loc><priority>1.0</priority></url>
  ${urls}
</urlset>`;

  return new Response(xml.trim(), {
    headers: { "Content-Type": "application/xml; charset=utf-8" }
  });
}