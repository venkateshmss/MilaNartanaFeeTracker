const STUDENTS_SHEET = "Students";
const MONTHLY_FEES_SHEET = "MonthlyFees";
const SETTINGS_SHEET = "Settings";
const ADMIN_TOKEN_PROPERTY_KEY = "APP_ADMIN_TOKEN";
const READ_ACTIONS = ["health", "fetchAll"];
const WRITE_ACTIONS = [
  "updateStudentStatus",
  "addMonthlyFeeRow",
  "addStudentRow",
  "updateStudentRow",
];
const REQUIRED_STUDENT_COLUMNS = [
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
const REQUIRED_MONTHLY_FEE_COLUMNS = [
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
const REQUIRED_SETTINGS_COLUMNS = ["setting_key", "setting_value"];

function doGet(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) || "health";
    if (!READ_ACTIONS.includes(action)) {
      return json_({ ok: false, error: "Unknown action" });
    }
    const token = String((e && e.parameter && e.parameter.token) || "").trim();
    if (requiresToken_(action)) {
      assertAuthorizedRequest_(token);
    }
    if (action === "health") return json_({ ok: true, data: { status: "up" } });
    if (action === "fetchAll") return json_({ ok: true, data: fetchAll_() });
  } catch (error) {
    return json_({ ok: false, error: String(error) });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    const action = body.action;
    const payload = body.payload || {};
    const token = String(body.token || payload.token || "").trim();

    assertKnownAction_(action);
    if (requiresToken_(action)) {
      assertAuthorizedRequest_(token);
    }
    validatePayload_(action, payload);

    let data;
    if (action === "fetchAll") data = fetchAll_();
    if (action === "updateStudentStatus") data = updateStudentStatus_(payload.studentId, payload.status);
    if (action === "addMonthlyFeeRow") data = addMonthlyFeeRow_(payload.feeRow);
    if (action === "addStudentRow") data = addStudentRow_(payload.studentRow);
    if (action === "updateStudentRow") data = updateStudentRow_(payload.studentRow);

    if (!data) {
      return json_({ ok: false, error: "Unknown action" });
    }

    return json_({ ok: true, data });
  } catch (error) {
    return json_({ ok: false, error: String(error) });
  }
}

function fetchAll_() {
  assertSheetSchema_();
  return {
    students: readRows_(STUDENTS_SHEET),
    monthlyFees: readRows_(MONTHLY_FEES_SHEET),
    settings: rowsToSettings_(readRows_(SETTINGS_SHEET)),
  };
}

function updateStudentStatus_(studentId, status) {
  assertSheetSchema_();
  const sheet = SpreadsheetApp.getActive().getSheetByName(STUDENTS_SHEET);
  const rows = sheet.getDataRange().getValues();
  const headers = rows[0] || [];
  const idCol = findColumnIndex_(headers, "student_id");
  const statusCol = findColumnIndex_(headers, "status");

  for (let r = 1; r < rows.length; r += 1) {
    if (String(rows[r][idCol]).trim() === String(studentId).trim()) {
      sheet.getRange(r + 1, statusCol + 1).setValue(status);
      return { studentId, status };
    }
  }

  throw new Error("student_id not found");
}

function addMonthlyFeeRow_(feeRow) {
  assertSheetSchema_();
  const sheet = SpreadsheetApp.getActive().getSheetByName(MONTHLY_FEES_SHEET);
  appendRowByHeaders_(sheet, feeRow || {});
  return { appended: true };
}

function addStudentRow_(studentRow) {
  assertSheetSchema_();
  const sheet = SpreadsheetApp.getActive().getSheetByName(STUDENTS_SHEET);
  appendRowByHeaders_(sheet, studentRow || {});
  return { appended: true };
}

