// Google Sheets integration scaffold.
// Recommended approach for private sheets: expose a Google Apps Script Web App endpoint
// and call that endpoint from this frontend.

const SHEETS_WEB_APP_URL = import.meta.env.VITE_SHEETS_WEB_APP_URL || "";
const SHEETS_WRITE_TOKEN = import.meta.env.VITE_SHEETS_WRITE_TOKEN || "";
const SHEETS_PROXY_PATH = "/apps-script";
let lastSheetsRequest = {
  action: "",
  ok: null,
  status: "idle",
  error: "",
  at: "",
};

function getEndpointUrl() {
  // In local dev, use Vite proxy to avoid browser CORS issues with Apps Script.
  if (import.meta.env.DEV) return SHEETS_PROXY_PATH;
  return SHEETS_WEB_APP_URL;
}

function parseNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return false;
}

function normalizeMonthKey(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    return `${year}-${month}`;
  }

  const raw = String(value || "").trim();
  if (!raw) return "";

  if (/^\d{4}-\d{2}$/.test(raw)) return raw;

  const yearMonthMatch = raw.match(/^(\d{4})-(\d{1,2})/);
  if (yearMonthMatch) {
    const year = yearMonthMatch[1];
    const month = yearMonthMatch[2].padStart(2, "0");
    return `${year}-${month}`;
  }

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    const year = parsed.getFullYear();
    const month = String(parsed.getMonth() + 1).padStart(2, "0");
    return `${year}-${month}`;
  }

  return raw;
}

function formatMonthLabel(monthKey) {
  const [year, month] = monthKey.split("-");
  if (!year || !month) return monthKey;
  const date = new Date(Number(year), Number(month) - 1, 1);
  return date.toLocaleString("en-US", { month: "short", year: "numeric" });
}

function normalizeStudent(student) {
  return {
    ...student,
    monthly_fee: parseNumber(student.monthly_fee, 0),
    status: String(student.status || "Active").trim() || "Active",
  };
}

function normalizeFeeRow(row) {
  const monthKey = normalizeMonthKey(row.month_key || row.month_label);
  return {
    ...row,
    month_key: monthKey,
    month_label: formatMonthLabel(monthKey),
    fee_amount: parseNumber(row.fee_amount, 0),
    amount_paid: parseNumber(row.amount_paid, 0),
    balance_due: parseNumber(row.balance_due, 0),
    reminder_sent: parseBoolean(row.reminder_sent),
  };
}

function normalizeSettings(settings) {
  return {
    class_name: settings.class_name || "Mila Nartana",
    default_monthly_fee: parseNumber(settings.default_monthly_fee, 80),
    reminder_day: parseNumber(settings.reminder_day, 5),
    currency: settings.currency || "USD",
    whatsapp_message_template:
      settings.whatsapp_message_template ||
      "Hi, this is a gentle reminder from Mila Nartana. Fee pending for {{student_name}}: {{due_breakdown}}. Total due: {{total_due}}. Thank you.",
  };
}

function unwrapResponseBody(body) {
  // Supports both raw payload and { ok, data } payload styles.
  if (body && typeof body === "object" && "ok" in body) {
    if (!body.ok) {
      throw new Error(body.error || "Google Sheets endpoint returned an error");
    }
    return body.data || {};
  }

  return body || {};
}

async function callSheetsEndpoint(action, payload = {}) {
  if (!SHEETS_WEB_APP_URL) {
    throw new Error("Set VITE_SHEETS_WEB_APP_URL in your .env file");
  }

  lastSheetsRequest = {
    action,
    ok: null,
    status: "pending",
    error: "",
    at: new Date().toISOString(),
  };

  const response = await fetch(getEndpointUrl(), {
    method: "POST",
    // Avoid custom headers so browser skips CORS preflight for Apps Script.
    body: JSON.stringify({ action, payload, token: SHEETS_WRITE_TOKEN }),
  });

  if (!response.ok) {
    lastSheetsRequest = {
      action,
      ok: false,
      status: "http_error",
      error: `HTTP ${response.status}`,
      at: new Date().toISOString(),
    };
    throw new Error(`Sheets request failed: ${response.status}`);
  }

  try {
    const body = await response.json();
    const unwrapped = unwrapResponseBody(body);
    lastSheetsRequest = {
      action,
      ok: true,
      status: "ok",
      error: "",
      at: new Date().toISOString(),
    };
    return unwrapped;
  } catch (error) {
    lastSheetsRequest = {
      action,
      ok: false,
      status: "response_error",
      error: String(error?.message || error),
      at: new Date().toISOString(),
    };
    throw error;
  }
}

export async function fetchAllSheetsData() {
  const data = await callSheetsEndpoint("fetchAll");
  return {
    students: (data.students || []).map(normalizeStudent),
    monthlyFees: (data.monthlyFees || []).map(normalizeFeeRow),
    settings: normalizeSettings(data.settings || {}),
  };
}

export async function updateStudentStatus(studentId, status) {
  // Expected behavior in Apps Script:
  // find student row by student_id and update `status` column.
  return callSheetsEndpoint("updateStudentStatus", { studentId, status });
}

export async function addMonthlyFeeRow(feeRow) {
  // Expected behavior in Apps Script:
  // append one row to the MonthlyFees sheet.
  return callSheetsEndpoint("addMonthlyFeeRow", { feeRow });
}

export async function addStudentRow(studentRow) {
  return callSheetsEndpoint("addStudentRow", { studentRow });
}

export async function updateStudentRow(studentRow) {
  return callSheetsEndpoint("updateStudentRow", { studentRow });
}

export function hasSheetsEndpointConfigured() {
  return Boolean(SHEETS_WEB_APP_URL);
}

export function getSheetsDebugStatus() {
  return {
    endpointConfigured: Boolean(SHEETS_WEB_APP_URL),
    writeTokenConfigured: Boolean(SHEETS_WRITE_TOKEN),
    endpointMode: import.meta.env.DEV ? "vite-proxy" : "direct-webapp",
    lastRequest: lastSheetsRequest,
  };
}
