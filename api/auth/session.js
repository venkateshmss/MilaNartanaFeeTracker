import { getSessionFromRequest } from "./_auth.js";

function json(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return json(res, 405, { ok: false, error: "Method not allowed" });
  }

  const session = getSessionFromRequest(req);
  if (!session) {
    return json(res, 200, { ok: true, authenticated: false });
  }

  return json(res, 200, {
    ok: true,
    authenticated: true,
    expiresAt: new Date(Number(session.exp)).toISOString(),
  });
}

