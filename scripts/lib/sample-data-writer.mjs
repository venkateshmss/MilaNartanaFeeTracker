import fs from "node:fs/promises";
import path from "node:path";

export const STUDENT_HEADERS = [
  "student_id",
  "student_name",
  "parent_name",
  "email",
  "whatsapp_number",
  "alternate_phone",
  "address",
  "location",
  "monthly_fee",
  "join_month",
  "status",
  "notes",
];

export const MONTHLY_FEE_HEADERS = [
  "fee_row_id",
  "student_id",
  "student_name",
  "month_key",
  "month_label",
  "fee_amount",
  "amount_paid",
  "balance_due",
  "status",
  "payment_date",
  "payment_mode",
  "payment_ref",
  "reminder_sent",
  "reminder_sent_date",
  "notes",
];

export const SETTINGS_HEADERS = ["setting_key", "setting_value"];

const DEFAULT_SETTINGS = {
  class_name: "Mila Nartana",
  default_monthly_fee: "80",
  reminder_day: "5",
  currency: "USD",
  whatsapp_message_template:
    "Hi, this is a gentle reminder from Mila Nartana. Fee pending for {{student_name}}: {{due_breakdown}}. Total due: {{total_due}}. Thank you.",
};

function toAbsolute(projectRoot, targetPath) {
  return path.isAbsolute(targetPath) ? targetPath : path.join(projectRoot, targetPath);
}

function normalizeMonthKey(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    return `${year}-${month}`;
  }
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}$/.test(raw)) return raw;

  const yearMonth = raw.match(/^(\d{4})-(\d{1,2})/);
  if (yearMonth) {
    return `${yearMonth[1]}-${yearMonth[2].padStart(2, "0")}`;
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function formatMonthLabel(monthKey) {
  const [year, month] = String(monthKey || "").split("-");
  if (!year || !month) return String(monthKey || "");
  const date = new Date(Number(year), Number(month) - 1, 1);
  return date.toLocaleString("en-US", { month: "short", year: "numeric" });
}

function asString(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asCsvBoolean(value) {
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "true") return "True";
    if (lower === "false") return "False";
  }
  return "False";
}

function safeCompare(a, b) {
  return String(a || "").localeCompare(String(b || ""));
}

function normalizeStudents(students = []) {
  return [...students]
    .map((student) => {
      const monthlyFee = Math.max(0, Math.round(asNumber(student.monthly_fee, 0)));
      return {
        student_id: asString(student.student_id),
        student_name: asString(student.student_name),
        parent_name: asString(student.parent_name),
        email: asString(student.email),
        whatsapp_number: asString(student.whatsapp_number),
        alternate_phone: asString(student.alternate_phone),
        address: asString(student.address),
        location: asString(student.location),
        monthly_fee: monthlyFee,
        join_month: normalizeMonthKey(student.join_month),
        status: asString(student.status || "Active") || "Active",
        notes: asString(student.notes),
      };
    })
    .filter((student) => student.student_id && student.student_name)
    .sort((a, b) => safeCompare(a.student_id, b.student_id));
}

function normalizeMonthlyFees(monthlyFees = []) {
  return [...monthlyFees]
    .map((row) => {
      const monthKey = normalizeMonthKey(row.month_key || row.month_label);
      const feeAmount = Math.max(0, Math.round(asNumber(row.fee_amount, 0)));
      const amountPaid = Math.max(0, Math.round(asNumber(row.amount_paid, 0)));
      let balanceDue = Math.round(asNumber(row.balance_due, feeAmount - amountPaid));
      if (!Number.isFinite(balanceDue)) balanceDue = Math.max(feeAmount - amountPaid, 0);
      balanceDue = Math.max(balanceDue, 0);

      const normalized = {
        fee_row_id: asString(row.fee_row_id),
        student_id: asString(row.student_id),
        student_name: asString(row.student_name),
        month_key: monthKey,
        month_label: asString(row.month_label) || formatMonthLabel(monthKey),
        fee_amount: feeAmount,
        amount_paid: amountPaid,
        balance_due: balanceDue,
        status: asString(row.status),
        payment_date: asString(row.payment_date),
        payment_mode: asString(row.payment_mode),
        payment_ref: asString(row.payment_ref),
        reminder_sent: asCsvBoolean(row.reminder_sent),
        reminder_sent_date: asString(row.reminder_sent_date),
        notes: asString(row.notes),
      };

      if (!normalized.status) {
        if (normalized.balance_due <= 0 && normalized.fee_amount > 0) normalized.status = "Paid";
        else if (normalized.amount_paid > 0) normalized.status = "Partial";
        else normalized.status = "Pending";
      }

      return normalized;
    })
    .filter((row) => row.student_id && row.month_key)
    .sort((a, b) => {
      return (
        safeCompare(a.student_id, b.student_id) ||
        safeCompare(a.month_key, b.month_key) ||
        safeCompare(a.fee_row_id, b.fee_row_id)
      );
    });
}

