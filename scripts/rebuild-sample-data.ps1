param(
  [string]$MonthlyFeesPath = "data/samples/MonthlyFees.sample.csv",
  [string]$SettingsPath = "data/samples/Settings.sample.csv",
  [string]$StudentsOutPath = "data/samples/Students.sample.csv",
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

$payload = [pscustomobject]@{
  students = $students
  monthlyFees = $monthlyFees
  settings = $settings
}
$payloadPath = Join-Path $env:TEMP ("mnft-samples-" + [guid]::NewGuid().ToString() + ".json")
$payload | ConvertTo-Json -Depth 20 | Set-Content -Path $payloadPath -Encoding UTF8

try {
  & node "scripts/write-samples-from-json.mjs" `
    --input $payloadPath `
    --students-out $StudentsOutPath `
    --monthly-fees-out $MonthlyFeesPath `
    --settings-out $SettingsPath `
    --mock-data-out $MockDataOutPath
} finally {
  if (Test-Path $payloadPath) {
    Remove-Item $payloadPath -Force
  }
}

Write-Host "Students written: $($students.Count)"
Write-Host "Parent matches: $matchCount / $($students.Count)"
Write-Host "Monthly fee rows: $($monthlyFees.Count)"
Write-Host "Mock data regenerated: $MockDataOutPath"
