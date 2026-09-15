param(
  [int]$Port = 3000,
  [string]$HostName = "127.0.0.1"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

if (Test-Path -LiteralPath ".env") {
  Get-Content -LiteralPath ".env" | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) {
      return
    }

    $parts = $line -split "=", 2
    $name = $parts[0].Trim()
    $value = $parts[1].Trim()
    if ($value.Length -ge 2) {
      $first = $value.Substring(0, 1)
      $last = $value.Substring($value.Length - 1, 1)
      if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
        $value = $value.Substring(1, $value.Length - 2)
      }
    }

    if ($name) {
      [Environment]::SetEnvironmentVariable($name, $value, "Process")
    }
  }
}

$env:HOST = $HostName
$env:PORT = [string]$Port
if (-not $env:PUBLIC_APP_URL) {
  $env:PUBLIC_APP_URL = "http://localhost:$Port"
}
if (-not $env:VITE_PUBLIC_APP_URL) {
  $env:VITE_PUBLIC_APP_URL = "http://localhost:$Port"
}

node .output/server/index.mjs
