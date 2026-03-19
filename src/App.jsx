import { useEffect, useMemo, useRef, useState } from "react";
import {
  monthOptions,
  paymentFormDefaults,
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
  return [...rows].sort((a, b) =>
    String(b.payment_date || "").localeCompare(String(a.payment_date || "")),
  );
}

function SummaryCard({ label, value, tone }) {
  return (
    <div className={`summary-card summary-${tone}`}>
      <span className="summary-label">{label}</span>
      <strong className="summary-value">{value}</strong>
    </div>
  );
}

function DebugPanel({ debugStatus, loadError }) {
  const last = debugStatus.lastRequest || {};
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
          <dd>{debugStatus.writeTokenConfigured ? "Yes" : "No"}</dd>
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

function Dashboard({
  monthKey,
  monthChoices,
  onMonthChange,
  summary,
  totalAmount,
  formatter,
  appSettings,
  studentsWithStatus,
  reminderMetaByStudentId,
  onQuickAddPayment,
  onOpenStudentDetails,
}) {
  const monthInputRef = useRef(null);
  const monthLabel = monthChoices.find((option) => option.key === monthKey)?.label ?? monthKey;
  const minMonth = monthChoices[0]?.key || "";
  const maxMonth = monthChoices[monthChoices.length - 1]?.key || "";
  const reminderTriggerDate = getReminderTriggerDate(monthKey, appSettings.reminder_day);
  const reminderTriggerLabel = reminderTriggerDate
    ? formatReadableDate(reminderTriggerDate)
    : "-";

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

      <div className="summary-grid">
        <SummaryCard label="Paid" value={summary.paid} tone="paid" />
        <SummaryCard label="Pending" value={summary.pending} tone="pending" />
        <SummaryCard label="Partial" value={summary.partial} tone="partial" />
        <SummaryCard label="Total Amount" value={formatter.format(totalAmount)} tone="total" />
      </div>

      <div className="info-card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Selected month students</p>
            <h2>{monthLabel} status list</h2>
          </div>
          <p className="section-copy">Open student profile, add payment, or send reminder.</p>
        </div>

        <div className="student-list-table compact-student-table" role="table" aria-label="Dashboard month student list">
          <div className="student-list-head dashboard-table-head" role="row">
            <span>Name</span>
            <span>Due amount</span>
            <span>Actions</span>
          </div>
          {studentsWithStatus.map((student) => {
            const reminderMeta = reminderMetaByStudentId[student.student_id];
            const isUnpaidForSelectedMonth =
              student.selectedMonthStatus === "Pending" || student.selectedMonthStatus === "Partial";
            const isReminderEligible =
              isUnpaidForSelectedMonth &&
              isReminderDueForMonth(monthKey, appSettings.reminder_day) &&
              Boolean(reminderMeta);

            return (
              <div key={student.student_id} className="student-list-row dashboard-row" role="row">
                <div data-label="Name" className="cell-name">
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => onOpenStudentDetails(student.student_id)}
                  >
                    {student.student_name}
                  </button>
                  <p className="tiny-copy">{student.selectedMonthStatus}</p>
                </div>
                <div data-label="Due amount" className="cell-due">
                  <span
                    className={`due-amount-chip ${getDueAmountClass(
                      student.selectedMonthStatus,
                      Number(student.selectedMonthFee?.balance_due || 0),
                    )}`}
                  >
                    {formatter.format(Number(student.selectedMonthFee?.balance_due || 0))}
                  </span>
                </div>
                <div data-label="Actions" className="cell-actions dashboard-actions">
                  <button
                    type="button"
                    className="ghost-button icon-action"
                    onClick={() => onQuickAddPayment(student.student_id)}
                  >
                    +Pay
                  </button>
                  {isReminderEligible ? (
                    <a
                      className="whatsapp-button icon-action"
                      href={reminderMeta.whatsappLink}
                      target="_blank"
                      rel="noreferrer"
                    >
                      WA
                    </a>
                  ) : isUnpaidForSelectedMonth ? (
                    <span className="no-due-label">Reminders start {reminderTriggerLabel}</span>
                  ) : (
                    <span className="no-due-label">No reminder</span>
                  )}
                </div>
              </div>
            );
          })}
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
}) {
  const monthFilterInputRef = useRef(null);
  const [query, setQuery] = useState("");
  const [location, setLocation] = useState("All");
  const [activeFilter, setActiveFilter] = useState("All");
  const [monthFilter, setMonthFilter] = useState("");
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

  const visibleStudents = studentsWithStatus.filter((student) => {
    const matchesQuery = student.student_name.toLowerCase().includes(query.toLowerCase());
    const matchesLocation = location === "All" || student.location === location;
    const matchesActiveStatus = activeFilter === "All" || student.status === activeFilter;
    const matchesJoinMonth = monthFilter
      ? hasJoinedByMonth(student.join_month, monthFilter)
      : true;
    return matchesQuery && matchesLocation && matchesActiveStatus && matchesJoinMonth;
  });
  const studentRows = useMemo(() => {
    const hasNameSearch = query.trim().length > 0;
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
            monthLabel,
            monthStatus: status,
            dueAmount,
            monthDueAmount: dueAmount,
            totalPendingDue,
            lastPayment,
          },
        ];
      }

      if (hasNameSearch && fullHistory.length) {
        return fullHistory.map((fee) => ({
          key: `${student.student_id}-${fee.month_key}-history`,
          student,
          monthLabel: fee.month_label || formatMonthLabel(fee.month_key),
          monthStatus: fee.status || "Pending",
          dueAmount: Number(fee.balance_due || 0),
          monthDueAmount: Number(fee.balance_due || 0),
          totalPendingDue,
          lastPayment,
        }));
      }

      if (pendingHistory.length) {
        return pendingHistory.map((fee) => ({
          key: `${student.student_id}-${fee.month_key}`,
          student,
          monthLabel: fee.month_label || formatMonthLabel(fee.month_key),
          monthStatus: fee.status,
          dueAmount: Number(fee.balance_due || 0),
          monthDueAmount: Number(fee.balance_due || 0),
          totalPendingDue,
          lastPayment,
        }));
      }

      return [
        {
          key: `${student.student_id}-latest`,
          student,
          monthLabel: student.selectedMonth || "-",
          monthStatus: student.selectedMonthStatus || "Paid",
          dueAmount: Number(student.selectedMonthFee?.balance_due || 0),
          monthDueAmount: Number(student.selectedMonthFee?.balance_due || 0),
          totalPendingDue,
          lastPayment,
        },
      ];
    });
  }, [monthChoices, monthFilter, query, visibleStudents]);

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
        <p className="section-copy">
          Filter by month, location, and active status, then review due months.
        </p>
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
                  onChange={(event) => setMonthFilter(event.target.value)}
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
                onClick={() => setMonthFilter("")}
                disabled={!monthFilter}
              >
                All
              </button>
            </div>
          ) : (
            <select value={monthFilter} onChange={(event) => setMonthFilter(event.target.value)}>
              <option value="">All months</option>
              {monthChoices.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
          )}
          <p className="tiny-copy">{monthFilter ? formatMonthLabel(monthFilter) : "All months"}</p>
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

        <label className="field">
          <span>Status</span>
          <select value={activeFilter} onChange={(event) => setActiveFilter(event.target.value)}>
            <option value="All">All</option>
            <option value="Active">Active</option>
            <option value="Inactive">Inactive</option>
          </select>
        </label>
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
          <span>Actions</span>
        </div>

        {studentRows.map((row) => (
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
            <div data-label="Actions" className="cell-actions dashboard-actions">
              <button
                type="button"
                className="ghost-button icon-action"
                onClick={() => onQuickAddPayment(row.student.student_id)}
              >
                +Pay
              </button>
              {reminderMetaByStudentId[row.student.student_id] ? (
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
  formatter,
  onClose,
  onSave,
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
          <h4>Fee history</h4>
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

function PaymentScreen({
  formatter,
  students,
  availableMonths,
  appSettings,
  onAddPaymentRow,
  isSavingPayment,
  initialStudentId,
  selectedMonthKey,
}) {
  const paymentMonthInputRef = useRef(null);
  const [formState, setFormState] = useState(paymentFormDefaults);
  const minMonth = availableMonths[0]?.key || "";
  const maxMonth = availableMonths[availableMonths.length - 1]?.key || "";
  const defaultMonth = selectedMonthKey || availableMonths[availableMonths.length - 1]?.key || "";

  useEffect(() => {
    setFormState((current) => ({
      ...current,
      student_id: initialStudentId || current.student_id,
      month_key: selectedMonthKey || current.month_key,
    }));
  }, [initialStudentId, selectedMonthKey]);

  function updateField(field, value) {
    setFormState((current) => ({ ...current, [field]: value }));
  }

  async function submitPayment(event) {
    event.preventDefault();
    const saved = await onAddPaymentRow(formState);
    if (!saved) return;
    setFormState({
      student_id: students[0]?.student_id || "",
      month_key: defaultMonth,
      payment_mode: "Online",
      transfer_date: new Date().toISOString().slice(0, 10),
      fee_override: "",
      amount_received: "",
    });
  }

  return (
    <section className="panel stack-lg">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Payment entry</p>
          <h2>Add a payment row</h2>
        </div>
        <p className="section-copy">
          Month-wise tracking keeps pending reminders accurate. One row per student per month
          maps directly to the Google Sheets design.
        </p>
      </div>

      <form className="payment-form" onSubmit={submitPayment}>
        <label className="field">
          <span>Student name</span>
          <select
            value={formState.student_id}
            onChange={(event) => updateField("student_id", event.target.value)}
          >
            {students.map((student) => (
              <option key={student.student_id} value={student.student_id}>
                {student.student_name}
              </option>
            ))}
          </select>
        </label>

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
  const [activeScreen, setActiveScreen] = useState("dashboard");
  const [monthKey, setMonthKey] = useState("");
  const [paymentStudentId, setPaymentStudentId] = useState(paymentFormDefaults.student_id);
  const [localStudents, setLocalStudents] = useState(initialStudents);
  const [localMonthlyFees, setLocalMonthlyFees] = useState(initialMonthlyFees);
  const [appSettings, setAppSettings] = useState(settings);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [statusSyncingId, setStatusSyncingId] = useState("");
  const [isSavingPayment, setIsSavingPayment] = useState(false);
  const [isAddingStudent, setIsAddingStudent] = useState(false);
  const [isSavingStudentProfile, setIsSavingStudentProfile] = useState(false);
  const [selectedStudentId, setSelectedStudentId] = useState("");
  const [logoLoadFailed, setLogoLoadFailed] = useState(false);
  const [successModal, setSuccessModal] = useState(null);
  const [debugTick, setDebugTick] = useState(0);
  const debugEnabled = isDebugModeEnabled();

  const hasSheetsEndpoint = hasSheetsEndpointConfigured();

  useEffect(() => {
    let isMounted = true;

    async function loadFromSheets() {
      if (!hasSheetsEndpoint) {
        setIsLoading(false);
        setLoadError(
          "Google Sheets endpoint is not configured. Set VITE_SHEETS_WEB_APP_URL in .env to load real data.",
        );
        return;
      }

      try {
        const data = await fetchAllSheetsData();
        if (!isMounted) return;
        setLocalStudents(data.students);
        setLocalMonthlyFees(data.monthlyFees);
        setAppSettings(data.settings);
        setLoadError("");
      } catch (error) {
        if (!isMounted) return;
        setLoadError(
          `Could not load Google Sheets data: ${error.message}. Showing local sample data.`,
        );
      } finally {
        if (isMounted) setIsLoading(false);
      }
    }

    loadFromSheets();
    return () => {
      isMounted = false;
    };
  }, [hasSheetsEndpoint]);

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
    const keys = byData.length ? byData : fallback;
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

  async function addPaymentRow(formState) {
    const student = localStudents.find((item) => item.student_id === formState.student_id);
    if (!student) {
      setLoadError("Student not found for payment row.");
      return false;
    }

    const hasFeeOverride = String(formState.fee_override ?? "").trim() !== "";
    const feeOverride = Number(formState.fee_override || 0);
    const amountPaid = Number(formState.amount_received || 0);
    const monthKeyToSave = normalizeMonthKey(formState.month_key);
    const existingMonthRows = localMonthlyFees.filter(
      (row) => row.student_id === student.student_id && normalizeMonthKey(row.month_key) === monthKeyToSave,
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

    const feeRow = {
      fee_row_id: `FEE-${Date.now()}`,
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
    };

    setIsSavingPayment(true);
    try {
      if (hasSheetsEndpoint) {
        await addMonthlyFeeRow(feeRow);
      }
      setLocalMonthlyFees((current) => [...current, feeRow]);
      setLoadError("");
      setSuccessModal({
        title: "Payment saved",
        message: `${student.student_name} - ${monthLabel}`,
      });
      return true;
    } catch (error) {
      setLoadError(`Could not save payment row: ${error.message}`);
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
  const summary = useMemo(
    () =>
      monthEligibleStudents.reduce(
        (acc, student) => {
          if (student.selectedMonthStatus === "Paid") acc.paid += 1;
          else if (student.selectedMonthStatus === "Partial") acc.partial += 1;
          else acc.pending += 1;
          return acc;
        },
        { paid: 0, pending: 0, partial: 0 },
      ),
    [monthEligibleStudents],
  );
  const totalAmount = useMemo(
    () =>
      monthEligibleStudents.reduce(
        (sum, student) => sum + Number(student.selectedMonthFee?.amount_paid || 0),
        0,
      ),
    [monthEligibleStudents],
  );
  const debugStatus = useMemo(() => getSheetsDebugStatus(), [debugTick, loadError, isLoading]);
  const reminderGroups = useMemo(
    () =>
      groupPendingDuesByStudent(localStudents, localMonthlyFees).filter(
        (student) => student.status === "Active",
      ),
    [localStudents, localMonthlyFees],
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

  function openPaymentForStudent(studentId) {
    setPaymentStudentId(studentId);
    setActiveScreen("payment");
  }

  function openStudentDetails(studentId) {
    setSelectedStudentId(studentId);
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
        </header>

        <ScreenNav activeScreen={activeScreen} onChange={setActiveScreen} />

        {isLoading && <div className="info-card">Loading data from Google Sheets...</div>}
        {!isLoading && loadError && <div className="info-card muted">{loadError}</div>}
        {debugEnabled && <DebugPanel debugStatus={debugStatus} loadError={loadError} />}

        {activeScreen === "dashboard" && (
          <Dashboard
            monthKey={monthKey}
            monthChoices={monthChoices}
            onMonthChange={setMonthKey}
            summary={summary}
            totalAmount={totalAmount}
            formatter={formatter}
            appSettings={appSettings}
            studentsWithStatus={monthEligibleStudents}
            reminderMetaByStudentId={reminderMetaByStudentId}
            onQuickAddPayment={openPaymentForStudent}
            onOpenStudentDetails={openStudentDetails}
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
          />
        )}
        {activeScreen === "payment" && (
          <PaymentScreen
            formatter={formatter}
            students={localStudents}
            availableMonths={monthChoices}
            appSettings={appSettings}
            onAddPaymentRow={addPaymentRow}
            isSavingPayment={isSavingPayment}
            initialStudentId={paymentStudentId}
            selectedMonthKey={monthKey}
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
          formatter={formatter}
          onSave={saveStudentProfile}
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
