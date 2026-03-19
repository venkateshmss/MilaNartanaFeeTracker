param(
  [int]$Bytes = 48
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($Bytes -lt 24) {
  throw "Use at least 24 bytes for a strong token."
}

$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$raw = New-Object byte[] $Bytes
$rng.GetBytes($raw)

$token = [Convert]::ToBase64String($raw).TrimEnd("=").Replace("+", "-").Replace("/", "_")

$sha = [System.Security.Cryptography.SHA256]::Create()
$tokenBytes = [System.Text.Encoding]::UTF8.GetBytes($token)
$hashBytes = $sha.ComputeHash($tokenBytes)
$fingerprint = ([BitConverter]::ToString($hashBytes)).Replace("-", "").ToLowerInvariant()

Write-Output "Token:"
Write-Output $token
Write-Output ""
Write-Output "Fingerprint (sha256):"
Write-Output $fingerprint
Write-Output ""
Write-Output "Add to React .env:"
Write-Output "VITE_SHEETS_WRITE_TOKEN=$token"
Write-Output ""
Write-Output "Add to Apps Script Project Settings > Script properties:"
Write-Output "APP_ADMIN_TOKEN=$token"
