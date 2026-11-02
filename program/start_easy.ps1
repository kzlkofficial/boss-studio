$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$RuntimeDir = Join-Path $Root '_python_runtime'
$Exe = Join-Path $RuntimeDir 'python.exe'
$Script = Join-Path $Root 'bridge_server.py'
try {
  if (-not (Test-Path $Exe)) {
    Write-Host 'Boss Studio: preparing the built-in runtime (first launch only)...' -ForegroundColor Cyan
    $Zip = Join-Path $env:TEMP 'bossstudio-python-3.12.10-embed-amd64.zip'
    # Official CPython embedded distribution, saved ONLY within Boss Studio folder.
    $Uri = 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    try {
      Invoke-WebRequest -Uri $Uri -OutFile $Zip -UseBasicParsing -TimeoutSec 120
      if ((Get-Item $Zip).Length -lt 1000000) { throw 'Download was incomplete' }
      New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null
      Expand-Archive -Path $Zip -DestinationPath $RuntimeDir -Force
      Remove-Item $Zip -Force -ErrorAction SilentlyContinue
      # Add application directory to the isolated embedded Python import paths.
      $Pth = Join-Path $RuntimeDir 'python312._pth'
      if (Test-Path $Pth) { Add-Content -Encoding Ascii -Path $Pth -Value '..' }
      Write-Host 'Runtime ready.' -ForegroundColor Green
    } catch {
      Write-Host 'Automatic download failed; trying installed Python...' -ForegroundColor Yellow
      $Py=Get-Command py -ErrorAction SilentlyContinue
      if ($Py) { & py -3 --version 2>$null; if ($LASTEXITCODE -eq 0) {$Exe='py';$UsePyLauncher=$true} }
      if (-not $UsePyLauncher) {
        $PythonCmd=Get-Command python -ErrorAction SilentlyContinue
        if ($PythonCmd) { & python --version 2>$null; if ($LASTEXITCODE -eq 0) {$Exe='python'} }
      }
      if (-not $UsePyLauncher -and $Exe -ne 'python') { throw 'Python unavailable. Download it from python.org and try again.' }
    }
  }
  Write-Host 'Opening Boss Studio in your browser...' -ForegroundColor Cyan
  Write-Host 'Keep this black window open during the stream.' -ForegroundColor Yellow
  if ($UsePyLauncher) { & py -3 $Script } else { & $Exe $Script }
  if ($LASTEXITCODE -ne 0) { throw ('Boss Studio stopped with code ' + $LASTEXITCODE) }
} catch {
  Write-Host ('Cannot start Boss Studio: ' + $_.Exception.Message) -ForegroundColor Red
  Write-Host 'If automatic download fails, install Python from https://www.python.org/downloads/windows/ then reopen this file.' -ForegroundColor Yellow
  exit 1
}
