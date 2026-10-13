param([switch]$ResumeBuild)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'run-log.ps1')
$run = Start-RunLog $root 'release'
$variables = @('electron_config_cache', 'ELECTRON_BUILDER_CACHE', 'APP_BUILDER_TMP_DIR',
  'npm_package_config_node_gyp_devdir', 'TEMP', 'TMP', 'CMUX_TEST_EXECUTABLE', 'CMUX_TEST_DAEMON')
$previous = @{}
foreach ($name in $variables) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
Push-Location $root
try {
  if ($env:OS -ne 'Windows_NT') { throw 'Run release preparation on Windows x64.' }
  $temporary = Join-Path $root '.env/cache/tmp'
  New-Item -ItemType Directory -Force $temporary | Out-Null
  $env:electron_config_cache = Join-Path $root '.env/cache/electron'
  $env:ELECTRON_BUILDER_CACHE = Join-Path $root '.env/cache/electron-builder'
  $env:APP_BUILDER_TMP_DIR = $temporary
  $env:npm_package_config_node_gyp_devdir = Join-Path $root '.env/cache/node-gyp'
  $env:TEMP = $temporary
  $env:TMP = $temporary
  Remove-Item '.env/pre-release.json' -ErrorAction SilentlyContinue
  $null = Invoke-LoggedCommand $run 'Logging self-test' 'powershell.exe' @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'test-run-log.ps1'))
  if (-not $ResumeBuild) {
    $null = Invoke-LoggedCommand $run 'Dependency installation' 'npm.cmd' @('ci')
  } else {
    Write-RunMessage $run 'Resuming validation of the existing build; package source and dependency checks remain mandatory.'
  }
  $null = Invoke-LoggedCommand $run 'Source and private-file checks' 'npm.cmd' @('run', 'check:release')
  $null = Invoke-LoggedCommand $run 'Build downloader compatibility test' 'node.exe' @('scripts/check-build-tools.js')
  $null = Invoke-LoggedCommand $run 'Source tests' 'npm.cmd' @('test')
  $auditPath = Join-Path $run.Directory 'audit.json'
  $null = Invoke-LoggedCommand $run 'Dependency security audit' 'npm.cmd' @('audit', '--json', '--audit-level=low') @(0, 1) $auditPath
  $report = Get-Content -LiteralPath $auditPath -Raw | ConvertFrom-Json
  if ($report.metadata) { $run.State['audit'] = $report.metadata.vulnerabilities }
  if ($report.error -or -not $report.metadata -or $report.metadata.vulnerabilities.total -gt 0) {
    $run.State.steps[$run.State.steps.Count - 1].status = 'failed'
    throw 'Security audit did not pass. See the saved audit.json.'
  }
  if (-not $ResumeBuild) {
    $null = Invoke-LoggedCommand $run 'Portable EXE build' 'npm.cmd' @('run', 'build')
  }
  $null = Invoke-LoggedCommand $run 'Packaged source and native runtime checks' 'npm.cmd' @('run', 'check:package', '--', 'release/win-unpacked')
  $env:CMUX_TEST_EXECUTABLE = (Resolve-Path 'release/win-unpacked/cmux.exe').Path
  $env:CMUX_TEST_DAEMON = (Resolve-Path 'release/win-unpacked/resources/app.asar.unpacked/src/terminal-daemon.js').Path
  $null = Invoke-LoggedCommand $run 'Packaged ConPTY execution test' 'node.exe' @('--test', 'test/terminal-daemon.test.js')
  $null = Invoke-LoggedCommand $run 'Packaged GUI startup test' 'powershell.exe' @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'smoke-windows.ps1'),
    '-LogDirectory', $run.Directory)
  $version = (Get-Content package.json -Raw | ConvertFrom-Json).version
  $asset = (Resolve-Path "release/cmux-v$version.exe").Path
  $hash = (Get-FileHash -Algorithm SHA256 $asset).Hash.ToLowerInvariant()
  "$hash  $([IO.Path]::GetFileName($asset))" | Set-Content "$asset.sha256" -Encoding ascii
  @{ version = $version; checkedAt = [DateTime]::UtcNow.ToString('o');
    artifact = "release/cmux-v$version.exe"; sha256 = $hash; status = 'passed';
    runLog = $run.State.logDirectory } | ConvertTo-Json | Set-Content '.env/pre-release.json' -Encoding utf8
  Write-RunMessage $run "Release preparation passed: release/cmux-v$version.exe"
  Complete-RunLog $run
} catch {
  Complete-RunLog $run $_
  throw
} finally {
  Pop-Location
  foreach ($name in $variables) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
}
