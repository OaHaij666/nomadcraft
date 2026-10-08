# End-to-end smoke test: start the control plane, drive the real agent binary, and
# print the transcript. Run after `cargo build`.
$ErrorActionPreference = "Stop"
$root = "C:\\Users\\63644\\Documents\\ChatGPT\\minecraft"
$cp = Join-Path $root "target\debug\nomad-control-plane.exe"
$agent = Join-Path $root "target\debug\nomad-agent.exe"
$dataDir = Join-Path $env:TEMP ("nomad-smoke-" + [guid]::NewGuid().ToString("N").Substring(0,8))
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

Write-Host "== starting control plane =="
$proc = Start-Process -FilePath $cp -ArgumentList @("serve","--bind","127.0.0.1:8791","--data-dir",$dataDir) -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 3

try {
  $h = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:8791/healthz" -TimeoutSec 5
  Write-Host "healthz: $($h.StatusCode) $($h.Content)"

  Write-Host "== agent registers a machine =="
  & $agent register --control-plane http://127.0.0.1:8791 --name gaming-pc | Write-Host

  Write-Host "== nodes =="
  $nodes = Invoke-RestMethod "http://127.0.0.1:8791/v1/nodes" -TimeoutSec 5
  $nodes | ForEach-Object { Write-Host ("  {0} cores={1}" -f $_.node_id, $_.cpu_cores) }

  Write-Host "== create server =="
  $body = @{ name = "friends" } | ConvertTo-Json
  $srv = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8791/v1/servers" -ContentType "application/json" -Body $body -TimeoutSec 5
  Write-Host ("  server_id={0} epoch={1}" -f $srv.server_id, $srv.epoch)

  Write-Host "== claim host =="
  & $agent host --control-plane http://127.0.0.1:8791 --server $srv.server_id | Write-Host

  Write-Host "== server state =="
  $now = Invoke-RestMethod "http://127.0.0.1:8791/v1/servers/$($srv.server_id)" -TimeoutSec 5
  Write-Host ("  epoch={0} host={1}" -f $now.epoch, $now.host)

  Write-Host "== second claim should be refused =="
  & $agent host --control-plane http://127.0.0.1:8791 --server $srv.server_id 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "  correctly refused (host busy, exit $LASTEXITCODE)"
  } else {
    Write-Host "  UNEXPECTED: second claim succeeded"
  }
  Write-Host "== SMOKE OK =="
}
finally {
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  Write-Host "control plane stopped"
}
