import {
  buildSessionCookie,
  createSessionToken,
  getAuthConfig,
  getClientKey,
  verifyPasscode,
} from "./_auth.js";

const failedAttempts = new Map();
const lockouts = new Map();

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

  const configuredHash = String(process.env.PASSCODE_HASH || "").trim();
  const cookieSecret = String(process.env.AUTH_COOKIE_SECRET || "").trim();
  if (!configuredHash || !cookieSecret) {
    return json(res, 500, {
      ok: false,
      error: "Missing PASSCODE_HASH or AUTH_COOKIE_SECRET",
    });
  }

  const { sessionMs, maxAttempts, lockoutMs } = getAuthConfig();
  const clientKey = getClientKey(req);
  const lockUntil = lockouts.get(clientKey) || 0;
  const now = Date.now();
  if (lockUntil > now) {
    return json(res, 429, {
      ok: false,
      error: "Too many failed attempts",
      lockedUntil: new Date(lockUntil).toISOString(),
      retryAfterSeconds: Math.ceil((lockUntil - now) / 1000),
    });
  }

  let body = req.body || {};
  if (typeof body === "string") {
    try {
      body = JSON.parse(body || "{}");
    } catch {
      return json(res, 400, { ok: false, error: "Invalid JSON body" });
    }
  }

  const passcode = String(body.passcode || "");
  if (!verifyPasscode(passcode, configuredHash)) {
    const nextCount = (failedAttempts.get(clientKey) || 0) + 1;
    failedAttempts.set(clientKey, nextCount);
    if (nextCount >= maxAttempts) {
      const until = Date.now() + lockoutMs;
      lockouts.set(clientKey, until);
      failedAttempts.delete(clientKey);
      return json(res, 429, {
        ok: false,
        error: "Too many failed attempts",
        lockedUntil: new Date(until).toISOString(),
        retryAfterSeconds: Math.ceil(lockoutMs / 1000),
      });
    }
    return json(res, 401, {
      ok: false,
      error: "Invalid passcode",
      attemptsRemaining: Math.max(maxAttempts - nextCount, 0),
    });
  }

  failedAttempts.delete(clientKey);
  lockouts.delete(clientKey);

  const token = createSessionToken({
    secret: cookieSecret,
    ttlMs: sessionMs,
  });
  const maxAgeSeconds = Math.floor(sessionMs / 1000);
  res.setHeader("Set-Cookie", buildSessionCookie(token, maxAgeSeconds, isSecureRequest(req)));
  return json(res, 200, { ok: true, authenticated: true });
}

