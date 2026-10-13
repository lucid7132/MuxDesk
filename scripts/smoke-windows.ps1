param([string]$LogDirectory = '')
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$exe = (Resolve-Path (Join-Path $root "release/cmux-v$version.exe")).Path
# The NSIS portable launcher extracts Electron to TEMP. Sandboxed Windows child
# processes cannot reliably launch from an SMB drive, including a mapped drive.
$localTemp = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) "Temp/cmux-smoke-$([guid]::NewGuid().ToString('N'))"
$localTemp = [IO.Path]::GetFullPath($localTemp)
$profile = Join-Path $localTemp 'profile'
$previous = @{}
foreach ($name in @('CMUX_PRIVATE_DIR', 'ELECTRON_RUN_AS_NODE', 'TEMP', 'TMP')) {
  $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
if (-not $LogDirectory) { $LogDirectory = Join-Path $root ".env/gui-logs-$([guid]::NewGuid().ToString('N'))" }
New-Item -ItemType Directory -Force $LogDirectory | Out-Null
$app = $null
$browser = $null
try {
  New-Item -ItemType Directory -Force $profile | Out-Null
  $env:CMUX_PRIVATE_DIR = $profile
  $env:TEMP = $localTemp
  $env:TMP = $localTemp
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  $app = Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe) -PassThru `
    -RedirectStandardOutput (Join-Path $LogDirectory 'app.stdout.log') `
    -RedirectStandardError (Join-Path $LogDirectory 'app.stderr.log')
  # Retain the process handle so .NET can retrieve ExitCode after termination.
  $null = $app.Handle
  $ready = $false
  for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Milliseconds 500
    $app.Refresh()
    if ($app.HasExited) {
      $app.WaitForExit()
      throw "Portable application exited during startup (exit $($app.ExitCode)). See app.stderr.log and application.jsonl."
    }
    # The portable EXE is a launcher waiting for its Electron child, not the GUI.
    if ($null -eq $browser) {
      $child = Get-CimInstance Win32_Process -Filter "ParentProcessId = $($app.Id)" |
        Where-Object { $_.Name -eq 'cmux.exe' -and $_.ExecutablePath -and
          $_.ExecutablePath.StartsWith($localTemp + '\', [StringComparison]::OrdinalIgnoreCase) } |
        Select-Object -First 1
      if ($child) {
        $browser = Get-Process -Id $child.ProcessId
        $null = $browser.Handle
        Write-Output 'Portable Electron runtime extracted to a Windows local temporary directory.'
      }
    }
    if ($null -ne $browser) {
      $browser.Refresh()
      if ($browser.HasExited) {
        $browser.WaitForExit()
        throw "Electron exited during startup (exit $($browser.ExitCode)). See application.jsonl and app.stderr.log."
      }
      if ($browser.MainWindowHandle -ne 0 -and (Test-Path (Join-Path $profile 'profile.json'))) {
        $ready = $true
        break
      }
    }
  }
  if (-not $ready) { throw 'Portable application window or renderer did not finish startup within 60 seconds.' }
  $saved = Get-Content (Join-Path $profile 'profile.json') -Raw | ConvertFrom-Json
  if ($saved.workspaces.Count -ne 1 -or $saved.ssh.connections.Count -ne 0 -or $saved.commands.items.Count -ne 0) {
    throw 'Fresh startup did not produce a clean user profile.'
  }
  Write-Output 'Portable EXE window and renderer started with a clean private profile.'
} finally {
  if (Test-Path (Join-Path $profile 'logs/application.jsonl')) {
    Copy-Item (Join-Path $profile 'logs/application.jsonl') (Join-Path $LogDirectory 'application.jsonl') -Force
  }
  if ($null -ne $app) {
    $processes = Get-CimInstance Win32_Process
    $parents = @($app.Id)
    if ($null -ne $browser) { $parents += $browser.Id }
    $owned = @()
    if ($null -ne $browser) { $owned += $browser.Id }
    while ($parents.Count -gt 0) {
      $children = @($processes | Where-Object { $parents -contains $_.ParentProcessId } | ForEach-Object { $_.ProcessId })
      $children = @($children | Where-Object { $owned -notcontains $_ })
      $owned += $children
      $parents = $children
    }
    foreach ($childId in $owned) { Stop-Process -Id $childId -Force -ErrorAction SilentlyContinue }
    # Let NSIS clean its extraction directory before stopping the wrapper.
    if (-not $app.WaitForExit(5000)) { Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue }
  }
  foreach ($name in $previous.Keys) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
  Remove-Item $localTemp -Recurse -Force -ErrorAction Continue
}
