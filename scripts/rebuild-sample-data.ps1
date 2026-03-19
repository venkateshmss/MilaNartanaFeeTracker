param(
  [string]$MonthlyFeesPath = "sample-data/MonthlyFees.sample.csv",
  [string]$SettingsPath = "sample-data/Settings.sample.csv",
  [string]$StudentsOutPath = "sample-data/Students.sample.csv",
  [string]$ParentDetailsPath = "c:\Users\VenkateshSooryakala\Downloads\Parent_details.csv",
  [string]$MockDataOutPath = "src/data/mockData.js"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Normalize-Name {
  param([string]$Value)
  if (-not $Value) { return "" }
  $raw = $Value.Trim().ToLowerInvariant()
  $raw = [regex]::Replace($raw, "[^a-z0-9 ]", " ")
  $raw = [regex]::Replace($raw, "\s+", " ").Trim()
  return $raw
}

function Get-NameTokens {
  param([string]$Value)
  return (Normalize-Name $Value).Split(" ", [System.StringSplitOptions]::RemoveEmptyEntries)
}

function Get-EditDistance {
  param(
    [string]$A,
    [string]$B
  )
  $s = [string]$A
  $t = [string]$B
  $n = $s.Length
  $m = $t.Length
  if ($n -eq 0) { return $m }
  if ($m -eq 0) { return $n }

  $d = New-Object 'int[,]' ($n + 1), ($m + 1)
  for ($i = 0; $i -le $n; $i++) { $d[$i, 0] = $i }
  for ($j = 0; $j -le $m; $j++) { $d[0, $j] = $j }

  for ($i = 1; $i -le $n; $i++) {
    for ($j = 1; $j -le $m; $j++) {
      $im1 = $i - 1
      $jm1 = $j - 1
      $cost = if ($s[$i - 1] -eq $t[$j - 1]) { 0 } else { 1 }
      $deletion = $d[$im1, $j] + 1
      $insertion = $d[$i, $jm1] + 1
      $substitution = $d[$im1, $jm1] + $cost
      $d[$i, $j] = [Math]::Min([Math]::Min($deletion, $insertion), $substitution)
    }
  }
  return $d[$n, $m]
}

function Normalize-Phone {
  param([string]$Value)
  if (-not $Value) { return "" }
  return ([regex]::Replace($Value, "[^0-9]", "")).Trim()
}

function Try-ExtractCity {
  param([string]$Address)
  if (-not $Address) { return "" }

  $normalized = $Address -replace "`r|`n", ", "
  if ($normalized -match "(?i)\b(Sunnyvale|San Jose|Fremont|Dublin|Santa Clara|Cupertino|Milpitas|Mountain View|Palo Alto)\b") {
    $city = $matches[1].Trim()
    $ti = (Get-Culture).TextInfo
    return $ti.ToTitleCase($city.ToLowerInvariant())
  }

  $parts = $normalized.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ }
  foreach ($part in $parts) {
    if ($part -match "^[A-Za-z ]+$" -and $part.Length -ge 3) {
      $ti = (Get-Culture).TextInfo
      return $ti.ToTitleCase($part.ToLowerInvariant())
    }
  }

  return ""
}

function To-MonthKey {
  param([string]$Value)
  $raw = [string]$Value
  if ($raw -match "^\d{4}-\d{2}$") { return $raw }
  try {
    $dt = [datetime]::Parse($raw)
    return $dt.ToString("yyyy-MM")
  } catch {
    return ""
  }
}

function To-MonthLabel {
  param([string]$MonthKey)
  if (-not $MonthKey) { return "" }
  try {
    return ([datetime]::ParseExact("$MonthKey-01", "yyyy-MM-dd", $null)).ToString("MMM yyyy")
  } catch {
    return $MonthKey
  }
}

