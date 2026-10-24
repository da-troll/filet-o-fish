// Pages Function contract (HIVE-1438): node --test test/
import test from "node:test";
import assert from "node:assert/strict";
import { onRequest, allowed } from "../functions/api/[[path]].js";

const req = (path, method = "GET") => ({ request: new Request(`https://fish.example${path}`, { method }) });
const upstream = (status, body = "[]", headers = {}) => new Response(body, { status, headers: { "content-type": "application/json", ...headers } });
const noSleep = async () => {};

test("OPTIONS answers 204 with CORS", async () => {
  const r = await onRequest(req("/api/sykdomstilfeller/v1/rapporteringer", "OPTIONS"));
  assert.equal(r.status, 204);
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
});

test("non-GET is 405 and never reaches upstream", async () => {
  let called = false;
  const r = await onRequest(req("/api/sykdomstilfeller/v1/rapporteringer", "POST"), { fetchImpl: async () => { called = true; } });
  assert.equal(r.status, 405);
  assert.equal(called, false);
});

test("allowlist: exact paths and sub-paths only", () => {
  assert.ok(allowed("/api/helsestatus/v2/lokaliteter"));
  assert.ok(allowed("/api/sykdomstilfeller/v1/rapporteringer/abc"));
  assert.ok(!allowed("/api/sykdomstilfeller/v1/rapporteringerX"));
  assert.ok(!allowed("/api/lakselus/v2/rapporteringer"));
  assert.ok(!allowed("/api/fiskehelseregisteret/v1/anlegg"));
});

test("disallowed path is 404 and never reaches upstream", async () => {
  let called = false;
  const r = await onRequest(req("/api/driftsplaner/v1/aktive/abonnement"), { fetchImpl: async () => { called = true; } });
  assert.equal(r.status, 404);
  assert.equal(called, false);
});

test("forwards path + query, adds Client-Id and the 5 min edge cache, passes X-Count through", async () => {
  let seen;
  const r = await onRequest(req("/api/helsestatus/v2/lokaliteter?limit=50&offset=0"), {
    fetchImpl: async (url, init) => { seen = { url, init }; return upstream(200, "[1]", { "x-count": "1531" }); },
  });
  assert.equal(seen.url, "https://akvakultur-offentlig-api.fisk.mattilsynet.io/api/helsestatus/v2/lokaliteter?limit=50&offset=0");
  assert.equal(seen.init.headers["Client-Id"], "trollefsen-fiskehelse-viewer");
  assert.equal(seen.init.cf.cacheTtlByStatus["200-299"], 300);
  assert.equal(seen.init.cf.cacheTtlByStatus["300-599"], 0);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-count"), "1531");
  assert.equal(r.headers.get("access-control-expose-headers"), "X-Count");
  assert.equal(await r.text(), "[1]");
});

test("transient 5xx and network errors are retried, then the success is returned", async () => {
  const seq = [upstream(500), new Error("reset"), upstream(503), upstream(200, "[2]")];
  let n = 0;
  const r = await onRequest(req("/api/sykdomstilfeller/v1/rapporteringer"), {
    sleep: noSleep, fetchImpl: async () => { const x = seq[n++]; if (x instanceof Error) throw x; return x; },
  });
  assert.equal(n, 4);
  assert.equal(r.status, 200);
});

test("4 failed attempts give 502", async () => {
  let n = 0;
  const r = await onRequest(req("/api/sykdomstilfeller/v1/rapporteringer"), { sleep: noSleep, fetchImpl: async () => { n++; return upstream(500); } });
  assert.equal(n, 4);
  assert.equal(r.status, 502);
});

test("a 4xx is passed through, not retried", async () => {
  let n = 0;
  const r = await onRequest(req("/api/helsestatus/v2/lokaliteter"), { sleep: noSleep, fetchImpl: async () => { n++; return upstream(401, ""); } });
  assert.equal(n, 1);
  assert.equal(r.status, 401);
});
