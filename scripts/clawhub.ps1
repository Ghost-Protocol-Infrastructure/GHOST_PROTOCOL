param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Args
)

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$previousNodeOptions = $env:NODE_OPTIONS

Push-Location $repoRoot
try {
  if ($previousNodeOptions -and $previousNodeOptions -like '*clawhub-dns-override.cjs*') {
    $env:NODE_OPTIONS = $previousNodeOptions
  } elseif ([string]::IsNullOrWhiteSpace($previousNodeOptions)) {
    $env:NODE_OPTIONS = "--require=./scripts/clawhub-dns-override.cjs"
  } else {
    $env:NODE_OPTIONS = "$previousNodeOptions --require=./scripts/clawhub-dns-override.cjs"
  }

  & npx clawhub @Args
  $exitCode = $LASTEXITCODE
} finally {
  $env:NODE_OPTIONS = $previousNodeOptions
  Pop-Location
}

exit $exitCode
