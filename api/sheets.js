const READ_ACTIONS = ["health", "fetchAll"];
const WRITE_ACTIONS = [
  "updateStudentStatus",
  "addMonthlyFeeRow",
  "addStudentRow",
  "updateStudentRow",
];

function json(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(body));
}

function hasBody(req) {
  return req.body !== undefined && req.body !== null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return json(res, 405, { ok: false, error: "Method not allowed" });
  }

  const webAppUrl = process.env.SHEETS_WEB_APP_URL || "";
  const writeToken = process.env.SHEETS_WRITE_TOKEN || "";
  if (!webAppUrl) {
    return json(res, 500, {
      ok: false,
      error: "Missing server env: SHEETS_WEB_APP_URL",
    });
  }

  let body = {};
  try {
    body = hasBody(req) ? req.body : {};
    if (typeof body === "string") body = JSON.parse(body || "{}");
  } catch {
    return json(res, 400, { ok: false, error: "Invalid JSON body" });
  }

  const action = String(body.action || "").trim();
  const payload = body.payload || {};
  const knownActions = READ_ACTIONS.concat(WRITE_ACTIONS);
  if (!knownActions.includes(action)) {
    return json(res, 400, { ok: false, error: "Unknown action" });
  }

  try {
    const upstream = await fetch(webAppUrl, {
      method: "POST",
      body: JSON.stringify({ action, payload, token: writeToken }),
    });

    const text = await upstream.text();
    if (!upstream.ok) {
      return json(res, upstream.status, {
        ok: false,
        error: `Apps Script HTTP ${upstream.status}`,
        upstream: text,
      });
    }

    try {
      const parsed = JSON.parse(text);
      return json(res, 200, parsed);
    } catch {
      return json(res, 502, {
        ok: false,
        error: "Apps Script returned non-JSON response",
        upstream: text,
      });
    }
  } catch (error) {
    return json(res, 502, {
      ok: false,
      error: String(error?.message || error),
    });
  }
}
