param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Args
)

$ErrorActionPreference = "Stop"

$previousNodeOptions = $env:NODE_OPTIONS
$dnsFlag = "--dns-result-order=ipv4first"

try {
  if ([string]::IsNullOrWhiteSpace($previousNodeOptions)) {
    $env:NODE_OPTIONS = $dnsFlag
  }
  elseif ($previousNodeOptions -notmatch [regex]::Escape($dnsFlag)) {
    $env:NODE_OPTIONS = "$previousNodeOptions $dnsFlag"
  }

  & npx -y clawhub @Args
  exit $LASTEXITCODE
}
finally {
  if ($null -eq $previousNodeOptions) {
    Remove-Item Env:\NODE_OPTIONS -ErrorAction SilentlyContinue
  }
  else {
    $env:NODE_OPTIONS = $previousNodeOptions
  }
}
