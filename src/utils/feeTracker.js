export function getCurrencyFormatter(currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  });
}

export function filterFeesByMonth(monthlyFees, monthKey) {
  return monthlyFees.filter((fee) => fee.month_key === monthKey);
}

function normalizeMonthKey(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}$/.test(raw)) return raw;
  if (/^\d{4}-\d{1,2}$/.test(raw)) {
    const [year, month] = raw.split("-");
    return `${year}-${String(month).padStart(2, "0")}`;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";
  return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}`;
}

function formatMonthLabel(monthKey) {
  const [year, month] = monthKey.split("-");
  if (!year || !month) return monthKey;
  const date = new Date(Number(year), Number(month) - 1, 1);
  return date.toLocaleString("en-US", { month: "short", year: "numeric" });
}

function monthKeyToNumber(monthKey) {
  const [year, month] = String(monthKey || "").split("-");
  if (!year || !month) return Number.NaN;
  return Number(year) * 12 + Number(month);
}

function numberToMonthKey(value) {
  const year = Math.floor((value - 1) / 12);
  const month = ((value - 1) % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

function enumerateMonths(startMonthKey, endMonthKey) {
  const start = monthKeyToNumber(startMonthKey);
  const end = monthKeyToNumber(endMonthKey);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return [];

  const keys = [];
  for (let cursor = start; cursor <= end; cursor += 1) {
    keys.push(numberToMonthKey(cursor));
  }
  return keys;
}

function deriveFeeStatus(totalPaid, feeAmount) {
  if (feeAmount <= 0) return "Paid";
  if (totalPaid <= 0) return "Pending";
  if (totalPaid >= feeAmount) return "Paid";
  return "Partial";
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getEffectiveAmountPaid(row) {
  const feeAmount = toNumber(row.fee_amount, 0);
  const amountPaidRaw = row.amount_paid;
  const hasAmountPaid =
    amountPaidRaw !== null &&
    amountPaidRaw !== undefined &&
    String(amountPaidRaw).trim() !== "";
  if (hasAmountPaid) return Math.max(toNumber(amountPaidRaw, 0), 0);

  const status = String(row.status || "").trim().toLowerCase();
  if (status === "paid") return feeAmount;

  const balanceRaw = row.balance_due;
  const hasBalance =
    balanceRaw !== null &&
    balanceRaw !== undefined &&
    String(balanceRaw).trim() !== "";
  if (hasBalance) return Math.max(feeAmount - toNumber(balanceRaw, feeAmount), 0);

  return 0;
}

export function aggregateMonthlyFees(monthlyFees) {
  const buckets = new Map();

  for (const fee of monthlyFees) {
    const key = `${fee.student_id}|${normalizeMonthKey(fee.month_key)}`;
    const current = buckets.get(key) || [];
    current.push(fee);
    buckets.set(key, current);
  }

  return Array.from(buckets.values()).map((rows) => {
    const sortedRows = [...rows].sort((a, b) =>
      String(a.payment_date || "").localeCompare(String(b.payment_date || "")),
    );
    const latestRow = sortedRows[sortedRows.length - 1] || rows[0];
    const totalPaid = rows.reduce((sum, row) => sum + getEffectiveAmountPaid(row), 0);
    const feeAmount = toNumber(latestRow?.fee_amount, 0);
    return {
      fee_row_id: latestRow?.fee_row_id,
      student_id: latestRow?.student_id,
      student_name: latestRow?.student_name,
      month_key: normalizeMonthKey(latestRow?.month_key),
      month_label:
        latestRow?.month_label || formatMonthLabel(normalizeMonthKey(latestRow?.month_key)),
      payment_mode: latestRow?.payment_mode || "",
      fee_amount: feeAmount,
      amount_paid: totalPaid,
      balance_due: Math.max(feeAmount - totalPaid, 0),
      status: deriveFeeStatus(totalPaid, feeAmount),
    };
  });
}

function getMaxKnownMonthKey(monthlyFees, fallbackMonthKey = "") {
  const normalized = monthlyFees
    .map((fee) => normalizeMonthKey(fee.month_key))
    .filter(Boolean);
  if (fallbackMonthKey) normalized.push(normalizeMonthKey(fallbackMonthKey));
  return normalized.sort().at(-1) || normalizeMonthKey(fallbackMonthKey);
}

function buildStudentLedger(student, aggregatedFees, upToMonthKey) {
  const joinMonth = normalizeMonthKey(student.join_month);
  if (!joinMonth || !upToMonthKey) return [];

  const rowsByMonth = new Map(
    aggregatedFees
      .filter((fee) => fee.student_id === student.student_id)
      .map((fee) => [normalizeMonthKey(fee.month_key), fee]),
  );
  const monthKeys = enumerateMonths(joinMonth, upToMonthKey);

  return monthKeys.map((monthKey) => {
    const existing = rowsByMonth.get(monthKey);
    if (existing) {
      return {
        ...existing,
        month_key: monthKey,
        month_label: existing.month_label || formatMonthLabel(monthKey),
      };
    }

    const feeAmount = Number(student.monthly_fee || 0);
    return {
      fee_row_id: `${student.student_id}-${monthKey}-auto`,
      student_id: student.student_id,
      student_name: student.student_name,
      month_key: monthKey,
      month_label: formatMonthLabel(monthKey),
      payment_mode: "",
      fee_amount: feeAmount,
      amount_paid: 0,
      balance_due: feeAmount,
      status: feeAmount > 0 ? "Pending" : "Paid",
    };
  });
}

export function getMonthlySummary(monthlyFees, monthKey) {
  const filteredFees = filterFeesByMonth(aggregateMonthlyFees(monthlyFees), monthKey);

  return filteredFees.reduce(
    (summary, fee) => {
      if (fee.status === "Paid") summary.paid += 1;
      if (fee.status === "Pending") summary.pending += 1;
      if (fee.status === "Partial") summary.partial += 1;
      return summary;
    },
    { paid: 0, pending: 0, partial: 0 },
  );
}

export function getStudentStatuses(students, monthlyFees, monthKey) {
  const aggregatedFees = aggregateMonthlyFees(monthlyFees);
  const maxMonthKey = getMaxKnownMonthKey(aggregatedFees, monthKey);

  return students.map((student) => {
    const ledger = buildStudentLedger(student, aggregatedFees, maxMonthKey);
    const selectedMonthFee = ledger.find((fee) => fee.month_key === monthKey);

    const dueRows = ledger.filter(
      (fee) =>
        (fee.status === "Pending" || fee.status === "Partial") &&
        fee.balance_due > 0,
    );

    const dueAmount = dueRows.reduce((sum, fee) => sum + fee.balance_due, 0);
    const lastPayment = [...monthlyFees]
      .filter((fee) => fee.student_id === student.student_id && fee.amount_paid > 0)
      .sort((a, b) => new Date(b.payment_date) - new Date(a.payment_date))[0];

    return {
      ...student,
      selectedMonth: selectedMonthFee?.month_label ?? monthKey,
      selectedMonthStatus: selectedMonthFee?.status ?? "Pending",
      dueMonths: dueRows.map((fee) => fee.month_label),
      dueAmount,
      lastPayment,
      selectedMonthFee,
      dueRows,
      ledger,
    };
  });
}

// Keep reminder grouping isolated so a future Sheets sync can reuse the same UI logic.
export function groupPendingDuesByStudent(students, monthlyFees) {
  const aggregatedFees = aggregateMonthlyFees(monthlyFees);
  const maxMonthKey = getMaxKnownMonthKey(aggregatedFees);

  return students
    .map((student) => {
      const ledger = buildStudentLedger(student, aggregatedFees, maxMonthKey);
      const dueRows = ledger.filter(
        (fee) =>
          (fee.status === "Pending" || fee.status === "Partial") &&
          fee.balance_due > 0,
      );

      if (!dueRows.length) return null;

      return {
        ...student,
        dueRows,
        totalDue: dueRows.reduce((sum, fee) => sum + fee.balance_due, 0),
      };
    })
    .filter(Boolean);
}

export function generateDueBreakdown(dueRows, formatter) {
  return dueRows.map((fee) => `${fee.month_label} - ${formatter.format(fee.balance_due)}`);
}

export function generateReminderText({
  template,
  studentName,
  dueRows,
  totalDue,
  formatter,
}) {
  const dueBreakdown = generateDueBreakdown(dueRows, formatter).join(", ");

  return template
    .replace("{{student_name}}", studentName)
    .replace("{{due_breakdown}}", dueBreakdown)
    .replace("{{total_due}}", formatter.format(totalDue));
}

export function buildWhatsAppLink(phoneNumber, message) {
  return `https://wa.me/${phoneNumber}?text=${encodeURIComponent(message)}`;
}

export function getLocations(students) {
  return ["All", ...new Set(students.map((student) => student.location))];
}
