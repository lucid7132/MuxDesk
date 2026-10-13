# Shared logging for Windows release validation.
function Save-RunLog($Context) {
  $json = $Context.State | ConvertTo-Json -Depth 20
  $encoding = New-Object System.Text.UTF8Encoding($false)
  foreach ($file in @((Join-Path $Context.Directory 'result.json'), (Join-Path $Context.Root ".env/latest-$($Context.Kind).json"))) {
    [IO.File]::WriteAllText("$file.$($Context.State.id).tmp", $json, $encoding)
    Move-Item -LiteralPath "$file.$($Context.State.id).tmp" -Destination $file -Force
  }
}

function Start-RunLog([string]$Root, [string]$Kind) {
  $id = "$(Get-Date -Format 'yyyyMMdd-HHmmss-fff')-$Kind-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
  $directory = Join-Path $Root ".env/run-logs/$id"
  New-Item -ItemType Directory -Force $directory | Out-Null
  $previousEncoding = [Console]::OutputEncoding
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $context = [pscustomobject]@{ PreviousConsoleEncoding = $previousEncoding; Root = $Root; Directory = $directory; Kind = $Kind; State = [ordered]@{
    id = $id; kind = $Kind; status = 'running'; startedAt = [DateTime]::UtcNow.ToString('o');
    finishedAt = $null; error = $null; logDirectory = ".env/run-logs/$id";
    steps = New-Object System.Collections.ArrayList
  } }
  Save-RunLog $context
  Write-Host "Execution log: .env/run-logs/$id"
  return $context
}

function Write-RunMessage($Context, [string]$Message) {
  Add-Content -LiteralPath (Join-Path $Context.Directory 'output.log') -Value $Message -Encoding utf8 -ErrorAction Stop
  Write-Host $Message
}

function Invoke-LoggedCommand($Context, [string]$Step, [string]$File, [string[]]$Arguments = @(),
  [int[]]$AllowedExitCodes = @(0), [string]$StdoutPath = '') {
  $number = $Context.State.steps.Count + 1
  $basename = '{0:D2}' -f $number
  $stdout = Join-Path $Context.Directory "$basename.stdout.log"
  $stderr = Join-Path $Context.Directory "$basename.stderr.log"
  $entry = [ordered]@{ name = $Step; command = $File; arguments = $Arguments; status = 'running';
    startedAt = [DateTime]::UtcNow.ToString('o'); finishedAt = $null; exitCode = $null;
    stdout = "$basename.stdout.log"; stderr = "$basename.stderr.log" }
  [void]$Context.State.steps.Add($entry)
  Save-RunLog $Context
  Write-RunMessage $Context "[$Step] $File $($Arguments -join ' ')"
  if ($StdoutPath) { [IO.File]::WriteAllText($StdoutPath, '') }
  $oldPreference = $ErrorActionPreference
  $exitCode = -1
  try {
    Get-Command $File -ErrorAction Stop | Out-Null
    # Windows PowerShell treats native stderr as ErrorRecords. Capture it without aborting the process.
    $ErrorActionPreference = 'Continue'
    $global:LASTEXITCODE = 0
    & $File @Arguments 2> $stderr | ForEach-Object {
      $line = $_.ToString()
      Add-Content -LiteralPath $stdout -Value $line -Encoding utf8 -ErrorAction Stop
      if ($StdoutPath) { Add-Content -LiteralPath $StdoutPath -Value $line -Encoding utf8 -ErrorAction Stop }
      Write-RunMessage $Context $line
    }
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $oldPreference
    if (Test-Path -LiteralPath $stderr) {
      $errorText = Get-Content -LiteralPath $stderr -Raw
      if ($null -eq $errorText) { $errorText = '' }
      [IO.File]::WriteAllText($stderr, $errorText, (New-Object System.Text.UTF8Encoding($false)))
      foreach ($line in $errorText -split "`r?`n") { if ($line) { Write-RunMessage $Context "[stderr] $line" } }
    }
    $entry.exitCode = $exitCode
    $entry.finishedAt = [DateTime]::UtcNow.ToString('o')
    $entry.status = if ($AllowedExitCodes -contains $exitCode) { 'passed' } else { 'failed' }
    Save-RunLog $Context
  }
  if ($AllowedExitCodes -notcontains $exitCode) { throw "$Step failed (exit $exitCode). See saved logs." }
  return $exitCode
}

function Complete-RunLog($Context, $Failure = $null) {
  $Context.State.finishedAt = [DateTime]::UtcNow.ToString('o')
  if ($null -ne $Failure) {
    $Context.State.status = 'failed'
    $Context.State.error = $Failure.ToString()
    $Failure | Format-List * -Force | Out-String |
      Set-Content -LiteralPath (Join-Path $Context.Directory 'error.log') -Encoding utf8
    Write-RunMessage $Context "FAILED: $Failure"
  } else {
    $Context.State.status = 'passed'
    Write-RunMessage $Context 'PASSED'
  }
  Save-RunLog $Context
  if ($Context.PreviousConsoleEncoding) { [Console]::OutputEncoding = $Context.PreviousConsoleEncoding }
}
