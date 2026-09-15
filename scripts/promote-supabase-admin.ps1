param(
  [Parameter(Mandatory = $true)]
  [string]$Email,

  [string]$TenantSlug = "betleads-original",

  [string]$EnvPath = ".env",

  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Read-DotEnv {
  param([string]$Path)

  $vars = @{}
  Get-Content -LiteralPath $Path | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }

    $idx = $line.IndexOf("=")
    if ($idx -le 0) { return }

    $key = $line.Substring(0, $idx).Trim()
    $value = $line.Substring($idx + 1).Trim()

    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }

    $vars[$key] = $value
  }

  return $vars
}

function Sql-Literal {
  param([string]$Value)
  return "'" + $Value.Replace("'", "''") + "'"
}

if (-not (Test-Path -LiteralPath $EnvPath)) {
  throw "Env file not found: $EnvPath"
}

$vars = Read-DotEnv -Path $EnvPath
$dbUrl = $vars["SUPABASE_DB_URL"]

if (-not $dbUrl) {
  throw "SUPABASE_DB_URL not found in $EnvPath"
}

$emailSql = Sql-Literal -Value $Email
$tenantSlugSql = Sql-Literal -Value $TenantSlug

$sql = "WITH u AS (SELECT id FROM auth.users WHERE lower(email) = lower($emailSql) LIMIT 1), t AS (SELECT id FROM public.tenants WHERE slug = $tenantSlugSql LIMIT 1), global_role AS (INSERT INTO public.user_roles (user_id, role, tenant_id) SELECT u.id, 'super_admin'::public.app_role, NULL::uuid FROM u ON CONFLICT DO NOTHING RETURNING 1) INSERT INTO public.user_roles (user_id, role, tenant_id) SELECT u.id, 'owner'::public.app_role, t.id FROM u CROSS JOIN t ON CONFLICT DO NOTHING;"

if ($DryRun) {
  Write-Output $sql
  exit 0
}

$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$raw = & npx supabase db query --db-url $dbUrl --workdir . $sql 2>&1
$code = $LASTEXITCODE
$ErrorActionPreference = $previousErrorActionPreference
$text = $raw | Out-String
$text = $text.Replace($dbUrl, "[SUPABASE_DB_URL]")
$text = $text -replace "postgres(?:ql)?://[^\s]+", "[POSTGRES_URL]"
$text = $text -replace "password=[^\s]+", "password=[MASKED]"
Write-Output $text
exit $code
