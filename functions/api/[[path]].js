// Cloudflare Pages Function: /api/* -> Mattilsynet's open aquaculture API (replaces proxy.js, HIVE-1438).
// Same contract as proxy.js: GET only, an allowlist of upstream paths, the Client-Id header added here so the
// browser never needs it, CORS, X-Count exposed, a 5 min cache, and retries on transient upstream 5xx.
// The Client-Id is a fixed app name, not a secret.

const API_ORIGIN = "https://akvakultur-offentlig-api.fisk.mattilsynet.io";
const CLIENT_ID = "trollefsen-fiskehelse-viewer";
// /fiskehelseregisteret/v1/anlegg left the open API in 2026 (401, Maskinporten); helsestatus/v2/lokaliteter
// carries the same localities with their owners (HIVE-1438).
const ALLOWED = ["/api/helsestatus/v2/lokaliteter", "/api/sykdomstilfeller/v1/rapporteringer"];
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Expose-Headers": "X-Count",
};
const MAX_ATTEMPTS = 4;

export const allowed = (path) => ALLOWED.some((p) => path === p || path.startsWith(p + "/"));

export async function onRequest({ request }, { fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: CORS });
  const url = new URL(request.url);
  if (!allowed(url.pathname)) return new Response("Not an allowed endpoint", { status: 404, headers: { ...CORS, "Content-Type": "text/plain" } });

  let upstream, lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      upstream = await fetchImpl(API_ORIGIN + url.pathname + url.search, {
        headers: { "Client-Id": CLIENT_ID, Accept: "application/json" },
        // the edge cache replaces proxy.js's in-memory map: 2xx kept 5 min, errors never cached
        cf: { cacheEverything: true, cacheTtlByStatus: { "200-299": 300, "300-599": 0 } },
      });
      if (upstream.status < 500) break;
      lastErr = new Error(`upstream ${upstream.status}`);
    } catch (err) {
      lastErr = err;
    }
    if (attempt < MAX_ATTEMPTS) await sleep(500 * 2 ** (attempt - 1));
  }
  if (!upstream || upstream.status >= 500) {
    return new Response(JSON.stringify({ error: "Upstream failed after retries", detail: String(lastErr) }), {
      status: 502, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
  const headers = { ...CORS, "Content-Type": upstream.headers.get("content-type") || "application/json" };
  const count = upstream.headers.get("x-count");
  if (count) headers["X-Count"] = count;
  return new Response(upstream.body, { status: upstream.status, headers });
}