function normalizeSettings(settingsInput = {}) {
  const settings = {};
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    settings[key] = asString(settingsInput[key]) || value;
  }
  for (const [key, value] of Object.entries(settingsInput)) {
    if (!key) continue;
    settings[key] = asString(value);
  }
  return settings;
}

function toCsv(headers, rows) {
  const escape = (value) => {
    const raw = value === null || value === undefined ? "" : String(value);
    return `"${raw.replace(/"/g, "\"\"")}"`;
  };
  const lines = [headers.map(escape).join(",")];
  for (const row of rows) {
    lines.push(headers.map((header) => escape(row[header])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function buildMockDataJs({ settings, students, monthlyFees }) {
  const monthOptions = [...new Set(monthlyFees.map((row) => row.month_key))]
    .filter(Boolean)
    .sort((a, b) => safeCompare(a, b))
    .map((monthKey) => ({ key: monthKey, label: formatMonthLabel(monthKey) }));

  const lines = [];
  lines.push(`export const settings = ${JSON.stringify(settings, null, 2)};`);
  lines.push("// These objects mirror the future Google Sheets Students sheet columns.");
  lines.push(`export const students = ${JSON.stringify(students, null, 2)};`);
  lines.push("// These rows mirror the future Google Sheets MonthlyFees sheet design.");
  lines.push(`export const monthlyFees = ${JSON.stringify(monthlyFees, null, 2)};`);
  lines.push(`export const monthOptions = ${JSON.stringify(monthOptions, null, 2)};`);
  lines.push(`export const paymentFormDefaults = {
  student_id: students[0]?.student_id || "",
  month_key: monthOptions[monthOptions.length - 1]?.key || "",
  payment_mode: "Online",
  transfer_date: new Date().toISOString().slice(0, 10),
  fee_override: "",
  amount_received: "",
};
`);
  return `${lines.join("\n")}\n`;
}

export async function writeSampleDataFiles({
  students,
  monthlyFees,
  settings,
  projectRoot = process.cwd(),
  paths = {},
}) {
  const outPaths = {
    studentsCsv: toAbsolute(projectRoot, paths.studentsCsv || "data/samples/Students.sample.csv"),
    monthlyFeesCsv: toAbsolute(
      projectRoot,
      paths.monthlyFeesCsv || "data/samples/MonthlyFees.sample.csv",
    ),
    settingsCsv: toAbsolute(projectRoot, paths.settingsCsv || "data/samples/Settings.sample.csv"),
    mockDataJs: toAbsolute(projectRoot, paths.mockDataJs || "src/data/mockData.js"),
  };

  const normalizedStudents = normalizeStudents(students);
  const normalizedMonthlyFees = normalizeMonthlyFees(monthlyFees);
  const normalizedSettings = normalizeSettings(settings);

  const settingsRows = Object.entries(normalizedSettings)
    .sort((a, b) => safeCompare(a[0], b[0]))
    .map(([setting_key, setting_value]) => ({ setting_key, setting_value }));

  await fs.mkdir(path.dirname(outPaths.studentsCsv), { recursive: true });
  await fs.mkdir(path.dirname(outPaths.monthlyFeesCsv), { recursive: true });
  await fs.mkdir(path.dirname(outPaths.settingsCsv), { recursive: true });
  await fs.mkdir(path.dirname(outPaths.mockDataJs), { recursive: true });

  await fs.writeFile(outPaths.studentsCsv, toCsv(STUDENT_HEADERS, normalizedStudents), "utf8");
  await fs.writeFile(
    outPaths.monthlyFeesCsv,
    toCsv(MONTHLY_FEE_HEADERS, normalizedMonthlyFees),
    "utf8",
  );
  await fs.writeFile(outPaths.settingsCsv, toCsv(SETTINGS_HEADERS, settingsRows), "utf8");
  await fs.writeFile(
    outPaths.mockDataJs,
    buildMockDataJs({
      settings: normalizedSettings,
      students: normalizedStudents,
      monthlyFees: normalizedMonthlyFees.map((row) => ({
        ...row,
        reminder_sent: String(row.reminder_sent).toLowerCase() === "true",
      })),
    }),
    "utf8",
  );

  return {
    studentsCount: normalizedStudents.length,
    monthlyFeesCount: normalizedMonthlyFees.length,
    settingsCount: settingsRows.length,
    paths: outPaths,
  };
}
