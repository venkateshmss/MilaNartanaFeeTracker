import { useEffect, useMemo, useRef, useState } from "react";
import {
  monthOptions,
  settings,
  students as initialStudents,
  monthlyFees as initialMonthlyFees,
} from "./data/mockData.js";
import {
  buildWhatsAppLink,
  generateDueBreakdown,
  generateReminderText,
  getCurrencyFormatter,
  getLocations,
  getStudentStatuses,
  groupPendingDuesByStudent,
} from "./utils/feeTracker.js";
import {
  addMonthlyFeeRow,
  addStudentRow,
  deleteMonthlyFeeRows,
  fetchAllSheetsData,
  getSheetsDebugStatus,
  hasSheetsEndpointConfigured,
  updateStudentRow,
  updateStudentStatus,
} from "./services/googleSheetsService.js";

const screenLabels = {
  dashboard: "Dashboard",
  students: "Students",
  payment: "Add Payment",
  reminders: "Reminders",
};
const PAYMENT_STATUS_OPTIONS = ["Paid", "Partial", "Pending"];
const PAYMENT_MODE_OPTIONS = ["Cash", "Online", "Mixed", "Pending", "None"];
const SHEETS_CACHE_KEY = "mnft.sheets_cache_v1";

function readSheetsCache() {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SHEETS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const students = Array.isArray(parsed.students) ? parsed.students : null;
    const monthlyFees = Array.isArray(parsed.monthlyFees) ? parsed.monthlyFees : null;
    const settings = parsed.settings && typeof parsed.settings === "object" ? parsed.settings : null;
    if (!students || !monthlyFees || !settings) return null;
    return { students, monthlyFees, settings };
  } catch {
    return null;
  }
}

function writeSheetsCache(snapshot) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      SHEETS_CACHE_KEY,
      JSON.stringify({
        students: snapshot.students || [],
        monthlyFees: snapshot.monthlyFees || [],
        settings: snapshot.settings || {},
        cachedAt: new Date().toISOString(),
      }),
    );
  } catch {
    // Ignore storage failures.
  }
}

function formatMonthLabel(monthKey) {
  const [year, month] = monthKey.split("-");
  if (!year || !month) return monthKey;
  const date = new Date(Number(year), Number(month) - 1, 1);
  return date.toLocaleString("en-US", { month: "short", year: "numeric" });
}

function isMonthInputSupported() {
  if (typeof document === "undefined") return false;
  const input = document.createElement("input");
  input.setAttribute("type", "month");
  return input.type === "month";
}

const MONTH_INPUT_SUPPORTED = isMonthInputSupported();

function normalizeMonthKey(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}$/.test(raw)) return raw;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function hasJoinedByMonth(joinMonthValue, targetMonthKey) {
  const target = normalizeMonthKey(targetMonthKey);
  if (!target) return true;
  const joinMonth = normalizeMonthKey(joinMonthValue);
  if (!joinMonth) return true;
  return joinMonth <= target;
}

function getCurrentMonthKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function addMonthsToKey(monthKey, offset) {
  const normalized = normalizeMonthKey(monthKey);
  if (!normalized) return "";
  const [yearStr, monthStr] = normalized.split("-");
  const base = new Date(Number(yearStr), Number(monthStr) - 1, 1);
  base.setMonth(base.getMonth() + offset);
  const year = base.getFullYear();
  const month = String(base.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function isDebugModeEnabled() {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  return params.get("debug") === "true";
}

function parseDateValue(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;

  const raw = String(value).trim();
  if (!raw) return null;

  if (/^\d{4}-\d{2}$/.test(raw)) {
    const [year, month] = raw.split("-");
    return new Date(Number(year), Number(month) - 1, 1);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [year, month, day] = raw.split("-");
    return new Date(Number(year), Number(month) - 1, Number(day));
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function formatReadableDate(value) {
  const parsed = parseDateValue(value);
  if (!parsed) return "-";
  const month = parsed.toLocaleString("en-US", { month: "short" });
  const day = String(parsed.getDate()).padStart(2, "0");
  const year = parsed.getFullYear();
  return `${month}-${day}-${year}`;
}

function formatReadableDateTime(value) {
  const parsed = parseDateValue(value);
  if (!parsed) return "-";
  const datePart = formatReadableDate(parsed);
  const timePart = parsed.toLocaleString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `${datePart} ${timePart}`;
}

function getReminderTriggerDate(monthKey, reminderDay) {
  const parsed = parseDateValue(monthKey);
  if (!parsed) return null;
  const year = parsed.getFullYear();
  const monthIndex = parsed.getMonth();
  const maxDay = new Date(year, monthIndex + 1, 0).getDate();
  const day = Math.min(Math.max(Number(reminderDay) || 1, 1), maxDay);
  return new Date(year, monthIndex, day);
}

function isReminderDueForMonth(monthKey, reminderDay, now = new Date()) {
  const triggerDate = getReminderTriggerDate(monthKey, reminderDay);
  if (!triggerDate) return true;
  return now >= triggerDate;
}

function StatusBadge({ status }) {
  const badgeClass = {
    Paid: "badge badge-paid",
    Pending: "badge badge-pending",
    Partial: "badge badge-partial",
  }[status];

  return <span className={badgeClass}>{status}</span>;
}

function getDueAmountClass(status, dueAmount) {
  if (Number(dueAmount || 0) <= 0) return "due-clear";
  if (status === "Pending") return "due-pending";
  if (status === "Partial") return "due-partial";
  return "due-clear";
}

function sortTransactionHistory(rows) {
  return [...rows]
    .filter((row) => {
      const status = String(row.status || "").trim().toLowerCase();
      const amountPaid = Number(row.amount_paid || 0);
      const hasPaymentDate = Boolean(parseDateValue(row.payment_date));
      // Fee history should show only real payment events.
      return amountPaid > 0 && hasPaymentDate && status !== "pending";
    })
    .sort((a, b) =>
      String(b.payment_date || "").localeCompare(String(a.payment_date || "")),
    );
}

function DebugPanel({ debugStatus, loadError }) {
  const last = debugStatus.lastRequest || {};
  const tokenState =
    debugStatus.writeTokenConfigured === null
      ? "Server-managed"
      : debugStatus.writeTokenConfigured
        ? "Yes"
        : "No";
  return (
    <section className="info-card debug-panel">
      <p className="eyebrow">Debug</p>
      <dl className="settings-grid">
        <div>
          <dt>Endpoint configured</dt>
          <dd>{debugStatus.endpointConfigured ? "Yes" : "No"}</dd>
        </div>
        <div>
          <dt>Write token configured</dt>
          <dd>{tokenState}</dd>
        </div>
        <div>
          <dt>Endpoint mode</dt>
          <dd>{debugStatus.endpointMode || "-"}</dd>
        </div>
        <div>
          <dt>Last request</dt>
          <dd>{last.action ? `${last.action} (${last.status || "-"})` : "None"}</dd>
        </div>
      </dl>
      {last.error ? <p className="tiny-copy">Last error: {last.error}</p> : null}
      {loadError ? <p className="tiny-copy">UI error: {loadError}</p> : null}
    </section>
  );
}

function openMonthPicker(input) {
  if (!input) return;
  if (typeof input.showPicker === "function") {
    input.showPicker();
    return;
  }
  input.focus();
}

function ScreenNav({ activeScreen, onChange }) {
  return (
    <nav className="screen-nav" aria-label="Sections">
      {Object.entries(screenLabels).map(([key, label]) => (
        <button
          key={key}
          type="button"
          className={`nav-chip ${activeScreen === key ? "nav-chip-active" : ""}`}
          onClick={() => onChange(key)}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}

function LoginScreen({ isSubmitting, error, lockoutUntil, onLogin }) {
  const [passcode, setPasscode] = useState("");

  async function submit(event) {
    event.preventDefault();
    await onLogin(passcode);
  }

  return (
    <div className="app-shell">
      <main className="app-frame">
        <header className="topbar">
          <div className="brand-wrap">
            <h1 className="brand-title">Mila Nartana Fee Tracker</h1>
            <p className="topbar-copy">Enter passcode to continue</p>
          </div>
        </header>

        <section className="panel auth-panel">
          <form className="payment-form auth-form" onSubmit={submit}>
            <label className="field">
              <span>Passcode</span>
              <input
                type="password"
                autoFocus
                required
                value={passcode}
                onChange={(event) => setPasscode(event.target.value)}
                placeholder="Enter passcode"
              />
            </label>
            <button type="submit" className="primary-button" disabled={isSubmitting}>
              {isSubmitting ? "Checking..." : "Unlock"}
            </button>
          </form>
          {error ? <div className="info-card muted">{error}</div> : null}
          {lockoutUntil ? (
            <p className="tiny-copy">Locked until: {formatReadableDateTime(lockoutUntil)}</p>
          ) : null}
        </section>
      </main>
    </div>
  );
}

function Dashboard({
  monthKey,
  monthChoices,
  monthlyFees,
  onMonthChange,
  totalStudents,
  totalAmount,
  expectedAmount,
  pendingGapAmount,
  formatter,
  onOpenStudentsFiltered,
}) {
  const monthInputRef = useRef(null);
  const [rangeFrom, setRangeFrom] = useState("");
  const [rangeTo, setRangeTo] = useState("");
  const monthLabel = monthChoices.find((option) => option.key === monthKey)?.label ?? monthKey;
  const minMonth = monthChoices[0]?.key || "";
  const maxMonth = monthChoices[monthChoices.length - 1]?.key || "";
  const expectedSafe = Math.max(Number(expectedAmount || 0), 0);
  const collectedSafe = Math.max(Number(totalAmount || 0), 0);
  const pendingSafe = Math.max(Number(pendingGapAmount || 0), 0);
  const cashSafe = 0;
  const onlineSafe = 0;
  const cashPercent = 0;
  const onlinePercent = 0;
  const collectedPercent = expectedSafe > 0 ? Math.round((collectedSafe / expectedSafe) * 100) : 100;
  const pendingPercent = expectedSafe > 0 ? Math.round((pendingSafe / expectedSafe) * 100) : 0;
  const progressPercent = (value) =>
    expectedSafe > 0 ? Math.max(0, Math.min(100, (Number(value || 0) / expectedSafe) * 100)) : 0;

  useEffect(() => {
    if (!monthChoices.length) return;
    const fallbackTo = monthChoices.some((m) => m.key === monthKey)
      ? monthKey
      : monthChoices[monthChoices.length - 1].key;
    const fallbackFrom = addMonthsToKey(fallbackTo, -2);
    const hasFallbackFrom = monthChoices.some((m) => m.key === fallbackFrom);
    setRangeTo((current) => current || fallbackTo);
    setRangeFrom((current) => current || (hasFallbackFrom ? fallbackFrom : fallbackTo));
  }, [monthChoices, monthKey]);

  const effectiveRangeFrom = rangeFrom || monthKey;
  const effectiveRangeTo = rangeTo || monthKey;
  const normalizedFrom = effectiveRangeFrom <= effectiveRangeTo ? effectiveRangeFrom : effectiveRangeTo;
  const normalizedTo = effectiveRangeFrom <= effectiveRangeTo ? effectiveRangeTo : effectiveRangeFrom;

  const rangeTotals = useMemo(() => {
    return monthlyFees.reduce(
      (acc, row) => {
        const key = normalizeMonthKey(row.month_key);
        if (!key || key < normalizedFrom || key > normalizedTo) return acc;
        const amount = Number(row.amount_paid || 0);
        if (!Number.isFinite(amount) || amount <= 0) return acc;
        const mode = String(row.payment_mode || "").trim().toLowerCase();
        if (mode === "cash") acc.cash += amount;
        else if (mode === "online") acc.online += amount;
        return acc;
      },
      { cash: 0, online: 0 },
    );
  }, [monthlyFees, normalizedFrom, normalizedTo]);
  const monthModeTotals = useMemo(() => {
    return monthlyFees.reduce(
      (acc, row) => {
        const key = normalizeMonthKey(row.month_key);
        if (key !== monthKey) return acc;
        const amount = Number(row.amount_paid || 0);
        if (!Number.isFinite(amount) || amount <= 0) return acc;
        const mode = String(row.payment_mode || "").trim().toLowerCase();
        if (mode === "cash") acc.cash += amount;
        else if (mode === "online") acc.online += amount;
        return acc;
      },
      { cash: 0, online: 0 },
    );
  }, [monthlyFees, monthKey]);
  const monthCashPercent = collectedSafe > 0 ? Math.round((monthModeTotals.cash / collectedSafe) * 100) : 0;
  const monthOnlinePercent =
    collectedSafe > 0 ? Math.round((monthModeTotals.online / collectedSafe) * 100) : 0;

  const rangeTotal = rangeTotals.cash + rangeTotals.online;
  const rangeCashPercent = rangeTotal > 0 ? Math.round((rangeTotals.cash / rangeTotal) * 100) : 0;
  const rangeOnlinePercent = rangeTotal > 0 ? Math.round((rangeTotals.online / rangeTotal) * 100) : 0;
  const donutBg =
    rangeTotal > 0
      ? `conic-gradient(#13c48d 0% ${rangeCashPercent}%, #6f7cff ${rangeCashPercent}% 100%)`
      : "conic-gradient(rgba(126,149,204,0.24) 0% 100%)";

  function formatMonthKeyShort(key) {
    const [y, m] = String(key || "").split("-");
    if (!y || !m) return key;
    const d = new Date(Number(y), Number(m) - 1, 1);
    const month = d.toLocaleString("en-US", { month: "short" });
    const year = String(d.getFullYear()).slice(-2);
    return `${month}-${year}`;
  }

  function openStudentsWithFilters({
    paymentStatuses = [],
    paymentModes = [],
    monthKeyOverride = monthKey,
    monthRangeFrom = "",
    monthRangeTo = "",
  }) {
    onOpenStudentsFiltered({
      monthKey: monthKeyOverride,
      paymentStatuses,
      paymentModes,
      monthRangeFrom,
      monthRangeTo,
    });
  }

  function openStudentsForDonutModes(paymentModes) {
    openStudentsWithFilters({
      monthKeyOverride: "",
      paymentStatuses: ["Paid", "Partial"],
      paymentModes,
      monthRangeFrom: normalizedFrom,
      monthRangeTo: normalizedTo,
    });
  }

  function handleDonutRingClick(event) {
    if (rangeTotal <= 0) return;

    // Keyboard activation should open total collected view.
    if (!event || event.detail === 0 || typeof event.clientX !== "number") {
      openStudentsForDonutModes(["Cash", "Online"]);
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = event.clientX - cx;
    const dy = event.clientY - cy;
    const distance = Math.hypot(dx, dy);
    const outerRadius = rect.width / 2;
    const innerRadius = outerRadius * 0.62; // Must match .donut-hole size.

    if (distance > outerRadius) return;
    if (distance <= innerRadius) {
      openStudentsForDonutModes(["Cash", "Online"]);
      return;
    }

    // Convert click to clockwise angle where 0deg starts at top.
    const angleDeg = ((Math.atan2(dy, dx) * 180) / Math.PI + 450) % 360;
    const cashSweepDeg = (rangeCashPercent / 100) * 360;

    if (cashSweepDeg <= 0) {
      openStudentsForDonutModes(["Online"]);
      return;
    }
    if (cashSweepDeg >= 360) {
      openStudentsForDonutModes(["Cash"]);
      return;
    }

    if (angleDeg < cashSweepDeg) openStudentsForDonutModes(["Cash"]);
    else openStudentsForDonutModes(["Online"]);
  }

  return (
    <section className="panel stack-lg">
      <div className="hero-card">
        <div>
          <p className="eyebrow">Dashboard</p>
          <h1>Month-wise fee overview</h1>
          <p className="hero-copy">Track paid, pending, and partial dues quickly.</p>
        </div>

        <label className="field">
          <span>Selected month</span>
          {MONTH_INPUT_SUPPORTED ? (
            <div
              className="month-input-shell"
              onClick={() => openMonthPicker(monthInputRef.current)}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  openMonthPicker(monthInputRef.current);
                }
              }}
              aria-label="Pick month"
            >
              <input
                ref={monthInputRef}
                type="month"
                value={monthKey}
                min={minMonth}
                max={maxMonth}
                onChange={(event) => onMonthChange(event.target.value)}
              />
              <button
                type="button"
                className="month-icon-button"
                onClick={() => openMonthPicker(monthInputRef.current)}
                tabIndex={-1}
                aria-hidden="true"
              >
                📅
              </button>
            </div>
          ) : (
            <select value={monthKey} onChange={(event) => onMonthChange(event.target.value)}>
              {monthChoices.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
          <p className="tiny-copy">Selected: {monthLabel}</p>
        </label>
      </div>

      <div className="dashboard-metrics-grid">
        <article className="fee-summary-card">
          <header className="fee-summary-head">
            <p className="fee-summary-title">Fee Summary · {monthLabel.toUpperCase()}</p>
            <p className="fee-summary-students">{totalStudents} students</p>
          </header>

          <div className="fee-summary-grid">
            <button
              type="button"
              className="fee-summary-block fee-summary-expected"
              onClick={() =>
                openStudentsWithFilters({
                  monthKeyOverride: monthKey,
                  paymentStatuses: [],
                  paymentModes: [],
                })
              }
            >
              <p className="fee-summary-label">Total expected</p>
              <div className="fee-summary-expected-row">
                <strong className="fee-summary-amount">{formatter.format(expectedSafe)}</strong>
                <span className="expected-student-pill">{totalStudents} students</span>
              </div>
            </button>

            <button
              type="button"
              className="fee-summary-block fee-summary-collected"
              onClick={() =>
                openStudentsWithFilters({
                  monthKeyOverride: monthKey,
                  paymentStatuses: ["Paid", "Partial"],
                })
              }
            >
              <p className="fee-summary-label">Collected</p>
              <strong className="fee-summary-amount text-success">{formatter.format(collectedSafe)}</strong>
              <p className="fee-summary-sub">of {formatter.format(expectedSafe)}</p>
              <div className="summary-progress-row">
                <div className="progress-track">
                  <div
                    className="progress-fill progress-fill-total"
                    style={{ width: `${progressPercent(collectedSafe)}%` }}
                  />
                </div>
                <span className="summary-percent-badge">{collectedPercent}%</span>
              </div>
            </button>
          </div>

          <button
            type="button"
            className="fee-summary-pending"
            onClick={() =>
              openStudentsWithFilters({
                monthKeyOverride: monthKey,
                paymentStatuses: ["Pending", "Partial"],
              })
            }
          >
            <div>
              <p className="fee-summary-label">Pending</p>
              <strong className="fee-summary-amount text-danger">{formatter.format(pendingSafe)}</strong>
            </div>
            <div className="fee-summary-pending-meta">
              <span className="pending-pill">{pendingPercent}% outstanding</span>
              <p>{formatter.format(pendingSafe)} yet to collect</p>
            </div>
          </button>

          <div className="fee-summary-grid">
            <button
              type="button"
              className="fee-summary-block fee-summary-cash"
              onClick={() =>
                openStudentsWithFilters({
                  monthKeyOverride: monthKey,
                  paymentModes: ["Cash"],
                })
              }
            >
              <p className="fee-summary-label">
                <span className="dot dot-cash" /> Cash
              </p>
              <strong className="fee-summary-amount">{formatter.format(monthModeTotals.cash)}</strong>
              <p className="fee-summary-sub">{monthCashPercent}% of collected</p>
              <div className="summary-progress-row">
                <div className="progress-track">
                  <div
                    className="progress-fill progress-fill-paid"
                    style={{ width: `${Math.max(0, Math.min(100, monthCashPercent))}%` }}
                  />
                </div>
                <span className="summary-percent-badge">{monthCashPercent}%</span>
              </div>
            </button>

            <button
              type="button"
              className="fee-summary-block fee-summary-online"
              onClick={() =>
                openStudentsWithFilters({
                  monthKeyOverride: monthKey,
                  paymentModes: ["Online"],
                })
              }
            >
              <p className="fee-summary-label">
                <span className="dot dot-online" /> Online
              </p>
              <strong className="fee-summary-amount">{formatter.format(monthModeTotals.online)}</strong>
              <p className="fee-summary-sub">{monthOnlinePercent}% of collected</p>
              <div className="summary-progress-row">
                <div className="progress-track">
                  <div
                    className="progress-fill progress-fill-online"
                    style={{ width: `${Math.max(0, Math.min(100, monthOnlinePercent))}%` }}
                  />
                </div>
                <span className="summary-percent-badge">{monthOnlinePercent}%</span>
              </div>
            </button>
          </div>
        </article>
      </div>

      {false && <div className="dashboard-channel-grid">
        <article className="dashboard-channel-card">
          <div className="dashboard-channel-icon cash" aria-hidden="true">
            💵
          </div>
          <div className="dashboard-channel-body">
            <p className="dashboard-channel-title">Cash collected</p>
            <strong className="dashboard-channel-value">{formatter.format(cashSafe)}</strong>
            <p className="dashboard-channel-sub">
              {cashPercent}% of {formatter.format(collectedSafe)} collected
            </p>
          </div>
        </article>

        <article className="dashboard-channel-card">
          <div className="dashboard-channel-icon online" aria-hidden="true">
            📱
          </div>
          <div className="dashboard-channel-body">
            <p className="dashboard-channel-title">Online collected</p>
            <strong className="dashboard-channel-value">{formatter.format(onlineSafe)}</strong>
            <p className="dashboard-channel-sub">
              {onlinePercent}% of {formatter.format(collectedSafe)} collected
            </p>
          </div>
        </article>
      </div>}

      <div className="dashboard-analytics-grid single-analytics">
        <div className="info-card dashboard-donut-card">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Payment mode share</p>
              <h2>Cash vs Online in range</h2>
            </div>
            <p className="section-copy">
              Range total: {formatter.format(rangeTotal)} from {formatMonthKeyShort(normalizedFrom)} to{" "}
              {formatMonthKeyShort(normalizedTo)}
            </p>
          </div>

          <div className="donut-filter-row">
            <label className="field">
              <span>From</span>
              <select value={rangeFrom} onChange={(event) => setRangeFrom(event.target.value)}>
                {monthChoices.map((option) => (
                  <option key={`from-${option.key}`} value={option.key}>
                    {formatMonthKeyShort(option.key)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>To</span>
              <select value={rangeTo} onChange={(event) => setRangeTo(event.target.value)}>
                {monthChoices.map((option) => (
                  <option key={`to-${option.key}`} value={option.key}>
                    {formatMonthKeyShort(option.key)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="donut-legend">
            <button
              type="button"
              className="donut-legend-item donut-legend-button"
              onClick={() => openStudentsForDonutModes(["Cash"])}
            >
              <span className="dot dot-cash" />
              <span>
                Cash {formatter.format(rangeTotals.cash)} ({rangeCashPercent}%)
              </span>
            </button>
            <button
              type="button"
              className="donut-legend-item donut-legend-button"
              onClick={() => openStudentsForDonutModes(["Online"])}
            >
              <span className="dot dot-online" />
              <span>
                Online {formatter.format(rangeTotals.online)} ({rangeOnlinePercent}%)
              </span>
            </button>
          </div>

          <div className="donut-wrap">
            <button
              type="button"
              className="donut-ring donut-ring-button"
              style={{ background: donutBg }}
              onClick={handleDonutRingClick}
              aria-label="Open students filtered by selected range and payment mode"
            >
              <div className="donut-hole">
                <strong>{formatter.format(rangeTotal)}</strong>
                <span>Total</span>
              </div>
            </button>
          </div>
        </div>

      </div>
    </section>
  );
}

function StudentsScreen({
  studentsWithStatus,
  formatter,
  onToggleStudentStatus,
  statusSyncingId,
  onAddStudent,
  isAddingStudent,
  onOpenStudentDetails,
  onQuickAddPayment,
  reminderMetaByStudentId,
  monthChoices,
  monthFilter,
  onMonthFilterChange,
  rangeFilter,
  paymentStatusFilter,
  onPaymentStatusFilterChange,
  paymentModeFilter,
  onPaymentModeFilterChange,
}) {
  const monthFilterInputRef = useRef(null);
  const [query, setQuery] = useState("");
  const [location, setLocation] = useState("All");
  const [toggleDraft, setToggleDraft] = useState(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newStudent, setNewStudent] = useState({
    student_name: "",
    parent_name: "",
    email: "",
    whatsapp_number: "",
    alternate_phone: "",
    address: "",
    location: "",
    join_month: "",
    monthly_fee: "80",
    status: "Active",
    notes: "",
  });
  const locations = getLocations(studentsWithStatus);

  function getPaymentModeLabel(feeLike) {
    const mode = String(feeLike?.payment_mode || "").trim();
    if (mode) return mode;
    const amountPaid = Number(feeLike?.amount_paid || 0);
    const feeAmount = Number(feeLike?.fee_amount || 0);
    if (feeAmount <= 0 && String(feeLike?.status || "").trim() === "Paid") return "None";
    if (amountPaid <= 0) return "Pending";
    return "Pending";
  }

  const visibleStudents = studentsWithStatus.filter((student) => {
    const matchesQuery = student.student_name.toLowerCase().includes(query.toLowerCase());
    const matchesLocation = location === "All" || student.location === location;
    const matchesJoinMonth = monthFilter
      ? hasJoinedByMonth(student.join_month, monthFilter)
      : true;
    return matchesQuery && matchesLocation && matchesJoinMonth;
  });
  const studentRows = useMemo(() => {
    const hasNameSearch = query.trim().length > 0;
    const hasRangeFilter = Boolean(rangeFilter?.from && rangeFilter?.to);
    return visibleStudents.flatMap((student) => {
      const pendingHistory = [...(student.dueRows || [])].sort((a, b) =>
        String(b.month_key || "").localeCompare(String(a.month_key || "")),
      );
      const fullHistory = [...(student.ledger || [])].sort((a, b) =>
        String(b.month_key || "").localeCompare(String(a.month_key || "")),
      );
      const totalPendingDue = Number(student.dueAmount || 0);
      const lastPayment = student.lastPayment;

      if (monthFilter) {
        const matchedMonth =
          student.ledger?.find((fee) => fee.month_key === monthFilter) ||
          pendingHistory.find((fee) => fee.month_key === monthFilter);
        const monthLabel =
          monthChoices.find((m) => m.key === monthFilter)?.label || formatMonthLabel(monthFilter);
        const status = matchedMonth?.status || "Pending";
        const dueAmount = Number(matchedMonth?.balance_due ?? student.monthly_fee ?? 0);

        return [
          {
            key: `${student.student_id}-${monthFilter}`,
            student,
            monthKey: monthFilter,
            monthLabel,
            monthStatus: status,
            dueAmount,
            monthDueAmount: dueAmount,
            paymentMode: getPaymentModeLabel(matchedMonth),
            totalPendingDue,
            lastPayment,
          },
        ];
      }

      if (
        (hasNameSearch || paymentStatusFilter.length > 0 || paymentModeFilter.length > 0 || hasRangeFilter) &&
        fullHistory.length
      ) {
        return fullHistory.map((fee) => ({
          key: `${student.student_id}-${fee.month_key}-history`,
          student,
          monthKey: normalizeMonthKey(fee.month_key),
          monthLabel: fee.month_label || formatMonthLabel(fee.month_key),
          monthStatus: fee.status || "Pending",
          dueAmount: Number(fee.balance_due || 0),
          monthDueAmount: Number(fee.balance_due || 0),
          paymentMode: getPaymentModeLabel(fee),
          totalPendingDue,
          lastPayment,
        }));
      }

      if (pendingHistory.length) {
        return pendingHistory.map((fee) => ({
          key: `${student.student_id}-${fee.month_key}`,
          student,
          monthKey: normalizeMonthKey(fee.month_key),
          monthLabel: fee.month_label || formatMonthLabel(fee.month_key),
          monthStatus: fee.status,
          dueAmount: Number(fee.balance_due || 0),
          monthDueAmount: Number(fee.balance_due || 0),
          paymentMode: getPaymentModeLabel(fee),
          totalPendingDue,
          lastPayment,
        }));
      }

      return [
        {
          key: `${student.student_id}-latest`,
          student,
          monthKey: normalizeMonthKey(student.selectedMonthFee?.month_key || ""),
          monthLabel: student.selectedMonth || "-",
          monthStatus: student.selectedMonthStatus || "Paid",
          dueAmount: Number(student.selectedMonthFee?.balance_due || 0),
          monthDueAmount: Number(student.selectedMonthFee?.balance_due || 0),
          paymentMode: getPaymentModeLabel(student.selectedMonthFee),
          totalPendingDue,
          lastPayment,
        },
      ];
    });
  }, [
    monthChoices,
    monthFilter,
    paymentModeFilter.length,
    paymentStatusFilter.length,
    query,
    rangeFilter?.from,
    rangeFilter?.to,
    visibleStudents,
  ]);
  const filteredStudentRows = useMemo(() => {
    let rows = studentRows;

    if (paymentStatusFilter.length) {
      rows = rows.filter((row) => paymentStatusFilter.includes(row.monthStatus));
    }

    if (paymentModeFilter.length) {
      rows = rows.filter((row) => paymentModeFilter.includes(row.paymentMode || "Pending"));
    }

    const rangeFrom = normalizeMonthKey(rangeFilter?.from || "");
    const rangeTo = normalizeMonthKey(rangeFilter?.to || "");
    if (rangeFrom && rangeTo) {
      const from = rangeFrom <= rangeTo ? rangeFrom : rangeTo;
      const to = rangeFrom <= rangeTo ? rangeTo : rangeFrom;
      rows = rows.filter((row) => {
        const rowMonthKey = normalizeMonthKey(row.monthKey || "");
        return rowMonthKey && rowMonthKey >= from && rowMonthKey <= to;
      });
    }

    return rows;
  }, [paymentModeFilter, paymentStatusFilter, rangeFilter?.from, rangeFilter?.to, studentRows]);

  function togglePaymentStatus(status) {
    const exists = paymentStatusFilter.includes(status);
    onPaymentStatusFilterChange(
      exists
        ? paymentStatusFilter.filter((s) => s !== status)
        : [...paymentStatusFilter, status],
    );
  }

  function togglePaymentMode(mode) {
    const exists = paymentModeFilter.includes(mode);
    onPaymentModeFilterChange(
      exists ? paymentModeFilter.filter((current) => current !== mode) : [...paymentModeFilter, mode],
    );
  }

  function requestToggle(student) {
    const nextStatus = student.status === "Active" ? "Inactive" : "Active";
    setToggleDraft({
      studentId: student.student_id,
      studentName: student.student_name,
      currentStatus: student.status,
      nextStatus,
    });
  }

  function closeToggleModal() {
    setToggleDraft(null);
  }

  function updateNewStudentField(field, value) {
    setNewStudent((current) => ({ ...current, [field]: value }));
  }

  async function submitNewStudent(event) {
    event.preventDefault();
    const added = await onAddStudent(newStudent);
    if (!added) return;
    setShowAddForm(false);
    setNewStudent({
      student_name: "",
      parent_name: "",
      email: "",
      whatsapp_number: "",
      alternate_phone: "",
      address: "",
      location: "",
      join_month: "",
      monthly_fee: "80",
      status: "Active",
      notes: "",
    });
  }

  async function confirmToggle() {
    if (!toggleDraft) return;
    await onToggleStudentStatus(toggleDraft.studentId, toggleDraft.nextStatus);
    setToggleDraft(null);
  }

  return (
    <section className="panel stack-lg">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Student status</p>
          <h2>Month-wise payment status</h2>
        </div>
        <p className="section-copy">Filter by month, location, and payment status.</p>
      </div>

      <div className="filters-row">
        <label className="field">
          <span>Month</span>
          {MONTH_INPUT_SUPPORTED ? (
            <div className="month-filter-inline">
              <div
                className="month-input-shell"
                onClick={() => openMonthPicker(monthFilterInputRef.current)}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    openMonthPicker(monthFilterInputRef.current);
                  }
                }}
                aria-label="Filter by month"
              >
                <input
                  ref={monthFilterInputRef}
                  type="month"
                  value={monthFilter}
                  min={monthChoices[0]?.key || ""}
                  max={monthChoices[monthChoices.length - 1]?.key || ""}
                  onChange={(event) => onMonthFilterChange(event.target.value)}
                />
                <button
                  type="button"
                  className="month-icon-button"
                  onClick={() => openMonthPicker(monthFilterInputRef.current)}
                  tabIndex={-1}
                  aria-hidden="true"
                >
                  📅
                </button>
              </div>
              <button
                type="button"
                className="ghost-button"
                onClick={() => onMonthFilterChange("")}
                disabled={!monthFilter}
              >
                All
              </button>
            </div>
          ) : (
            <select value={monthFilter} onChange={(event) => onMonthFilterChange(event.target.value)}>
              <option value="">All months</option>
              {monthChoices.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
          )}
          <p className="tiny-copy">{monthFilter ? formatMonthLabel(monthFilter) : "All months"}</p>
          {rangeFilter?.from && rangeFilter?.to ? (
            <p className="tiny-copy">
              Range: {formatMonthLabel(rangeFilter.from)} to {formatMonthLabel(rangeFilter.to)}
            </p>
          ) : null}
        </label>

        <label className="field">
          <span>Search</span>
          <input
            type="search"
            placeholder="Search by student name"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>

        <label className="field">
          <span>Location</span>
          <select value={location} onChange={(event) => setLocation(event.target.value)}>
            {locations.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>

        <div className="field">
          <span>Payment status</span>
          <div className="status-chip-group">
            {PAYMENT_STATUS_OPTIONS.map((status) => {
              const active = paymentStatusFilter.includes(status);
              return (
                <button
                  key={status}
                  type="button"
                  className={`status-chip ${active ? "status-chip-active" : ""}`}
                  onClick={() => togglePaymentStatus(status)}
                >
                  {status}
                </button>
              );
            })}
            {paymentStatusFilter.length > 0 ? (
              <button
                type="button"
                className="ghost-button status-clear"
                onClick={() => onPaymentStatusFilterChange([])}
              >
                Clear
              </button>
            ) : null}
          </div>
        </div>

        <div className="field">
          <span>Payment mode</span>
          <div className="status-chip-group">
            {PAYMENT_MODE_OPTIONS.map((mode) => {
              const active = paymentModeFilter.includes(mode);
              return (
                <button
                  key={mode}
                  type="button"
                  className={`status-chip ${active ? "status-chip-active" : ""}`}
                  onClick={() => togglePaymentMode(mode)}
                >
                  {mode}
                </button>
              );
            })}
            {paymentModeFilter.length > 0 ? (
              <button
                type="button"
                className="ghost-button status-clear"
                onClick={() => onPaymentModeFilterChange([])}
              >
                Clear
              </button>
            ) : null}
          </div>
        </div>

      </div>

      <div>
        <button
          type="button"
          className="primary-button"
          onClick={() => setShowAddForm((current) => !current)}
        >
          {showAddForm ? "Close form" : "Add student"}
        </button>
      </div>

      {showAddForm && (
        <form className="payment-form" onSubmit={submitNewStudent}>
          <label className="field">
            <span>Student name</span>
            <input
              required
              value={newStudent.student_name}
              onChange={(event) => updateNewStudentField("student_name", event.target.value)}
            />
          </label>
          <label className="field">
            <span>Parent name</span>
            <input
              required
              value={newStudent.parent_name}
              onChange={(event) => updateNewStudentField("parent_name", event.target.value)}
            />
          </label>
          <label className="field">
            <span>WhatsApp number</span>
            <input
              required
              value={newStudent.whatsapp_number}
              onChange={(event) => updateNewStudentField("whatsapp_number", event.target.value)}
            />
          </label>
          <label className="field">
            <span>Email</span>
            <input
              value={newStudent.email}
              onChange={(event) => updateNewStudentField("email", event.target.value)}
            />
          </label>
          <label className="field">
            <span>Alternate phone</span>
            <input
              value={newStudent.alternate_phone}
              onChange={(event) => updateNewStudentField("alternate_phone", event.target.value)}
            />
          </label>
          <label className="field">
            <span>Address</span>
            <input
              value={newStudent.address}
              onChange={(event) => updateNewStudentField("address", event.target.value)}
            />
          </label>
          <label className="field">
            <span>Location</span>
            <input
              required
              value={newStudent.location}
              onChange={(event) => updateNewStudentField("location", event.target.value)}
            />
          </label>
          <label className="field">
            <span>Join month (optional)</span>
            <input
              type="month"
              value={newStudent.join_month}
              onChange={(event) => updateNewStudentField("join_month", event.target.value)}
            />
          </label>
          <label className="field">
            <span>Monthly fee</span>
            <input
              type="number"
              min="0"
              required
              value={newStudent.monthly_fee}
              onChange={(event) => updateNewStudentField("monthly_fee", event.target.value)}
            />
          </label>
          <label className="field">
            <span>Status</span>
            <select
              value={newStudent.status}
              onChange={(event) => updateNewStudentField("status", event.target.value)}
            >
              <option value="Active">Active</option>
              <option value="Inactive">Inactive</option>
            </select>
          </label>
          <label className="field">
            <span>Notes</span>
            <input
              value={newStudent.notes}
              onChange={(event) => updateNewStudentField("notes", event.target.value)}
            />
          </label>
          <button type="submit" className="primary-button" disabled={isAddingStudent}>
            {isAddingStudent ? "Saving..." : "Save student"}
          </button>
        </form>
      )}

      <div className="student-list-table compact-student-table" role="table" aria-label="Student monthly statuses">
        <div className="student-list-head" role="row">
          <span>Name</span>
          <span>Due amount</span>
          <span>Payment mode</span>
          <span>Actions</span>
        </div>

        {filteredStudentRows.map((row) => (
          <div key={row.key} className="student-list-row" role="row">
            <div data-label="Name" className="cell-name">
              <button
                type="button"
                className="link-button"
                onClick={() => onOpenStudentDetails(row.student.student_id)}
              >
                {row.student.student_name}
              </button>
              <p className="tiny-copy">
                {row.monthLabel} • {row.monthStatus}
              </p>
            </div>
            <div data-label="Due amount" className="cell-due">
              <span
                className={`due-amount-chip ${getDueAmountClass(row.monthStatus, row.dueAmount)}`}
              >
                {formatter.format(row.dueAmount)}
              </span>
              {row.dueAmount > 0 ? (
                <p className="tiny-copy due-breakdown-line">
                  {row.monthLabel} - {formatter.format(row.monthDueAmount)}
                </p>
              ) : null}
            </div>
            <div data-label="Payment mode" className="cell-mode">
              <span className="tiny-copy">{row.paymentMode || "Pending"}</span>
            </div>
            <div data-label="Actions" className="cell-actions dashboard-actions">
              <button
                type="button"
                className="ghost-button icon-action"
                onClick={() =>
                  onQuickAddPayment(row.student.student_id, monthFilter || row.monthKey)
                }
              >
                +Pay
              </button>
              {row.monthStatus !== "Paid" && reminderMetaByStudentId[row.student.student_id] ? (
                <a
                  className="whatsapp-button icon-action"
                  href={reminderMetaByStudentId[row.student.student_id].whatsappLink}
                  target="_blank"
                  rel="noreferrer"
                >
                  WA
                </a>
              ) : (
                <span className="no-due-label">No due</span>
              )}
            </div>
          </div>
        ))}
        {!filteredStudentRows.length ? (
          <div className="student-list-row" role="row">
            <div className="cell-name">
              <p className="tiny-copy">No students found for selected filters.</p>
            </div>
          </div>
        ) : null}
      </div>

      {toggleDraft && (
        <div className="confirm-overlay" role="dialog" aria-modal="true" aria-label="Confirm status change">
          <div className="confirm-modal">
            <h3>Confirm status change</h3>
            <p>
              Change {toggleDraft.studentName} from {toggleDraft.currentStatus} to{" "}
              {toggleDraft.nextStatus}?
            </p>
            <div className="confirm-actions">
              <button type="button" className="ghost-button" onClick={closeToggleModal}>
                Cancel
              </button>
              <button type="button" className="primary-button" onClick={confirmToggle}>
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function StudentDetailsModal({
  student,
  transactionHistory,
  cleanupCandidatesCount,
  formatter,
  onClose,
  onSave,
  onCleanupHistory,
  isCleaningHistory,
  isSaving,
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(student || {});

  useEffect(() => {
    setDraft(student || {});
    setIsEditing(false);
  }, [student]);

  if (!student) return null;

  function updateDraft(field, value) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  async function saveChanges() {
    const ok = await onSave(draft);
    if (ok) setIsEditing(false);
  }

  async function cleanupHistory() {
    if (!onCleanupHistory || !cleanupCandidatesCount) return;
    const confirmed = window.confirm(
      `Remove ${cleanupCandidatesCount} pending placeholder row(s) from this student's fee history?`,
    );
    if (!confirmed) return;
    await onCleanupHistory(student.student_id);
  }

  return (
    <div className="confirm-overlay" role="dialog" aria-modal="true" aria-label="Student details">
      <div className="confirm-modal student-modal">
        <div className="student-modal-head">
          <div>
            <p className="eyebrow">Student profile</p>
            <h3>{isEditing ? draft.student_name : student.student_name}</h3>
          </div>
          <div className="dashboard-actions">
            {isEditing ? (
              <>
                <button type="button" className="ghost-button" onClick={() => setIsEditing(false)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="primary-button"
                  onClick={saveChanges}
                  disabled={isSaving}
                >
                  {isSaving ? "Saving..." : "Save"}
                </button>
              </>
            ) : (
              <button type="button" className="ghost-button" onClick={() => setIsEditing(true)}>
                Edit
              </button>
            )}
            <button type="button" className="ghost-button" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        {isEditing ? (
          <div className="payment-form">
            <label className="field">
              <span>Student name</span>
              <input
                value={draft.student_name || ""}
                onChange={(event) => updateDraft("student_name", event.target.value)}
              />
            </label>
            <label className="field">
              <span>Parent</span>
              <input
                value={draft.parent_name || ""}
                onChange={(event) => updateDraft("parent_name", event.target.value)}
              />
            </label>
            <label className="field">
              <span>WhatsApp</span>
              <input
                value={draft.whatsapp_number || ""}
                onChange={(event) => updateDraft("whatsapp_number", event.target.value)}
              />
            </label>
            <label className="field">
              <span>Email</span>
              <input
                value={draft.email || ""}
                onChange={(event) => updateDraft("email", event.target.value)}
              />
            </label>
            <label className="field">
              <span>Alternate phone</span>
              <input
                value={draft.alternate_phone || ""}
                onChange={(event) => updateDraft("alternate_phone", event.target.value)}
              />
            </label>
            <label className="field">
              <span>Location</span>
              <input
                value={draft.location || ""}
                onChange={(event) => updateDraft("location", event.target.value)}
              />
            </label>
            <label className="field">
              <span>Address</span>
              <input
                value={draft.address || ""}
                onChange={(event) => updateDraft("address", event.target.value)}
              />
            </label>
            <label className="field">
              <span>Join month</span>
              <input
                type="month"
                value={normalizeMonthKey(draft.join_month) || ""}
                onChange={(event) => updateDraft("join_month", event.target.value)}
              />
            </label>
            <label className="field">
              <span>Monthly fee</span>
              <input
                type="number"
                min="0"
                value={draft.monthly_fee || 0}
                onChange={(event) => updateDraft("monthly_fee", event.target.value)}
              />
            </label>
            <label className="field">
              <span>Status</span>
              <select
                value={draft.status || "Active"}
                onChange={(event) => updateDraft("status", event.target.value)}
              >
                <option value="Active">Active</option>
                <option value="Inactive">Inactive</option>
              </select>
            </label>
            <label className="field">
              <span>Notes</span>
              <input
                value={draft.notes || ""}
                onChange={(event) => updateDraft("notes", event.target.value)}
              />
            </label>
          </div>
        ) : (
          <dl className="detail-grid">
            <div>
              <dt>Parent</dt>
              <dd>{student.parent_name || "-"}</dd>
            </div>
            <div>
              <dt>Location</dt>
              <dd>{student.location || "-"}</dd>
            </div>
            <div>
              <dt>WhatsApp</dt>
              <dd>{student.whatsapp_number || "-"}</dd>
            </div>
            <div>
              <dt>Email</dt>
              <dd>{student.email || "-"}</dd>
            </div>
            <div>
              <dt>Alternate phone</dt>
              <dd>{student.alternate_phone || "-"}</dd>
            </div>
            <div>
              <dt>Address</dt>
              <dd>{student.address || "-"}</dd>
            </div>
            <div>
              <dt>Join month</dt>
              <dd>{formatReadableDate(student.join_month)}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{student.status || "-"}</dd>
            </div>
            <div>
              <dt>Monthly fee</dt>
              <dd>{formatter.format(Number(student.monthly_fee || 0))}</dd>
            </div>
            <div>
              <dt>Notes</dt>
              <dd>{student.notes || "-"}</dd>
            </div>
          </dl>
        )}

        <div className="student-history">
          <div className="student-modal-head">
            <h4>Fee history</h4>
            {cleanupCandidatesCount > 0 ? (
              <button
                type="button"
                className="ghost-button"
                onClick={cleanupHistory}
                disabled={isCleaningHistory}
              >
                {isCleaningHistory ? "Cleaning..." : `Clean Pending Rows (${cleanupCandidatesCount})`}
              </button>
            ) : null}
          </div>
          <div className="history-list history-list-minimal">
            <div className="history-head">
              <span>Date & Time</span>
              <span>Status</span>
              <span>Payment mode</span>
            </div>
            {transactionHistory.length ? (
              transactionHistory.map((tx) => (
                <div key={tx.fee_row_id} className="history-item">
                  <span>{formatReadableDateTime(tx.payment_date)}</span>
                  <span>{tx.status || "-"}</span>
                  <span>{tx.payment_mode || "-"}</span>
                </div>
              ))
            ) : (
              <p>No fee history rows available.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* Legacy block kept temporarily for reference; disabled to avoid duplicate/broken JSX.
function PaymentScreen({
  formatter,
  students,
  availableMonths,
  appSettings,
  onAddBulkPaymentRows,
  isSavingPayment,
  initialStudentId,
  selectedMonthKey,
}) {
  const bulkMonthInputRef = useRef(null);
  const [bulkFormError, setBulkFormError] = useState("");
  const [bulkFormState, setBulkFormState] = useState({
    month_key: selectedMonthKey || "",
    payment_mode: "Online",
    transfer_date: new Date().toISOString().slice(0, 10),
    fee_override: "",
    lines: [{ student_id: "", amount_received: "" }],
  });
  const minMonth = availableMonths[0]?.key || "";
  const maxMonth = availableMonths[availableMonths.length - 1]?.key || "";
  const defaultMonth = selectedMonthKey || availableMonths[availableMonths.length - 1]?.key || "";

  useEffect(() => {
    setBulkFormState((current) => ({
      ...current,
      month_key: selectedMonthKey || current.month_key || defaultMonth,
      lines: current.lines.map((line, index) =>
        index === 0
          ? { ...line, student_id: initialStudentId || line.student_id || "" }
          : line,
      ),
    }));
  }, [defaultMonth, initialStudentId, selectedMonthKey]);

  function updateBulkField(field, value) {
    setBulkFormState((current) => ({ ...current, [field]: value }));
  }

  function updateBulkLine(index, field, value) {
    setBulkFormState((current) => ({
      ...current,
      lines: current.lines.map((line, lineIndex) =>
        lineIndex === index ? { ...line, [field]: value } : line,
      ),
    }));
  }

  function addBulkLine() {
    setBulkFormState((current) => ({
      ...current,
      lines: [...current.lines, { student_id: "", amount_received: "" }],
    }));
  }

  function removeBulkLine(index) {
    setBulkFormState((current) => ({
      ...current,
      lines:
        current.lines.length <= 1
          ? [{ student_id: "", amount_received: "" }]
          : current.lines.filter((_, lineIndex) => lineIndex !== index),
    }));
  }

  async function submitBulkPayment(event) {
    event.preventDefault();
    const normalizedLines = bulkFormState.lines.map((line) => ({
      student_id: String(line.student_id || "").trim(),
      amount_received: String(line.amount_received || "").trim(),
    }));
    const hasIncompleteRow = normalizedLines.some(
      (line) => (line.student_id && !line.amount_received) || (!line.student_id && line.amount_received),
    );
    if (hasIncompleteRow) {
      setBulkFormError("Each row needs both Student name and Amount received.");
      return;
    }
    const validLines = normalizedLines.filter((line) => line.student_id && line.amount_received);
    if (!validLines.length) {
      setBulkFormError("Add at least one student and amount for save.");
      return;
    }
    if (!bulkFormState.month_key) {
      setBulkFormError("Payment month is required.");
      return;
    }
    if (!bulkFormState.transfer_date) {
      setBulkFormError("Transfer date is required.");
      return;
    }
    const invalidAmountRow = validLines.find((line) => Number(line.amount_received) <= 0);
    if (invalidAmountRow) {
      setBulkFormError("Amount received must be greater than 0.");
      return;
    }

    const uniqueStudents = new Set(validLines.map((line) => line.student_id));
    if (uniqueStudents.size !== validLines.length) {
      setBulkFormError("Duplicate student entries found. Keep only one row per student.");
      return;
    }

    setBulkFormError("");
    const saved = await onAddBulkPaymentRows({
      month_key: bulkFormState.month_key,
      payment_mode: bulkFormState.payment_mode,
      transfer_date: bulkFormState.transfer_date,
      fee_override: bulkFormState.fee_override,
      lines: validLines,
    });

    if (!saved) return;
    setBulkFormState((current) => ({
      ...current,
      lines: [{ student_id: initialStudentId || "", amount_received: "" }],
      fee_override: "",
      month_key: selectedMonthKey || current.month_key || defaultMonth,
    }));
  }

  return (
    <section className="panel stack-lg">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Payment entry</p>
          <h2>Add payments</h2>
        </div>
        <p className="section-copy">
          Month-wise tracking keeps pending reminders accurate. Add one or multiple students in one
          payment window.
        </p>
      </div>

        <label className="field">
          <span>Payment covers month</span>
          {MONTH_INPUT_SUPPORTED ? (
            <div
              className="month-input-shell"
              onClick={() => openMonthPicker(paymentMonthInputRef.current)}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  openMonthPicker(paymentMonthInputRef.current);
                }
              }}
              aria-label="Pick payment month"
            >
              <input
                ref={paymentMonthInputRef}
                type="month"
                value={formState.month_key}
                min={minMonth}
                max={maxMonth}
                onChange={(event) => updateField("month_key", event.target.value)}
              />
              <button
                type="button"
                className="month-icon-button"
                onClick={() => openMonthPicker(paymentMonthInputRef.current)}
                tabIndex={-1}
                aria-hidden="true"
              >
                📅
              </button>
            </div>
          ) : (
            <select
              value={formState.month_key}
              onChange={(event) => updateField("month_key", event.target.value)}
            >
              {availableMonths.map((month) => (
                <option key={month.key} value={month.key}>
                  {month.label}
                </option>
              ))}
            </select>
          )}
          <p className="tiny-copy">{formatMonthLabel(formState.month_key)}</p>
        </label>

        <label className="field">
          <span>Payment mode</span>
          <select
            value={formState.payment_mode}
            onChange={(event) => updateField("payment_mode", event.target.value)}
          >
            <option value="Cash">Cash</option>
            <option value="Online">Online</option>
          </select>
        </label>

        <label className="field">
          <span>Transfer date</span>
          <input
            type="date"
            value={formState.transfer_date}
            onChange={(event) => updateField("transfer_date", event.target.value)}
          />
        </label>

        <label className="field">
          <span>Amount received</span>
          <input
            type="number"
            min="0"
            placeholder="0"
            required
            value={formState.amount_received}
            onChange={(event) => updateField("amount_received", event.target.value)}
          />
        </label>

        <label className="field">
          <span>Expected fee override (optional)</span>
          <input
            type="number"
            min="0"
            placeholder={`Default ${formatter.format(appSettings.default_monthly_fee)}`}
            value={formState.fee_override || ""}
            onChange={(event) => updateField("fee_override", event.target.value)}
          />
          <p className="tiny-copy">Set 0 for a waiver month (no fee required).</p>
        </label>

        <div className="field">
          <span>Status</span>
          <p className="status-note">
            Auto-calculated on save: full amount = Paid, partial amount = Partial, zero = Pending.
            Use fee override for concessions or mid-month join.
          </p>
        </div>

        <button type="submit" className="primary-button" disabled={isSavingPayment}>
          {isSavingPayment ? "Saving..." : "Save payment row"}
        </button>
      </form>
      {paymentFormError ? <div className="info-card muted">{paymentFormError}</div> : null}

      <div className="bulk-payment-block">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Bulk payment entry</p>
            <h2>Add multiple payments at once</h2>
          </div>
          <p className="section-copy">
            Use this when several students pay in the same window. Existing single-entry form stays
            unchanged.
          </p>
        </div>

        <form className="payment-form" onSubmit={submitBulkPayment}>
          <label className="field">
            <span>Payment covers month</span>
            {MONTH_INPUT_SUPPORTED ? (
              <div
                className="month-input-shell"
                onClick={() => openMonthPicker(bulkMonthInputRef.current)}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    openMonthPicker(bulkMonthInputRef.current);
                  }
                }}
                aria-label="Pick bulk payment month"
              >
                <input
                  ref={bulkMonthInputRef}
                  type="month"
                  value={bulkFormState.month_key}
                  min={minMonth}
                  max={maxMonth}
                  onChange={(event) => updateBulkField("month_key", event.target.value)}
                />
                <button
                  type="button"
                  className="month-icon-button"
                  onClick={() => openMonthPicker(bulkMonthInputRef.current)}
                  tabIndex={-1}
                  aria-hidden="true"
                >
                  📅
                </button>
              </div>
            ) : (
              <select
                value={bulkFormState.month_key}
                onChange={(event) => updateBulkField("month_key", event.target.value)}
              >
                {availableMonths.map((month) => (
                  <option key={month.key} value={month.key}>
                    {month.label}
                  </option>
                ))}
              </select>
            )}
            <p className="tiny-copy">{formatMonthLabel(bulkFormState.month_key)}</p>
          </label>

          <label className="field">
            <span>Payment mode</span>
            <select
              value={bulkFormState.payment_mode}
              onChange={(event) => updateBulkField("payment_mode", event.target.value)}
            >
              <option value="Cash">Cash</option>
              <option value="Online">Online</option>
            </select>
          </label>

          <label className="field">
            <span>Transfer date</span>
            <input
              type="date"
              value={bulkFormState.transfer_date}
              onChange={(event) => updateBulkField("transfer_date", event.target.value)}
            />
          </label>

          <label className="field">
            <span>Expected fee override (optional)</span>
            <input
              type="number"
              min="0"
              placeholder={`Default ${formatter.format(appSettings.default_monthly_fee)}`}
              value={bulkFormState.fee_override || ""}
              onChange={(event) => updateBulkField("fee_override", event.target.value)}
            />
            <p className="tiny-copy">Set 0 for waiver month.</p>
          </label>

          <div className="field bulk-lines-field">
            <span>Students and amount received</span>
            <div className="bulk-lines">
              {bulkFormState.lines.map((line, index) => (
                <div key={`bulk-line-${index}`} className="bulk-line-row">
                  <select
                    value={line.student_id}
                    onChange={(event) => updateBulkLine(index, "student_id", event.target.value)}
                  >
                    <option value="">----</option>
                    {students.map((student) => (
                      <option key={student.student_id} value={student.student_id}>
                        {student.student_name}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min="0"
                    placeholder="Amount"
                    value={line.amount_received}
                    onChange={(event) =>
                      updateBulkLine(index, "amount_received", event.target.value)
                    }
                  />
                  <button
                    type="button"
                    className="ghost-button bulk-remove-btn"
                    onClick={() => removeBulkLine(index)}
                    aria-label="Remove row"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
            <button type="button" className="ghost-button bulk-add-btn" onClick={addBulkLine}>
              + Add row
            </button>
          </div>

          <button type="submit" className="primary-button" disabled={isSavingPayment}>
            {isSavingPayment ? "Saving..." : "Save bulk payments"}
          </button>
        </form>
        {bulkFormError ? <div className="info-card muted">{bulkFormError}</div> : null}
      </div>

    </section>
  );
}

*/
function PaymentEntryScreen({
  formatter,
  students,
  availableMonths,
  appSettings,
  onAddBulkPaymentRows,
  isSavingPayment,
  initialStudentId,
  selectedMonthKey,
}) {
  const bulkMonthInputRef = useRef(null);
  const [bulkFormError, setBulkFormError] = useState("");
  const minMonth = availableMonths[0]?.key || "";
  const maxMonth = availableMonths[availableMonths.length - 1]?.key || "";
  const defaultMonth = selectedMonthKey || availableMonths[availableMonths.length - 1]?.key || "";
  const [bulkFormState, setBulkFormState] = useState({
    month_key: defaultMonth,
    payment_mode: "Online",
    transfer_date: new Date().toISOString().slice(0, 10),
    fee_override: "",
    lines: [{ student_id: initialStudentId || "", amount_received: "" }],
  });

  useEffect(() => {
    setBulkFormState((current) => ({
      ...current,
      month_key: selectedMonthKey || current.month_key || defaultMonth,
      lines: current.lines.map((line, index) =>
        index === 0
          ? { ...line, student_id: initialStudentId || line.student_id || "" }
          : line,
      ),
    }));
  }, [defaultMonth, initialStudentId, selectedMonthKey]);

  function updateBulkField(field, value) {
    setBulkFormState((current) => ({ ...current, [field]: value }));
  }

  function updateBulkLine(index, field, value) {
    setBulkFormState((current) => ({
      ...current,
      lines: current.lines.map((line, lineIndex) =>
        lineIndex === index ? { ...line, [field]: value } : line,
      ),
    }));
  }

  function addBulkLine() {
    setBulkFormState((current) => ({
      ...current,
      lines: [...current.lines, { student_id: "", amount_received: "" }],
    }));
  }

  function removeBulkLine(index) {
    setBulkFormState((current) => ({
      ...current,
      lines:
        current.lines.length <= 1
          ? [{ student_id: initialStudentId || "", amount_received: "" }]
          : current.lines.filter((_, lineIndex) => lineIndex !== index),
    }));
  }

  async function submitBulkPayment(event) {
    event.preventDefault();
    const normalizedLines = bulkFormState.lines.map((line) => ({
      student_id: String(line.student_id || "").trim(),
      amount_received: String(line.amount_received || "").trim(),
    }));
    const hasIncompleteRow = normalizedLines.some(
      (line) => (line.student_id && !line.amount_received) || (!line.student_id && line.amount_received),
    );
    if (hasIncompleteRow) {
      setBulkFormError("Each row needs both Student name and Amount received.");
      return;
    }
    const validLines = normalizedLines.filter((line) => line.student_id && line.amount_received);
    if (!validLines.length) {
      setBulkFormError("Add at least one student and amount for save.");
      return;
    }
    if (!bulkFormState.month_key) {
      setBulkFormError("Payment month is required.");
      return;
    }
    if (!bulkFormState.transfer_date) {
      setBulkFormError("Transfer date is required.");
      return;
    }
    const invalidAmountRow = validLines.find((line) => Number(line.amount_received) < 0);
    if (invalidAmountRow) {
      setBulkFormError("Amount received cannot be negative.");
      return;
    }
    const uniqueStudents = new Set(validLines.map((line) => line.student_id));
    if (uniqueStudents.size !== validLines.length) {
      setBulkFormError("Duplicate student entries found. Keep only one row per student.");
      return;
    }

    setBulkFormError("");
    const saved = await onAddBulkPaymentRows({
      month_key: bulkFormState.month_key,
      payment_mode: bulkFormState.payment_mode,
      transfer_date: bulkFormState.transfer_date,
      fee_override: bulkFormState.fee_override,
      lines: validLines,
    });

    if (!saved) return;
    setBulkFormState((current) => ({
      ...current,
      lines: [{ student_id: initialStudentId || "", amount_received: "" }],
      fee_override: "",
      month_key: selectedMonthKey || current.month_key || defaultMonth,
    }));
  }

  return (
    <section className="panel stack-lg">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Payment entry</p>
          <h2>Add payments</h2>
        </div>
        <p className="section-copy">
          Month-wise tracking keeps pending reminders accurate. Add one or multiple students in one
          payment window.
        </p>
      </div>

      <form className="payment-form" onSubmit={submitBulkPayment}>
        <label className="field">
          <span>Payment covers month</span>
          {MONTH_INPUT_SUPPORTED ? (
            <div
              className="month-input-shell"
              onClick={() => openMonthPicker(bulkMonthInputRef.current)}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  openMonthPicker(bulkMonthInputRef.current);
                }
              }}
              aria-label="Pick payment month"
            >
              <input
                ref={bulkMonthInputRef}
                type="month"
                value={bulkFormState.month_key}
                min={minMonth}
                max={maxMonth}
                onChange={(event) => updateBulkField("month_key", event.target.value)}
              />
              <button
                type="button"
                className="month-icon-button"
                onClick={() => openMonthPicker(bulkMonthInputRef.current)}
                tabIndex={-1}
                aria-hidden="true"
              >
                Cal
              </button>
            </div>
          ) : (
            <select
              value={bulkFormState.month_key}
              onChange={(event) => updateBulkField("month_key", event.target.value)}
            >
              {availableMonths.map((month) => (
                <option key={month.key} value={month.key}>
                  {month.label}
                </option>
              ))}
            </select>
          )}
          <p className="tiny-copy">{formatMonthLabel(bulkFormState.month_key)}</p>
        </label>

        <label className="field">
          <span>Payment mode</span>
          <select
            value={bulkFormState.payment_mode}
            onChange={(event) => updateBulkField("payment_mode", event.target.value)}
          >
            <option value="Cash">Cash</option>
            <option value="Online">Online</option>
          </select>
        </label>

        <label className="field">
          <span>Transfer date</span>
          <input
            type="date"
            required
            value={bulkFormState.transfer_date}
            onChange={(event) => updateBulkField("transfer_date", event.target.value)}
          />
        </label>

        <label className="field">
          <span>Expected fee override (optional)</span>
          <input
            type="number"
            min="0"
            placeholder={`Default ${formatter.format(appSettings.default_monthly_fee)}`}
            value={bulkFormState.fee_override || ""}
            onChange={(event) => updateBulkField("fee_override", event.target.value)}
          />
          <p className="tiny-copy">Set 0 for a waiver month.</p>
        </label>

        <div className="field bulk-lines-field">
          <span>Students and amount received</span>
          <div className="bulk-lines">
            {bulkFormState.lines.map((line, index) => (
              <div key={`bulk-line-${index}`} className="bulk-line-row">
                <select
                  value={line.student_id}
                  onChange={(event) => updateBulkLine(index, "student_id", event.target.value)}
                >
                  <option value="">----</option>
                  {students.map((student) => (
                    <option key={student.student_id} value={student.student_id}>
                      {student.student_name}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  min="0"
                  placeholder="Amount"
                  value={line.amount_received}
                  onChange={(event) => updateBulkLine(index, "amount_received", event.target.value)}
                />
                <button
                  type="button"
                  className="ghost-button bulk-remove-btn"
                  onClick={() => removeBulkLine(index)}
                  aria-label="Remove row"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
          <button type="button" className="ghost-button bulk-add-btn" onClick={addBulkLine}>
            + Add row
          </button>
        </div>

        <div className="field">
          <span>Status</span>
          <p className="status-note">
            Auto-calculated on save: full amount = Paid, partial amount = Partial, zero = Pending.
            Use fee override for concessions or mid-month join.
          </p>
        </div>

        <button type="submit" className="primary-button" disabled={isSavingPayment}>
          {isSavingPayment ? "Saving..." : "Save payment"}
        </button>
      </form>
      {bulkFormError ? <div className="info-card muted">{bulkFormError}</div> : null}
    </section>
  );
}

function ReminderQueue({ reminderGroups, formatter, appSettings }) {
  return (
    <section className="panel stack-lg">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Reminder queue</p>
          <h2>Pending and partial dues only</h2>
        </div>
        <p className="section-copy">
          Each reminder shows the exact due months and remaining amounts so parents can settle the
          right balance.
        </p>
      </div>

      <div className="reminder-list">
        {reminderGroups.map((student) => {
          const reminderText = generateReminderText({
            template: appSettings.whatsapp_message_template,
            studentName: student.student_name,
            dueRows: student.dueRows,
            totalDue: student.totalDue,
            formatter,
          });
          const whatsappLink = buildWhatsAppLink(student.whatsapp_number, reminderText);
          const breakdown = generateDueBreakdown(student.dueRows, formatter);

          return (
            <article key={student.student_id} className="reminder-card">
              <div className="student-header">
                <div>
                  <h3>{student.student_name}</h3>
                  <p>{student.parent_name}</p>
                </div>
                <strong className="total-due">{formatter.format(student.totalDue)}</strong>
              </div>

              <div className="breakdown-block">
                <h4>Month-wise dues</h4>
                <ul>
                  {breakdown.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>

              <div className="preview-block">
                <h4>Reminder preview</h4>
                <p>{reminderText}</p>
              </div>

              <a className="whatsapp-button" href={whatsappLink} target="_blank" rel="noreferrer">
                Open WhatsApp
              </a>
            </article>
          );
        })}
      </div>
    </section>
  );
}

export default function App() {
  const [authChecking, setAuthChecking] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [authError, setAuthError] = useState("");
  const [lockoutUntil, setLockoutUntil] = useState("");
  const [activeScreen, setActiveScreen] = useState("dashboard");
  const [monthKey, setMonthKey] = useState("");
  const [studentsMonthFilter, setStudentsMonthFilter] = useState(() => getCurrentMonthKey());
  const [studentsPaymentStatusFilter, setStudentsPaymentStatusFilter] = useState([]);
  const [studentsPaymentModeFilter, setStudentsPaymentModeFilter] = useState([]);
  const [studentsRangeFilter, setStudentsRangeFilter] = useState({ from: "", to: "" });
  const [paymentStudentId, setPaymentStudentId] = useState("");
  const [paymentMonthOverride, setPaymentMonthOverride] = useState("");
  const [localStudents, setLocalStudents] = useState(initialStudents);
  const [localMonthlyFees, setLocalMonthlyFees] = useState(initialMonthlyFees);
  const [appSettings, setAppSettings] = useState(settings);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [statusSyncingId, setStatusSyncingId] = useState("");
  const [isSavingPayment, setIsSavingPayment] = useState(false);
  const [isAddingStudent, setIsAddingStudent] = useState(false);
  const [isSavingStudentProfile, setIsSavingStudentProfile] = useState(false);
  const [isCleaningHistory, setIsCleaningHistory] = useState(false);
  const [selectedStudentId, setSelectedStudentId] = useState("");
  const [logoLoadFailed, setLogoLoadFailed] = useState(false);
  const [successModal, setSuccessModal] = useState(null);
  const [debugTick, setDebugTick] = useState(0);
  const [hasHydratedSheetsData, setHasHydratedSheetsData] = useState(false);
  const debugEnabled = isDebugModeEnabled();
  const authGateEnabled = true;

  const hasSheetsEndpoint = hasSheetsEndpointConfigured();

  useEffect(() => {
    let isMounted = true;

    async function bootstrapSession() {
      if (!authGateEnabled) {
        if (!isMounted) return;
        setAuthenticated(true);
        setAuthChecking(false);
        return;
      }

      try {
        const response = await fetch("/api/auth/session");
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json();
        if (!isMounted) return;
        setAuthenticated(Boolean(body?.authenticated));
        setAuthError("");
      } catch (error) {
        if (!isMounted) return;
        if (import.meta.env.DEV) {
          setAuthenticated(true);
          setAuthError("");
        } else {
          setAuthenticated(false);
          setAuthError("Authentication check failed. Please refresh and try again.");
        }
      } finally {
        if (isMounted) setAuthChecking(false);
      }
    }

    bootstrapSession();
    return () => {
      isMounted = false;
    };
  }, [authGateEnabled]);

  useEffect(() => {
    let isMounted = true;

    async function loadFromSheets() {
      if (!authenticated) {
        setIsLoading(false);
        return;
      }

      const cached = readSheetsCache();
      const hasCachedData = Boolean(cached);
      if (hasCachedData) {
        if (!isMounted) return;
        setLocalStudents(cached.students);
        setLocalMonthlyFees(cached.monthlyFees);
        setAppSettings(cached.settings);
        setHasHydratedSheetsData(true);
        setIsLoading(false);
      }

      if (!hasSheetsEndpoint) {
        if (!isMounted) return;
        setIsLoading(false);
        setLoadError(
          hasCachedData
            ? "Google Sheets endpoint is not configured. Showing cached data."
            : "Google Sheets endpoint is not configured. Set VITE_SHEETS_WEB_APP_URL in .env to load real data.",
        );
        return;
      }

      try {
        if (!hasCachedData) setIsLoading(true);
        const data = await fetchAllSheetsData();
        if (!isMounted) return;
        setLocalStudents(data.students);
        setLocalMonthlyFees(data.monthlyFees);
        setAppSettings(data.settings);
        setHasHydratedSheetsData(true);
        writeSheetsCache(data);
        setLoadError("");
      } catch (error) {
        if (!isMounted) return;
        if (!hasCachedData) {
          setLoadError(
            `Could not load Google Sheets data: ${error.message}. Showing local sample data.`,
          );
        } else {
          setLoadError(`Could not refresh Google Sheets data: ${error.message}. Showing cached data.`);
        }
      } finally {
        if (isMounted) setIsLoading(false);
      }
    }

    loadFromSheets();
    return () => {
      isMounted = false;
    };
  }, [authenticated, hasSheetsEndpoint]);

  useEffect(() => {
    if (!authenticated || !hasHydratedSheetsData) return;
    writeSheetsCache({
      students: localStudents,
      monthlyFees: localMonthlyFees,
      settings: appSettings,
    });
  }, [appSettings, authenticated, hasHydratedSheetsData, localMonthlyFees, localStudents]);

  useEffect(() => {
    if (!debugEnabled) return undefined;
    const timer = setInterval(() => setDebugTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [debugEnabled]);

  const monthChoices = useMemo(() => {
    const byData = [...new Set(localMonthlyFees.map((fee) => normalizeMonthKey(fee.month_key)))]
      .filter(Boolean)
      .sort();
    const fallback = monthOptions.map((m) => m.key);
    const baseKeys = byData.length ? byData : fallback;
    const currentMonth = getCurrentMonthKey();
    const futureKeys = Array.from({ length: 24 }, (_, idx) => addMonthsToKey(currentMonth, idx));
    const keys = [...new Set([...baseKeys, ...futureKeys])].filter(Boolean).sort();
    return keys.map((key) => ({ key, label: formatMonthLabel(key) }));
  }, [localMonthlyFees]);

  useEffect(() => {
    if (!monthChoices.length) return;
    const isCurrentMonthValid = monthChoices.some((m) => m.key === monthKey);
    if (!isCurrentMonthValid) {
      const currentMonthKey = getCurrentMonthKey();
      const currentMonthChoice = monthChoices.find((m) => m.key === currentMonthKey);
      setMonthKey(currentMonthChoice?.key || monthChoices[monthChoices.length - 1].key);
    }
  }, [monthChoices, monthKey]);

  async function setLocalStudentStatus(studentId, status) {
    const previousStudents = localStudents;
    setStatusSyncingId(studentId);
    setLocalStudents((current) =>
      current.map((student) => (student.student_id === studentId ? { ...student, status } : student)),
    );

    if (!hasSheetsEndpoint) {
      setStatusSyncingId("");
      return;
    }

    try {
      await updateStudentStatus(studentId, status);
    } catch (error) {
      setLocalStudents(previousStudents);
      setLoadError(`Status update failed: ${error.message}`);
    } finally {
      setStatusSyncingId("");
    }
  }

  function buildPaymentFeeRow(formState, sourceMonthlyFees, feeRowIdSeed) {
    const student = localStudents.find((item) => item.student_id === formState.student_id);
    if (!student) return { ok: false, error: "Student not found for payment row." };

    const amountPaid = Number(formState.amount_received || 0);
    if (!Number.isFinite(amountPaid) || amountPaid <= 0) {
      return { ok: false, error: "Amount received must be greater than 0." };
    }

    const monthKeyToSave = normalizeMonthKey(formState.month_key);
    if (!monthKeyToSave) return { ok: false, error: "Payment month is required." };

    const hasFeeOverride = String(formState.fee_override ?? "").trim() !== "";
    const feeOverride = Number(formState.fee_override || 0);
    const existingMonthRows = sourceMonthlyFees.filter(
      (row) =>
        row.student_id === student.student_id && normalizeMonthKey(row.month_key) === monthKeyToSave,
    );
    const existingFeeAmount = existingMonthRows.reduce(
      (max, row) => Math.max(max, Number(row.fee_amount || 0)),
      0,
    );
    const feeAmount = hasFeeOverride
      ? Math.max(feeOverride, 0)
      : existingFeeAmount > 0
        ? existingFeeAmount
        : Number(student.monthly_fee || appSettings.default_monthly_fee || 0);
    const existingPaid = existingMonthRows.reduce((sum, row) => sum + Number(row.amount_paid || 0), 0);
    const totalPaid = existingPaid + amountPaid;
    const monthLabel =
      monthChoices.find((m) => m.key === monthKeyToSave)?.label || formatMonthLabel(monthKeyToSave);

    let status = "Pending";
    if (totalPaid > 0 && totalPaid < feeAmount) status = "Partial";
    if (totalPaid >= feeAmount) status = "Paid";
    const balanceDue = Math.max(feeAmount - totalPaid, 0);

    return {
      ok: true,
      student,
      monthLabel,
      feeRow: {
        fee_row_id: feeRowIdSeed,
        student_id: student.student_id,
        student_name: student.student_name,
        month_key: monthKeyToSave,
        month_label: monthLabel,
        fee_amount: feeAmount,
        amount_paid: amountPaid,
        balance_due: balanceDue,
        status,
        payment_date: formState.transfer_date,
        payment_mode: formState.payment_mode,
        payment_ref: "",
        reminder_sent: false,
        reminder_sent_date: "",
        notes: "",
      },
    };
  }

  async function addBulkPaymentRows(bulkFormState) {
    const lines = Array.isArray(bulkFormState.lines) ? bulkFormState.lines : [];
    if (!lines.length) {
      setLoadError("No bulk payment rows to save.");
      return false;
    }

    setIsSavingPayment(true);
    let workingMonthlyFees = [...localMonthlyFees];
    const rowsToAdd = [];
    const monthsTouched = new Set();

    try {
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const built = buildPaymentFeeRow(
          {
            ...bulkFormState,
            student_id: line.student_id,
            amount_received: line.amount_received,
          },
          workingMonthlyFees,
          `FEE-${Date.now()}-${i}`,
        );
        if (!built.ok) throw new Error(built.error);
        rowsToAdd.push(built.feeRow);
        monthsTouched.add(built.monthLabel);
        workingMonthlyFees = [...workingMonthlyFees, built.feeRow];
      }

      if (hasSheetsEndpoint) {
        for (let i = 0; i < rowsToAdd.length; i += 1) {
          // Sequential writes keep row order predictable in Google Sheets.
          await addMonthlyFeeRow(rowsToAdd[i]);
        }
      }

      setLocalMonthlyFees((current) => [...current, ...rowsToAdd]);
      setLoadError("");
      setSuccessModal({
        title: rowsToAdd.length === 1 ? "Payment saved" : "Bulk payments saved",
        message:
          rowsToAdd.length === 1
            ? `${rowsToAdd[0].student_name} - ${rowsToAdd[0].month_label}`
            : `${rowsToAdd.length} payment row(s) saved for ${Array.from(monthsTouched).join(", ")}.`,
      });
      return true;
    } catch (error) {
      setLoadError(`Could not save bulk payments: ${error.message}`);
      return false;
    } finally {
      setIsSavingPayment(false);
    }
  }

  async function addStudent(studentDraft) {
    const studentId = `STU-${Date.now().toString().slice(-6)}`;
    const joinMonth = normalizeMonthKey(studentDraft.join_month) || monthKey;
    const studentRow = {
      student_id: studentId,
      student_name: studentDraft.student_name,
      parent_name: studentDraft.parent_name,
      email: studentDraft.email || "",
      whatsapp_number: studentDraft.whatsapp_number,
      alternate_phone: studentDraft.alternate_phone,
      address: studentDraft.address || "",
      location: studentDraft.location,
      monthly_fee: Number(studentDraft.monthly_fee || appSettings.default_monthly_fee || 0),
      join_month: joinMonth,
      status: studentDraft.status || "Active",
      notes: studentDraft.notes || "",
    };

    setIsAddingStudent(true);
    try {
      if (hasSheetsEndpoint) {
        await addStudentRow(studentRow);
      }
      setLocalStudents((current) => [...current, studentRow]);
      setLoadError("");
      setSuccessModal({
        title: "Student added",
        message: `${studentRow.student_name} has been added.`,
      });
      return true;
    } catch (error) {
      setLoadError(`Could not add student: ${error.message}`);
      return false;
    } finally {
      setIsAddingStudent(false);
    }
  }

  async function saveStudentProfile(studentRow) {
    const normalized = {
      ...studentRow,
      monthly_fee: Number(studentRow.monthly_fee || 0),
      join_month: normalizeMonthKey(studentRow.join_month) || studentRow.join_month,
    };
    const previousStudents = localStudents;
    setIsSavingStudentProfile(true);
    setLocalStudents((current) =>
      current.map((item) => (item.student_id === normalized.student_id ? normalized : item)),
    );
    try {
      if (hasSheetsEndpoint) {
        await updateStudentRow(normalized);
      }
      setLoadError("");
      setSuccessModal({
        title: "Profile updated",
        message: `${normalized.student_name} details saved.`,
      });
      return true;
    } catch (error) {
      setLocalStudents(previousStudents);
      setLoadError(`Could not update student: ${error.message}`);
      return false;
    } finally {
      setIsSavingStudentProfile(false);
    }
  }

  const formatter = useMemo(() => getCurrencyFormatter(appSettings.currency), [appSettings.currency]);
  const studentsWithStatus = useMemo(
    () => getStudentStatuses(localStudents, localMonthlyFees, monthKey),
    [localStudents, localMonthlyFees, monthKey],
  );
  const monthEligibleStudents = useMemo(
    () => studentsWithStatus.filter((student) => hasJoinedByMonth(student.join_month, monthKey)),
    [studentsWithStatus, monthKey],
  );
  const totalStudents = monthEligibleStudents.length;
  const totalAmount = useMemo(
    () =>
      monthEligibleStudents.reduce(
        (sum, student) => sum + Number(student.selectedMonthFee?.amount_paid || 0),
        0,
      ),
    [monthEligibleStudents],
  );
  const expectedAmount = useMemo(
    () =>
      monthEligibleStudents.reduce(
        (sum, student) => sum + Number(student.selectedMonthFee?.fee_amount ?? student.monthly_fee ?? 0),
        0,
      ),
    [monthEligibleStudents],
  );
  const pendingGapAmount = useMemo(
    () => Math.max(expectedAmount - totalAmount, 0),
    [expectedAmount, totalAmount],
  );
  const debugStatus = useMemo(() => getSheetsDebugStatus(), [debugTick, loadError, isLoading]);
  const reminderGroups = useMemo(
    () => {
      const now = new Date();
      const currentMonth = getCurrentMonthKey();
      const reminderDay = Number(appSettings.reminder_day || 5);

      return groupPendingDuesByStudent(localStudents, localMonthlyFees)
        .map((student) => {
          const eligibleDueRows = student.dueRows.filter((fee) => {
            const feeMonth = normalizeMonthKey(fee.month_key);
            if (!feeMonth || feeMonth > currentMonth) return false;
            return isReminderDueForMonth(feeMonth, reminderDay, now);
          });
          if (!eligibleDueRows.length) return null;
          return {
            ...student,
            dueRows: eligibleDueRows,
            totalDue: eligibleDueRows.reduce((sum, fee) => sum + Number(fee.balance_due || 0), 0),
          };
        })
        .filter((student) => student && student.status === "Active");
    },
    [appSettings.reminder_day, localMonthlyFees, localStudents],
  );
  const reminderMetaByStudentId = useMemo(() => {
    return reminderGroups.reduce((acc, student) => {
      const dueBreakdown = generateDueBreakdown(student.dueRows, formatter);
      const reminderText = generateReminderText({
        template: appSettings.whatsapp_message_template,
        studentName: student.student_name,
        dueRows: student.dueRows,
        totalDue: student.totalDue,
        formatter,
      });
      acc[student.student_id] = {
        dueBreakdown,
        reminderText,
        whatsappLink: buildWhatsAppLink(student.whatsapp_number, reminderText),
      };
      return acc;
    }, {});
  }, [appSettings.whatsapp_message_template, formatter, reminderGroups]);
  const selectedStudent = useMemo(
    () => localStudents.find((student) => student.student_id === selectedStudentId) || null,
    [localStudents, selectedStudentId],
  );
  const selectedStudentTransactionHistory = useMemo(
    () =>
      sortTransactionHistory(
        localMonthlyFees.filter((fee) => fee.student_id === selectedStudentId),
      ),
    [localMonthlyFees, selectedStudentId],
  );
  const selectedStudentCleanupCandidates = useMemo(
    () =>
      localMonthlyFees.filter((fee) => {
        if (fee.student_id !== selectedStudentId) return false;
        const status = String(fee.status || "").trim().toLowerCase();
        const amountPaid = Number(fee.amount_paid || 0);
        const hasPaymentDate = Boolean(parseDateValue(fee.payment_date));
        return status === "pending" && amountPaid <= 0 && !hasPaymentDate;
      }),
    [localMonthlyFees, selectedStudentId],
  );

  function openPaymentForStudent(studentId, monthKeyOverride = "") {
    setPaymentStudentId(studentId);
    setPaymentMonthOverride(normalizeMonthKey(monthKeyOverride));
    setActiveScreen("payment");
  }

  function openStudentDetails(studentId) {
    setSelectedStudentId(studentId);
  }

  async function cleanupSelectedStudentHistory(studentId) {
    const candidates = localMonthlyFees.filter((fee) => {
      if (fee.student_id !== studentId) return false;
      const status = String(fee.status || "").trim().toLowerCase();
      const amountPaid = Number(fee.amount_paid || 0);
      const hasPaymentDate = Boolean(parseDateValue(fee.payment_date));
      return status === "pending" && amountPaid <= 0 && !hasPaymentDate;
    });
    const ids = candidates.map((row) => String(row.fee_row_id || "").trim()).filter(Boolean);

    if (!candidates.length) return true;
    if (!ids.length) {
      setLoadError("Cleanup skipped: no fee_row_id found for pending placeholder rows.");
      return false;
    }

    setIsCleaningHistory(true);
    try {
      if (hasSheetsEndpoint) {
        await deleteMonthlyFeeRows(ids);
      }
      const idSet = new Set(ids);
      setLocalMonthlyFees((current) =>
        current.filter((row) => !idSet.has(String(row.fee_row_id || "").trim())),
      );
      setLoadError("");
      setSuccessModal({
        title: "History cleaned",
        message: `Removed ${ids.length} pending placeholder row(s).`,
      });
      return true;
    } catch (error) {
      setLoadError(`Could not clean fee history: ${error.message}`);
      return false;
    } finally {
      setIsCleaningHistory(false);
    }
  }

  function openStudentsWithFilters({
    monthKey: targetMonthKey = monthKey,
    paymentStatuses = [],
    paymentModes = [],
    monthRangeFrom = "",
    monthRangeTo = "",
  }) {
    const from = normalizeMonthKey(monthRangeFrom);
    const to = normalizeMonthKey(monthRangeTo);
    if (from && to) {
      const rangeFrom = from <= to ? from : to;
      const rangeTo = from <= to ? to : from;
      setStudentsMonthFilter("");
      setStudentsRangeFilter({ from: rangeFrom, to: rangeTo });
    } else {
      setStudentsMonthFilter(normalizeMonthKey(targetMonthKey));
      setStudentsRangeFilter({ from: "", to: "" });
    }
    setStudentsPaymentStatusFilter(paymentStatuses);
    setStudentsPaymentModeFilter(paymentModes);
    setActiveScreen("students");
  }

  function handleStudentsMonthFilterChange(value) {
    setStudentsMonthFilter(value);
    setStudentsRangeFilter({ from: "", to: "" });
  }

  async function handleLogin(passcode) {
    setAuthSubmitting(true);
    setAuthError("");
    setLockoutUntil("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passcode }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body?.ok) {
        setAuthError(body?.error || "Login failed");
        if (body?.lockedUntil) setLockoutUntil(body.lockedUntil);
        return false;
      }
      setAuthenticated(true);
      setAuthError("");
      setLockoutUntil("");
      setIsLoading(true);
      return true;
    } catch {
      setAuthError("Login request failed. Please try again.");
      return false;
    } finally {
      setAuthSubmitting(false);
    }
  }

  async function handleLogout() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // Keep logout local state even if network call fails.
    } finally {
      setAuthenticated(false);
      setSelectedStudentId("");
      setLoadError("");
    }
  }

  function handleScreenChange(nextScreen) {
    setActiveScreen(nextScreen);
    if (nextScreen === "payment") {
      setPaymentStudentId("");
      setPaymentMonthOverride("");
    }
  }

  if (authGateEnabled && authChecking) {
    return (
      <div className="app-shell">
        <main className="app-frame">
          <div className="info-card">Checking session...</div>
        </main>
      </div>
    );
  }

  if (authGateEnabled && !authenticated) {
    return (
      <LoginScreen
        isSubmitting={authSubmitting}
        error={authError}
        lockoutUntil={lockoutUntil}
        onLogin={handleLogin}
      />
    );
  }

  return (
    <div className="app-shell">
      <main className="app-frame">
        <header className="topbar">
          <div className="brand-wrap">
            {!logoLoadFailed ? (
              <img
                src="/mila-nartana-logo.png"
                alt="Mila Nartana logo"
                className="brand-logo"
                onError={() => setLogoLoadFailed(true)}
              />
            ) : (
              <div className="brand-logo brand-logo-fallback" aria-hidden="true">
                MN
              </div>
            )}
            <h1 className="brand-title">Mila Nartana Fee Tracker</h1>
          </div>
          <button type="button" className="ghost-button logout-btn" onClick={handleLogout}>
            Logout
          </button>
        </header>

        <ScreenNav activeScreen={activeScreen} onChange={handleScreenChange} />

        {isLoading && <div className="info-card">Loading data from Google Sheets...</div>}
        {!isLoading && loadError && <div className="info-card muted">{loadError}</div>}
        {debugEnabled && <DebugPanel debugStatus={debugStatus} loadError={loadError} />}

        {activeScreen === "dashboard" && (
          <Dashboard
            monthKey={monthKey}
            monthChoices={monthChoices}
            monthlyFees={localMonthlyFees}
            onMonthChange={setMonthKey}
            totalStudents={totalStudents}
            expectedAmount={expectedAmount}
            totalAmount={totalAmount}
            pendingGapAmount={pendingGapAmount}
            formatter={formatter}
            onOpenStudentsFiltered={openStudentsWithFilters}
          />
        )}
        {activeScreen === "students" && (
          <StudentsScreen
            studentsWithStatus={studentsWithStatus}
            formatter={formatter}
            onToggleStudentStatus={setLocalStudentStatus}
            statusSyncingId={statusSyncingId}
            onAddStudent={addStudent}
            isAddingStudent={isAddingStudent}
            onOpenStudentDetails={openStudentDetails}
            onQuickAddPayment={openPaymentForStudent}
            reminderMetaByStudentId={reminderMetaByStudentId}
            monthChoices={monthChoices}
            monthFilter={studentsMonthFilter}
            onMonthFilterChange={handleStudentsMonthFilterChange}
            rangeFilter={studentsRangeFilter}
            paymentStatusFilter={studentsPaymentStatusFilter}
            onPaymentStatusFilterChange={setStudentsPaymentStatusFilter}
            paymentModeFilter={studentsPaymentModeFilter}
            onPaymentModeFilterChange={setStudentsPaymentModeFilter}
          />
        )}
        {activeScreen === "payment" && (
          <PaymentEntryScreen
            formatter={formatter}
            students={localStudents}
            availableMonths={monthChoices}
            appSettings={appSettings}
            onAddBulkPaymentRows={addBulkPaymentRows}
            isSavingPayment={isSavingPayment}
            initialStudentId={paymentStudentId}
            selectedMonthKey={paymentMonthOverride || monthKey}
          />
        )}
        {activeScreen === "reminders" && (
          <ReminderQueue
            reminderGroups={reminderGroups}
            formatter={formatter}
            appSettings={appSettings}
          />
        )}
        <StudentDetailsModal
          student={selectedStudent}
          transactionHistory={selectedStudentTransactionHistory}
          cleanupCandidatesCount={selectedStudentCleanupCandidates.length}
          formatter={formatter}
          onSave={saveStudentProfile}
          onCleanupHistory={cleanupSelectedStudentHistory}
          isCleaningHistory={isCleaningHistory}
          isSaving={isSavingStudentProfile}
          onClose={() => setSelectedStudentId("")}
        />
        {successModal && (
          <div className="confirm-overlay" role="dialog" aria-modal="true" aria-label="Success">
            <div className="confirm-modal">
              <h3>{successModal.title}</h3>
              <p>{successModal.message}</p>
              <div className="confirm-actions">
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => setSuccessModal(null)}
                >
                  OK
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
