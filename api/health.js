/**
 * Deploy verification endpoint.
 *
 * GET /api/health          -> reports which env vars are configured (no secrets)
 * GET /api/health?probe=1  -> additionally makes one read-only Admin API call
 *                             to confirm the token and scopes actually work
 *
 * If this 404s, Vercel is not serving this directory: check
 * Project -> Settings -> Build & Deployment -> Root Directory.
 */

const API_VERSION = "2025-07";

const SHOP_QUERY = `{ shop { name myshopifyDomain } }`;

const readEnv = (name) => String(process.env[name] || "").trim();

async function probeAdminApi() {
  const domain = readEnv("SHOPIFY_STORE_DOMAIN");
  const token = readEnv("SHOPIFY_ADMIN_TOKEN");
  if (!domain || !token) return { ok: false, error: "Missing store domain or admin token" };

  try {
    const response = await fetch(`https://${domain}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query: SHOP_QUERY }),
      signal: AbortSignal.timeout(6000),
    });

    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: "Admin token rejected (check the token and its scopes)" };
    }

    const json = await response.json().catch(() => null);
    if (!response.ok || !json || json.errors) {
      return {
        ok: false,
        error: `Admin API error (HTTP ${response.status})`,
        detail: JSON.stringify(json?.errors || null)?.slice(0, 300),
      };
    }

    return { ok: true, shop: json.data?.shop?.name || null };
  } catch (error) {
    return { ok: false, error: `Admin API unreachable: ${error.message}` };
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const storeDomain = readEnv("SHOPIFY_STORE_DOMAIN") || null;
  const adminToken = readEnv("SHOPIFY_ADMIN_TOKEN");
  const allowedOrigins = readEnv("ALLOWED_ORIGINS")
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean);

  const body = {
    ok: true,
    service: "one8-back-in-stock",
    apiVersion: API_VERSION,
    nodeEnv: readEnv("NODE_ENV") || null,
    storeDomain,
    // Never echo the token itself — just whether it is present and plausible.
    adminTokenConfigured: Boolean(adminToken),
    adminTokenLooksValid: /^shp(at|ca)_[a-f0-9]{32}$/i.test(adminToken),
    allowedOrigins: allowedOrigins.length
      ? allowedOrigins
      : ["https://one8sports-row.myshopify.com", "https://global.one8.com (default)"],
  };

  if (!storeDomain || !body.adminTokenConfigured) {
    body.ok = false;
    body.error = "Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_TOKEN in this environment";
  } else if (/^https?:\/\//i.test(storeDomain)) {
    body.ok = false;
    body.error = "SHOPIFY_STORE_DOMAIN must be a bare host, e.g. shop.myshopify.com";
  }

  const url = new URL(req.url, "http://localhost");
  if (url.searchParams.get("probe") === "1") {
    body.adminApi = await probeAdminApi();
    if (!body.adminApi.ok) body.ok = false;
  }

  res.status(body.ok ? 200 : 503).json(body);
}