function Find-ParentRecord {
  param(
    [pscustomobject]$Student,
    [System.Collections.Generic.List[object]]$ParentRows
  )

  $studentNorm = Normalize-Name $Student.student_name
  if (-not $studentNorm) { return $null }
  $studentFirstToken = (Get-NameTokens $Student.student_name | Select-Object -First 1)

  $exact = @($ParentRows | Where-Object { (Normalize-Name $_."Student Name (Full Name)") -eq $studentNorm })
  if ($exact.Count -eq 1) { return $exact[0] }

  $contains = @($ParentRows | Where-Object {
    $pNorm = Normalize-Name $_."Student Name (Full Name)"
    $pNorm -like "*$studentNorm*" -or $studentNorm -like "*$pNorm*"
  })
  if ($contains.Count -eq 1) { return $contains[0] }

  if ($studentFirstToken) {
    $tokenMatch = @($ParentRows | Where-Object {
      $tokens = @(Get-NameTokens $_."Student Name (Full Name)")
      $tokens.Length -gt 0 -and $tokens[0] -eq $studentFirstToken
    })
    if ($tokenMatch.Count -eq 1) { return $tokenMatch[0] }

    $fuzzyTokenMatches = @()
    foreach ($row in $ParentRows) {
      $tokens = @(Get-NameTokens $row."Student Name (Full Name)")
      if ($tokens.Length -eq 0) { continue }
      $distance = Get-EditDistance $studentFirstToken $tokens[0]
      if ($distance -le 2) {
        $fuzzyTokenMatches += [pscustomobject]@{
          row = $row
          distance = $distance
        }
      }
    }

    if ($fuzzyTokenMatches.Count -gt 0) {
      $bestDistance = ($fuzzyTokenMatches | Measure-Object -Property distance -Minimum).Minimum
      $best = @($fuzzyTokenMatches | Where-Object { $_.distance -eq $bestDistance })
      if ($best.Count -eq 1) { return $best[0].row }
    }
  }

  return $null
}

if (-not (Test-Path $MonthlyFeesPath)) {
  throw "Monthly fees CSV not found: $MonthlyFeesPath"
}

$monthlyFees = Import-Csv -Path $MonthlyFeesPath
if (-not $monthlyFees -or $monthlyFees.Count -eq 0) {
  throw "Monthly fees CSV has no rows: $MonthlyFeesPath"
}

$settingsRows = @()
if (Test-Path $SettingsPath) {
  $settingsRows = Import-Csv -Path $SettingsPath
}

$parentRows = New-Object 'System.Collections.Generic.List[object]'
if (Test-Path $ParentDetailsPath) {
  foreach ($row in (Import-Csv -Path $ParentDetailsPath)) {
    $parentRows.Add($row)
  }
}

$studentsById = @{}
foreach ($fee in $monthlyFees) {
  $id = [string]$fee.student_id
  if (-not $id) { continue }

  $monthKey = To-MonthKey $fee.month_key
  $feeAmount = 0
  [void][double]::TryParse([string]$fee.fee_amount, [ref]$feeAmount)

  if (-not $studentsById.ContainsKey($id)) {
    $studentsById[$id] = [ordered]@{
      student_id = $id
      student_name = ([string]$fee.student_name).Trim()
      parent_name = ""
      email = ""
      whatsapp_number = ""
      alternate_phone = ""
      address = ""
      location = ""
      monthly_fee = [int]$feeAmount
      join_month = $monthKey
      status = "Active"
      notes = ""
    }
    continue
  }

  $student = $studentsById[$id]
  if (-not $student.student_name -and $fee.student_name) {
    $student.student_name = ([string]$fee.student_name).Trim()
  }
  if ($feeAmount -gt [double]$student.monthly_fee) {
    $student.monthly_fee = [int]$feeAmount
  }
  if ($monthKey) {
    if (-not $student.join_month -or $monthKey -lt $student.join_month) {
      $student.join_month = $monthKey
    }
  }
}

$students = $studentsById.Values | ForEach-Object { [pscustomobject]$_ } | Sort-Object student_id

$matchCount = 0
foreach ($student in $students) {
  $match = Find-ParentRecord -Student $student -ParentRows $parentRows
  if (-not $match) { continue }

  $student.parent_name = ([string]$match."Parent(s) Name (Full name)").Trim()
  $student.email = ([string]$match.Email).Trim()
  $student.whatsapp_number = Normalize-Phone ([string]$match."Phone number")
  $student.address = ([string]$match.Address).Trim()
  $city = Try-ExtractCity $student.address
  if ($city) { $student.location = $city }
  $matchCount += 1
}

