param(
  [string]$DbUrl = $env:SUPABASE_DB_URL,
  [switch]$Apply,
  [switch]$IncludeDangerous,
  [switch]$SkipCron
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$migrationsDir = Join-Path $root "supabase/migrations"

if (-not (Test-Path -LiteralPath $migrationsDir)) {
  throw "Migrations directory not found: $migrationsDir"
}

$dangerous = @(
  "20260520183722_3a8b0cea-3223-48a9-b754-b90f33dc0e64.sql", # TRUNCATE core CRM tables
  "20260529214149_44774b9d-5e78-4867-a1d5-6ad7018e8e14.sql", # pg_cron to old Lovable URL with old apikey
  "20260605204024_ddfcba0b-023e-4413-928d-60f13c516b63.sql", # DROP chat tables
  "20260610013916_8d53a675-14a9-4ac1-9107-c88aede4e865.sql", # DROP import table
  "20260613193101_9b0af99f-e9bf-46bb-b9b9-1a74d3ca5d97.sql", # realtime DROP TABLE publication entry
  "20260623040359_90c3e218-a799-4902-8163-2df33c8f85ab.sql"  # DROP temp map table
)

$files = Get-ChildItem -LiteralPath $migrationsDir -Filter "*.sql" | Sort-Object Name

if (-not $IncludeDangerous) {
  $files = $files | Where-Object { $dangerous -notcontains $_.Name }
}

if ($SkipCron) {
  $files = $files | Where-Object {
    $text = Get-Content -LiteralPath $_.FullName -Raw
    $text -notmatch "cron\.schedule|pg_cron|pg_net|net\.http"
  }
}

Write-Host "Migrations selected: $($files.Count)"
Write-Host "Dangerous included: $([bool]$IncludeDangerous)"
Write-Host "Cron skipped: $([bool]$SkipCron)"

if (-not $Apply) {
  Write-Host ""
  Write-Host "Dry run. Files that would be applied:"
  $files | ForEach-Object { Write-Host " - $($_.Name)" }
  Write-Host ""
  Write-Host "Run with -Apply and SUPABASE_DB_URL set to execute."
  exit 0
}

if (-not $DbUrl) {
  throw "DbUrl missing. Set SUPABASE_DB_URL to the Supabase Postgres connection string."
}

$psql = Get-Command psql -ErrorAction SilentlyContinue
if (-not $psql) {
  throw "psql not found. Install PostgreSQL client or run this from an environment that has psql."
}

foreach ($file in $files) {
  Write-Host "Applying $($file.Name)"
  & $psql.Source $DbUrl -v ON_ERROR_STOP=1 -f $file.FullName
  if ($LASTEXITCODE -ne 0) {
    throw "Migration failed: $($file.Name)"
  }
}

Write-Host "Migrations applied successfully."
