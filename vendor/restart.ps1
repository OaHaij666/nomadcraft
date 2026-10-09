$ErrorActionPreference='Continue'
$m = 'C:\\Users\\63644\\Documents\\ChatGPT\\minecraft\\vendor\\mcsmanager'
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Start-Process -FilePath node -ArgumentList '--enable-source-maps','production/app.js' -WorkingDirectory "$m\daemon" -WindowStyle Hidden -RedirectStandardOutput "$env:TEMP\mcsm-daemon.log" -RedirectStandardError "$env:TEMP\mcsm-daemon.err" | Out-Null
Start-Sleep -Seconds 5
Start-Process -FilePath node -ArgumentList '--enable-source-maps','production/app.js' -WorkingDirectory "$m\panel" -WindowStyle Hidden -RedirectStandardOutput "$env:TEMP\mcsm-panel.log" -RedirectStandardError "$env:TEMP\mcsm-panel.err" | Out-Null
Start-Sleep -Seconds 7

'--- listening ---'
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in 23333,24444 } | Select-Object LocalPort | Sort-Object LocalPort | Format-Table -AutoSize | Out-String
'--- panel root ---'
try { $r = Invoke-WebRequest -UseBasicParsing 'http://localhost:23333/' -TimeoutSec 10; 'status=' + $r.StatusCode + ' len=' + $r.Content.Length; 'title=' + [regex]::Match($r.Content,'<title>(.*?)</title>').Groups[1].Value } catch { 'ERR ' + $_.Exception.Message }
'--- panel log tail ---'
Get-Content "$env:TEMP\mcsm-panel.log" -Tail 8 -ErrorAction SilentlyContinue
