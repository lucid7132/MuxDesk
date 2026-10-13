$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'run-log.ps1')
$run = Start-RunLog $root 'logging-test'
try {
  $code = Invoke-LoggedCommand $run 'Capture both native streams and exit code' 'powershell.exe' @(
    '-NoProfile', '-Command', "[Console]::Out.WriteLine('stdout-marker'); [Console]::Error.WriteLine('stderr-marker'); exit 7") @(7)
  if ($code -ne 7) { throw 'Logging self-test: native exit code was not captured.' }
  $stdout = Get-Content (Join-Path $run.Directory '01.stdout.log') -Raw
  $stderr = Get-Content (Join-Path $run.Directory '01.stderr.log') -Raw
  if ($stdout -notmatch 'stdout-marker' -or $stderr -notmatch 'stderr-marker') { throw 'Logging self-test: an output stream was lost.' }
  $rejected = $false
  try {
    $null = Invoke-LoggedCommand $run 'Reject a failed native command' 'powershell.exe' @('-NoProfile', '-Command', 'exit 9')
  } catch { $rejected = $true }
  if (-not $rejected) { throw 'Logging self-test: failure did not stop execution.' }
  $saved = Get-Content (Join-Path $run.Directory 'result.json') -Raw | ConvertFrom-Json
  if ($saved.steps[1].exitCode -ne 9 -or $saved.steps[1].status -ne 'failed') { throw 'Logging self-test: failed step was not saved.' }
  Complete-RunLog $run
  $saved = Get-Content (Join-Path $run.Directory 'result.json') -Raw | ConvertFrom-Json
  if ($saved.status -ne 'passed' -or -not $saved.finishedAt) { throw 'Logging self-test: final result was not saved.' }
  Write-Host 'Logging self-test passed: stdout, stderr, exit code, failure and final status.'
} catch {
  Complete-RunLog $run $_
  throw
}