function updateStudentRow_(studentRow) {
  assertSheetSchema_();
  const rowData = studentRow || {};
  const studentId = String(rowData.student_id || "").trim();
  if (!studentId) throw new Error("student_id is required");

  const sheet = SpreadsheetApp.getActive().getSheetByName(STUDENTS_SHEET);
  const rows = sheet.getDataRange().getValues();
  const headers = rows[0] || [];
  const idCol = findColumnIndex_(headers, "student_id");

  for (let r = 1; r < rows.length; r += 1) {
    if (String(rows[r][idCol]).trim() === studentId) {
      headers.forEach((header, idx) => {
        if (rowData[header] !== undefined) {
          sheet.getRange(r + 1, idx + 1).setValue(rowData[header]);
        }
      });
      return { updated: true, student_id: studentId };
    }
  }

  throw new Error("student_id not found");
}

function readRows_(sheetName) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(sheetName);
  if (!sheet) throw new Error(`Missing sheet: ${sheetName}`);
  const values = sheet.getDataRange().getValues();
  if (!values.length) return [];
  const headers = values[0];
  return values.slice(1).map((row) => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = row[i];
    });
    return obj;
  });
}

function rowsToSettings_(rows) {
  return rows.reduce((acc, row) => {
    acc[row.setting_key] = row.setting_value;
    return acc;
  }, {});
}

function assertSheetSchema_() {
  assertRequiredColumns_(STUDENTS_SHEET, REQUIRED_STUDENT_COLUMNS);
  assertRequiredColumns_(MONTHLY_FEES_SHEET, REQUIRED_MONTHLY_FEE_COLUMNS);
  assertRequiredColumns_(SETTINGS_SHEET, REQUIRED_SETTINGS_COLUMNS);
}

function assertRequiredColumns_(sheetName, requiredColumns) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(sheetName);
  if (!sheet) throw new Error(`Missing sheet: ${sheetName}`);
  const headers = getHeaders_(sheet);

  const missing = requiredColumns.filter((col) => headers.indexOf(col) === -1);
  if (missing.length) {
    throw new Error(
      `Sheet "${sheetName}" is missing required columns: ${missing.join(", ")}`,
    );
  }
}

function getHeaders_(sheet) {
  if (sheet.getLastRow() < 1 || sheet.getLastColumn() < 1) {
    return [];
  }
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
}

function findColumnIndex_(headers, columnName) {
  const index = headers.indexOf(columnName);
  if (index === -1) throw new Error(`Missing required column: ${columnName}`);
  return index;
}

function appendRowByHeaders_(sheet, sourceObj) {
  const headers = getHeaders_(sheet);
  if (!headers.length) throw new Error(`Sheet "${sheet.getName()}" has no header row`);
  const row = headers.map((h) => (sourceObj[h] !== undefined ? sourceObj[h] : ""));
  sheet.appendRow(row);
}

function assertKnownAction_(action) {
  const all = READ_ACTIONS.concat(WRITE_ACTIONS);
  if (!all.includes(action)) throw new Error("Unknown action");
}

function isWriteAction_(action) {
  return WRITE_ACTIONS.includes(action);
}

function requiresToken_(action) {
  // Keep health open for quick monitoring.
  return action !== "health";
}

function getConfiguredAdminToken_() {
  return String(PropertiesService.getScriptProperties().getProperty(ADMIN_TOKEN_PROPERTY_KEY) || "").trim();
}

function assertAuthorizedRequest_(providedToken) {
  const configuredToken = getConfiguredAdminToken_();
  // Token check is enforced only when token is configured in Script Properties.
  if (!configuredToken) return;
  if (providedToken !== configuredToken) {
    throw new Error("Unauthorized request");
  }
}

function validatePayload_(action, payload) {
  if (action === "updateStudentStatus") {
    if (!payload || !payload.studentId) throw new Error("studentId is required");
    const status = String(payload.status || "").trim();
    if (!["Active", "Inactive"].includes(status)) {
      throw new Error("Invalid status. Expected Active or Inactive.");
    }
  }

  if (action === "addStudentRow" || action === "updateStudentRow") {
    const row = payload && payload.studentRow;
    if (!row || !row.student_id || !row.student_name) {
      throw new Error("studentRow with student_id and student_name is required");
    }
  }

  if (action === "addMonthlyFeeRow") {
    const row = payload && payload.feeRow;
    if (!row || !row.student_id || !row.month_key) {
      throw new Error("feeRow with student_id and month_key is required");
    }
  }
}

function json_(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(
    ContentService.MimeType.JSON,
  );
}
