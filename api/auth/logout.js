import { buildClearSessionCookie } from "./_auth.js";

function json(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(body));
}

function isSecureRequest(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "").toLowerCase();
  return proto === "https";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return json(res, 405, { ok: false, error: "Method not allowed" });
  }

  res.setHeader("Set-Cookie", buildClearSessionCookie(isSecureRequest(req)));
  return json(res, 200, { ok: true, authenticated: false });
}