$students | Export-Csv -Path $StudentsOutPath -NoTypeInformation -Encoding UTF8

$settings = @{}
foreach ($row in $settingsRows) {
  $settings[[string]$row.setting_key] = $row.setting_value
}
if (-not $settings.ContainsKey("class_name")) { $settings["class_name"] = "Mila Nartana" }
if (-not $settings.ContainsKey("default_monthly_fee")) { $settings["default_monthly_fee"] = "80" }
if (-not $settings.ContainsKey("reminder_day")) { $settings["reminder_day"] = "5" }
if (-not $settings.ContainsKey("currency")) { $settings["currency"] = "USD" }
if (-not $settings.ContainsKey("whatsapp_message_template")) {
  $settings["whatsapp_message_template"] = "Hi, this is a gentle reminder from Mila Nartana. Fee pending for {{student_name}}: {{due_breakdown}}. Total due: {{total_due}}. Thank you."
}

$studentsForJs = $students | ForEach-Object {
  [pscustomobject][ordered]@{
    student_id = $_.student_id
    student_name = $_.student_name
    parent_name = $_.parent_name
    email = $_.email
    whatsapp_number = $_.whatsapp_number
    alternate_phone = $_.alternate_phone
    address = $_.address
    location = $_.location
    monthly_fee = [int]($_.monthly_fee)
    join_month = $_.join_month
    status = $_.status
    notes = $_.notes
  }
}

$monthlyForJs = $monthlyFees | ForEach-Object {
  $feeAmount = 0
  $paid = 0
  $due = 0
  [void][double]::TryParse([string]$_.fee_amount, [ref]$feeAmount)
  [void][double]::TryParse([string]$_.amount_paid, [ref]$paid)
  [void][double]::TryParse([string]$_.balance_due, [ref]$due)
  $mk = To-MonthKey ([string]$_.month_key)
  [pscustomobject][ordered]@{
    fee_row_id = $_.fee_row_id
    student_id = $_.student_id
    student_name = $_.student_name
    month_key = $mk
    month_label = if ($_.month_label) { $_.month_label } else { To-MonthLabel $mk }
    fee_amount = [int]$feeAmount
    amount_paid = [int]$paid
    balance_due = [int]$due
    status = $_.status
    payment_date = $_.payment_date
    payment_mode = $_.payment_mode
    payment_ref = $_.payment_ref
    reminder_sent = ([string]$_.reminder_sent).ToLowerInvariant() -eq "true"
    reminder_sent_date = $_.reminder_sent_date
    notes = $_.notes
  }
}

$monthOptions = $monthlyForJs |
  Select-Object -ExpandProperty month_key |
  Where-Object { $_ } |
  Sort-Object -Unique |
  ForEach-Object {
    [pscustomobject][ordered]@{
      key = $_
      label = To-MonthLabel $_
    }
  }

$mockJs = @()
$mockJs += "export const settings = " + ($settings | ConvertTo-Json -Depth 6) + ";"
$mockJs += "// These objects mirror the future Google Sheets Students sheet columns."
$mockJs += "export const students = " + ($studentsForJs | ConvertTo-Json -Depth 6) + ";"
$mockJs += "// These rows mirror the future Google Sheets MonthlyFees sheet design."
$mockJs += "export const monthlyFees = " + ($monthlyForJs | ConvertTo-Json -Depth 8) + ";"
$mockJs += "export const monthOptions = " + ($monthOptions | ConvertTo-Json -Depth 6) + ";"
$mockJs += @"
export const paymentFormDefaults = {
  student_id: students[0]?.student_id || "",
  month_key: monthOptions[monthOptions.length - 1]?.key || "",
  payment_mode: "Online",
  transfer_date: new Date().toISOString().slice(0, 10),
  fee_override: "",
  amount_received: "",
};
"@

Set-Content -Path $MockDataOutPath -Value ($mockJs -join "`r`n") -Encoding UTF8

Write-Host "Students written: $($students.Count)"
Write-Host "Parent matches: $matchCount / $($students.Count)"
Write-Host "Monthly fee rows: $($monthlyForJs.Count)"
Write-Host "Mock data regenerated: $MockDataOutPath"
