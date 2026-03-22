import { createHmac, pbkdf2Sync, timingSafeEqual } from "node:crypto";

export const AUTH_COOKIE_NAME = process.env.AUTH_COOKIE_NAME || "mnft_session";

function toBase64Url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(value) {
  const normalized = String(value || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padding = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(`${normalized}${"=".repeat(padding)}`, "base64");
}

function sign(data, secret) {
  return toBase64Url(createHmac("sha256", secret).update(data).digest());
}

export function createSessionToken({
  secret,
  ttlMs,
  user = "owner",
}) {
  const now = Date.now();
  const payload = {
    v: 1,
    sub: user,
    iat: now,
    exp: now + ttlMs,
  };
  const encodedPayload = toBase64Url(Buffer.from(JSON.stringify(payload), "utf8"));
  const signature = sign(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

export function verifySessionToken(token, secret) {
  if (!token || !secret) return null;
  const [payloadPart, signaturePart] = String(token).split(".");
  if (!payloadPart || !signaturePart) return null;

  const expected = sign(payloadPart, secret);
  const left = Buffer.from(signaturePart, "utf8");
  const right = Buffer.from(expected, "utf8");
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;

  try {
    const payload = JSON.parse(fromBase64Url(payloadPart).toString("utf8"));
    if (!payload?.exp || Date.now() > Number(payload.exp)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function parseCookies(req) {
  const raw = String(req.headers.cookie || "");
  if (!raw) return {};
  return raw.split(";").reduce((acc, pair) => {
    const [name, ...rest] = pair.split("=");
    if (!name) return acc;
    acc[name.trim()] = decodeURIComponent(rest.join("=").trim());
    return acc;
  }, {});
}

export function getSessionFromRequest(req) {
  const cookies = parseCookies(req);
  const token = cookies[AUTH_COOKIE_NAME] || "";
  const secret = process.env.AUTH_COOKIE_SECRET || "";
  return verifySessionToken(token, secret);
}

export function getClientKey(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = forwarded || req.socket?.remoteAddress || "unknown";
  const ua = String(req.headers["user-agent"] || "na");
  return `${ip}|${ua.slice(0, 120)}`;
}

export function getAuthConfig() {
  const sessionDays = Number(process.env.AUTH_SESSION_DAYS || 7);
  const maxAttempts = Number(process.env.AUTH_MAX_ATTEMPTS || 5);
  const lockoutMinutes = Number(process.env.AUTH_LOCKOUT_MINUTES || 15);
  return {
    sessionMs: Math.max(1, sessionDays) * 24 * 60 * 60 * 1000,
    maxAttempts: Math.max(1, maxAttempts),
    lockoutMs: Math.max(1, lockoutMinutes) * 60 * 1000,
  };
}

export function verifyPasscode(passcode, configuredHash) {
  const input = String(passcode || "");
  const stored = String(configuredHash || "").trim();
  if (!stored) return false;

  if (stored.startsWith("pbkdf2$")) {
    const [, iterationsRaw, salt, expectedHash] = stored.split("$");
    const iterations = Number(iterationsRaw || 120000);
    if (!salt || !expectedHash) return false;
    const derived = pbkdf2Sync(input, salt, iterations, 32, "sha256");
    const left = Buffer.from(expectedHash, "hex");
    if (left.length !== derived.length) return false;
    return timingSafeEqual(left, derived);
  }

  const left = Buffer.from(stored, "utf8");
  const right = Buffer.from(input, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function buildSessionCookie(token, maxAgeSeconds, secure) {
  const parts = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function buildClearSessionCookie(secure) {
  const parts = [
    `${AUTH_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

