import { writeSampleDataFiles } from "./lib/sample-data-writer.mjs";
import fs from "node:fs/promises";
import path from "node:path";

function unwrapResponseBody(body) {
  if (body && typeof body === "object" && "ok" in body) {
    if (!body.ok) throw new Error(body.error || "Apps Script returned an error.");
    return body.data || {};
  }
  return body || {};
}

async function fetchLiveData() {
  const endpoint = String(process.env.SHEETS_WEB_APP_URL || "").trim();
  const token = String(process.env.SHEETS_WRITE_TOKEN || "").trim();

  if (!endpoint) {
    throw new Error("SHEETS_WEB_APP_URL is required.");
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "fetchAll",
      token,
      payload: {},
    }),
  });

  if (!response.ok) {
    throw new Error(`Apps Script fetchAll failed with HTTP ${response.status}.`);
  }

  const body = await response.json();
  return unwrapResponseBody(body);
}

function normalizeMonthKey(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}$/.test(raw)) return raw;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function buildSummary(data) {
  const students = Array.isArray(data.students) ? data.students : [];
  const monthlyFees = Array.isArray(data.monthlyFees) ? data.monthlyFees : [];

  const statusCounts = monthlyFees.reduce(
    (acc, row) => {
      const status = String(row.status || "").trim().toLowerCase();
      if (status === "paid") acc.paid += 1;
      else if (status === "partial") acc.partial += 1;
      else acc.pending += 1;
      return acc;
    },
    { paid: 0, partial: 0, pending: 0 },
  );

  const monthKeys = monthlyFees
    .map((row) => normalizeMonthKey(row.month_key || row.month_label))
    .filter(Boolean)
    .sort();

  const monthRange =
    monthKeys.length > 0
      ? { from: monthKeys[0], to: monthKeys[monthKeys.length - 1] }
      : { from: "-", to: "-" };

  return {
    generatedAt: new Date().toISOString(),
    studentsCount: students.length,
    monthlyFeesCount: monthlyFees.length,
    settingsCount: Object.keys(data.settings || {}).length,
    monthRange,
    statusCounts,
  };
}

async function writeSummaryMarkdown(summary, summaryPath) {
  if (!summaryPath) return;
  const absolutePath = path.isAbsolute(summaryPath)
    ? summaryPath
    : path.join(process.cwd(), summaryPath);
  const dir = path.dirname(absolutePath);
  await fs.mkdir(dir, { recursive: true });

  const markdown = [
    "### Sync summary",
    "",
    `- Generated at: ${summary.generatedAt}`,
    `- Students: ${summary.studentsCount}`,
    `- Monthly fee rows: ${summary.monthlyFeesCount}`,
    `- Settings keys: ${summary.settingsCount}`,
    `- Month range: ${summary.monthRange.from} -> ${summary.monthRange.to}`,
    `- Status rows: Paid ${summary.statusCounts.paid}, Partial ${summary.statusCounts.partial}, Pending ${summary.statusCounts.pending}`,
    "",
  ].join("\n");

  await fs.writeFile(absolutePath, markdown, "utf8");
}

async function main() {
  const data = await fetchLiveData();
  const result = await writeSampleDataFiles({
    students: data.students || [],
    monthlyFees: data.monthlyFees || [],
    settings: data.settings || {},
    projectRoot: process.cwd(),
  });
  const summary = buildSummary(data);
  await writeSummaryMarkdown(summary, process.env.SYNC_SUMMARY_PATH);

  console.log(`Students written: ${result.studentsCount}`);
  console.log(`Monthly fee rows written: ${result.monthlyFeesCount}`);
  console.log(`Settings rows written: ${result.settingsCount}`);
  console.log(`Month range: ${summary.monthRange.from} -> ${summary.monthRange.to}`);
  console.log(
    `Status rows: Paid ${summary.statusCounts.paid}, Partial ${summary.statusCounts.partial}, Pending ${summary.statusCounts.pending}`,
  );
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
