# 启动局域网 web 端（固定流程，别手打参数）
# 用法：pwsh -File scripts\web.ps1 -Book "E:\workspace\novel-workspace\novel_demo" -Port 18085
param(
  [string]$Book = 'E:\workspace\novel-workspace\novel_demo',
  [int]$Port = 18085,
  [string]$HostIp = '192.168.3.32'
)

# 1) 端口被占就先杀掉（只杀监听这个端口的进程，别碰别的）
$c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($c) {
  $c | ForEach-Object { Write-Host "killing pid $($_.OwningProcess) on :$Port"; Stop-Process -Id $_.OwningProcess -Force }
  Start-Sleep -Milliseconds 800
}

# 2) 必须在书的目录里启动：插件按「会话工作目录 → DSH_NOVEL_ROOT → cwd」找书
Set-Location $Book
$out = Join-Path $env:TEMP "dsh-web-$Port.log"
$err = Join-Path $env:TEMP "dsh-web-$Port.err"

# 3) 用 Start-Process 脱离当前 shell，避免关掉终端就把服务带走
Start-Process -FilePath 'dsh' -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err `
  -ArgumentList 'web', '--host', $HostIp, '--port', $Port, '--no-open', '--trusted-host', "$HostIp`:$Port"

# 4) 等它打印带 token 的地址（token 每次重启都会变，必须重新取）
$url = $null
for ($i = 0; $i -lt 30 -and -not $url; $i++) {
  Start-Sleep -Milliseconds 500
  $line = Get-Content $out -ErrorAction SilentlyContinue | Select-String 'token=' | Select-Object -Last 1
  if ($line) { $url = ($line.Line -split ' ')[-1] }
}
if (-not $url) {
  Write-Host '启动失败，看日志：'
  Get-Content $err -ErrorAction SilentlyContinue | Select-Object -Last 20
  exit 1
}

# 5) 自检：登录 + 两个接口都要 200，否则别把地址给用户
$jar = Join-Path $env:TEMP "dsh-jar-$Port.txt"
$code = curl.exe -s -L -c $jar -o NUL -w '%{http_code}' $url
$state = curl.exe -s -b $jar -o NUL -w '%{http_code}' "http://$HostIp`:$Port/novel-api/state"
Write-Host "login=$code state=$state"
Write-Host "URL: $url"
if ($code -ne '200') { exit 1 }
