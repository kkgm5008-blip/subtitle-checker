# 자막 맞춤법 · AI 컨펌 - 구독 연결 프로그램
#
# 프리미어 플러그인이 보낸 작업을 이 PC의 Claude Code(claude -p)로 실행합니다.
# Claude Code에 로그인한 내 Claude 구독(Pro·Max)으로 돌아가서 API 비용이 따로 들지 않습니다.
# 127.0.0.1(이 PC 안)에서만 연결을 받습니다. 끄려면 이 창을 닫으세요.
#
# Windows PowerShell 5.1과 PowerShell 7에서 동작합니다.

param(
  [int]$Port = 51234,
  [string]$Claude = ""
)

$ErrorActionPreference = "Stop"
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$MaxBody = 40MB
$RunTimeoutMs = 20 * 60 * 1000
$WorkRoot = Join-Path ([System.IO.Path]::GetTempPath()) "subtitle-checker-bridge"
$Models = @("opus", "sonnet", "haiku")

function Find-Claude {
  if ($Claude) { return $Claude }
  if ($env:USERPROFILE) {
    $native = Join-Path $env:USERPROFILE ".local\bin\claude.exe"
    if (Test-Path $native) { return $native }
  }
  $cmd = Get-Command claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd) { return $cmd.Source }
  return $null
}

function New-ClaudeProcessInfo([string]$exe, [string[]]$arguments, [string]$workDir) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  # npm으로 설치하면 claude.cmd라서 cmd.exe로 실행해야 함 (인자는 모두 따옴표가 필요 없는 값)
  if ($exe -match '\.(cmd|bat)$') {
    $psi.FileName = $env:ComSpec
    $psi.Arguments = '/d /s /c ""' + $exe + '" ' + ($arguments -join ' ') + '"'
  } else {
    $psi.FileName = $exe
    $psi.Arguments = ($arguments -join ' ')
  }
  $psi.WorkingDirectory = $workDir
  # API 키가 환경 변수에 있으면 Claude Code가 구독 대신 API 요금으로 돌기 때문에 빼고 실행
  foreach ($name in @("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")) {
    if ($psi.EnvironmentVariables.ContainsKey($name)) { $psi.EnvironmentVariables.Remove($name) }
  }
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = $Utf8
  $psi.StandardErrorEncoding = $Utf8
  return $psi
}

function Invoke-Claude([string]$exe, [string[]]$arguments, [string]$workDir, [string]$stdinText, [int]$timeoutMs) {
  $p = New-Object System.Diagnostics.Process
  $p.StartInfo = New-ClaudeProcessInfo $exe $arguments $workDir
  [void]$p.Start()
  $outTask = $p.StandardOutput.ReadToEndAsync()
  $errTask = $p.StandardError.ReadToEndAsync()
  # 입력 인코딩 설정과 상관없이 UTF-8 바이트를 그대로 보냄
  $bytes = $Utf8.GetBytes($stdinText)
  $p.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
  $p.StandardInput.Close()
  if (-not $p.WaitForExit($timeoutMs)) {
    try { $p.Kill() } catch { }
    return @{ code = -1; out = ""; err = "시간 초과 ($([int]($timeoutMs / 60000))분)" }
  }
  $p.WaitForExit()
  return @{ code = $p.ExitCode; out = $outTask.Result; err = $errTask.Result }
}

function Get-ClaudeVersion([string]$exe) {
  try {
    $r = Invoke-Claude $exe @("--version") ([System.IO.Path]::GetTempPath()) "" 60000
    return ($r.out + $r.err).Trim()
  } catch {
    return ""
  }
}

# ───────── 아주 작은 HTTP 서버 (TcpListener, 관리자 권한 필요 없음) ─────────

function Read-Request([System.Net.Sockets.NetworkStream]$stream) {
  $head = New-Object System.Collections.Generic.List[byte]
  $buf = New-Object byte[] 1
  while ($true) {
    $n = $stream.Read($buf, 0, 1)
    if ($n -le 0) { return $null }
    $head.Add($buf[0])
    $c = $head.Count
    if ($c -ge 4 -and $head[$c - 4] -eq 13 -and $head[$c - 3] -eq 10 -and $head[$c - 2] -eq 13 -and $head[$c - 1] -eq 10) { break }
    if ($c -gt 65536) { throw "헤더가 너무 깁니다" }
  }
  $lines = [System.Text.Encoding]::ASCII.GetString($head.ToArray()) -split "`r`n"
  $parts = $lines[0] -split ' '
  $headers = @{}
  foreach ($line in $lines[1..($lines.Count - 1)]) {
    $i = $line.IndexOf(':')
    if ($i -gt 0) { $headers[$line.Substring(0, $i).Trim().ToLowerInvariant()] = $line.Substring($i + 1).Trim() }
  }
  $length = 0
  if ($headers.ContainsKey('content-length')) { $length = [int64]$headers['content-length'] }
  if ($length -gt $MaxBody) { throw "요청이 너무 큽니다" }
  $body = New-Object byte[] $length
  $read = 0
  while ($read -lt $length) {
    $n = $stream.Read($body, $read, [int]([Math]::Min(65536, $length - $read)))
    if ($n -le 0) { break }
    $read += $n
  }
  return @{ method = $parts[0]; path = $parts[1]; headers = $headers; body = $body }
}

function Send-Response([System.Net.Sockets.NetworkStream]$stream, [int]$status, [string]$text, [hashtable]$extra) {
  $reason = @{ 200 = "OK"; 400 = "Bad Request"; 403 = "Forbidden"; 404 = "Not Found"; 411 = "Length Required"; 500 = "Internal Server Error" }[$status]
  $bytes = $Utf8.GetBytes($text)
  $h = "HTTP/1.1 $status $reason`r`nContent-Type: application/json; charset=utf-8`r`nContent-Length: $($bytes.Length)`r`nConnection: close`r`n"
  if ($extra) { foreach ($k in $extra.Keys) { $h += "${k}: $($extra[$k])`r`n" } }
  $hb = [System.Text.Encoding]::ASCII.GetBytes($h + "`r`n")
  $stream.Write($hb, 0, $hb.Length)
  $stream.Write($bytes, 0, $bytes.Length)
  $stream.Flush()
}

function To-Json($obj) {
  return (ConvertTo-Json $obj -Compress -Depth 5)
}

function Job-Dir([string]$id) {
  if ($id -notmatch '^[A-Za-z0-9_-]{1,40}$') { throw "잘못된 작업 번호" }
  return (Join-Path $WorkRoot $id)
}

function Handle([hashtable]$req) {
  # 브라우저 페이지가 몰래 부르지 못하게: 이 헤더가 없으면 거절 (CORS 허용도 하지 않음)
  if ($req.headers['x-subtitle-checker'] -ne '1') { return @(403, (To-Json @{ ok = $false; error = "forbidden" }), $null) }
  $path = $req.path.Split('?')[0]

  if ($req.method -eq 'GET' -and $path -eq '/health') {
    if (-not $script:ClaudeExe) { return @(200, (To-Json @{ ok = $false; error = "claude_not_found" }), $null) }
    return @(200, (To-Json @{ ok = $true; claude = $script:ClaudeExe; version = $script:ClaudeVersion }), $null)
  }

  if ($req.method -eq 'POST' -and $path -eq '/jobs') {
    $id = [DateTime]::Now.ToString("yyyyMMdd_HHmmss") + "_" + [Guid]::NewGuid().ToString("N").Substring(0, 8)
    [void](New-Item -ItemType Directory -Force -Path (Job-Dir $id))
    return @(200, (To-Json @{ ok = $true; id = $id }), $null)
  }

  if ($req.method -eq 'PUT' -and $path -match '^/jobs/([^/]+)/files/([^/]+)$') {
    $dir = Job-Dir $Matches[1]
    $name = $Matches[2]
    if ($name -notmatch '^[A-Za-z0-9_-]{1,60}\.(jpg|jpeg|png)$') { return @(400, (To-Json @{ ok = $false; error = "bad_name" }), $null) }
    if (-not (Test-Path $dir)) { return @(404, (To-Json @{ ok = $false; error = "no_job" }), $null) }
    $data = [Convert]::FromBase64String([System.Text.Encoding]::ASCII.GetString($req.body))
    [System.IO.File]::WriteAllBytes((Join-Path $dir $name), $data)
    return @(200, (To-Json @{ ok = $true; bytes = $data.Length }), $null)
  }

  if ($req.method -eq 'POST' -and $path -match '^/jobs/([^/]+)/run$') {
    $dir = Job-Dir $Matches[1]
    if (-not (Test-Path $dir)) { return @(404, (To-Json @{ ok = $false; error = "no_job" }), $null) }
    if (-not $script:ClaudeExe) { return @(200, (To-Json @{ ok = $false; error = "claude_not_found" }), $null) }
    try {
      $job = $Utf8.GetString($req.body) | ConvertFrom-Json
      $model = [string]$job.model
      if ($Models -notcontains $model) { $model = "opus" }
      [System.IO.File]::WriteAllText((Join-Path $dir "system.txt"), [string]$job.system, $Utf8)
      $claudeArgs = @(
        "-p", "--output-format", "json", "--model", $model,
        "--tools", "Read", "--allowedTools", "Read", "--permission-mode", "dontAsk",
        "--strict-mcp-config", "--no-session-persistence", "--max-turns", "60",
        "--system-prompt-file", "system.txt"
      )
      $started = Get-Date
      Write-Host ("[{0}] Claude 작업 시작 (모델: {1}, 이미지 {2}장)" -f $started.ToString("HH:mm:ss"), $model, @(Get-ChildItem $dir -Include *.jpg, *.jpeg, *.png -Recurse).Count)
      $r = Invoke-Claude $script:ClaudeExe $claudeArgs $dir ([string]$job.prompt) $RunTimeoutMs
      Write-Host ("[{0}] 끝 ({1:N0}초, 종료 코드 {2})" -f (Get-Date).ToString("HH:mm:ss"), ((Get-Date) - $started).TotalSeconds, $r.code)
      $out = $r.out.Trim()
      if (-not $out.StartsWith("{")) {
        $msg = ($r.out + "`n" + $r.err).Trim()
        return @(200, (To-Json @{ ok = $false; error = "claude_failed"; detail = $msg; exitCode = $r.code }), $null)
      }
      return @(200, $out, @{ "X-Exit-Code" = $r.code })
    } finally {
      Remove-Item -Recurse -Force -Path $dir -ErrorAction SilentlyContinue
    }
  }

  return @(404, (To-Json @{ ok = $false; error = "not_found" }), $null)
}

# ───────── 시작 ─────────

$script:ClaudeExe = Find-Claude
$script:ClaudeVersion = ""
Write-Host "자막 맞춤법 · AI 컨펌 - 구독 연결 프로그램"
Write-Host "--------------------------------------------"
if ($script:ClaudeExe) {
  $script:ClaudeVersion = Get-ClaudeVersion $script:ClaudeExe
  Write-Host "Claude Code: $($script:ClaudeExe) $($script:ClaudeVersion)"
} else {
  Write-Host "Claude Code를 찾지 못했어요. PowerShell에서 아래 명령으로 설치한 뒤 'claude'를 한 번 실행해 로그인하고, 이 창을 다시 여세요." -ForegroundColor Yellow
  Write-Host "  irm https://claude.ai/install.ps1 | iex" -ForegroundColor Yellow
}
[void](New-Item -ItemType Directory -Force -Path $WorkRoot)

$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
try {
  $listener.Start()
} catch {
  Write-Host "포트 $Port 을(를) 열지 못했어요. 이미 켜져 있는 창이 있는지 확인하세요." -ForegroundColor Red
  Read-Host "엔터를 누르면 닫힙니다"
  exit 1
}
Write-Host "준비 완료: 127.0.0.1:$Port 에서 기다리는 중. 프리미어 패널을 쓰는 동안 이 창을 켜 두세요."

while ($true) {
  $client = $listener.AcceptTcpClient()
  try {
    $client.ReceiveTimeout = 30000
    $stream = $client.GetStream()
    $req = Read-Request $stream
    if ($req) {
      try {
        $res = Handle $req
        Send-Response $stream $res[0] $res[1] $res[2]
      } catch {
        Send-Response $stream 500 (To-Json @{ ok = $false; error = "bridge_error"; detail = $_.Exception.Message }) $null
      }
    }
  } catch {
    Write-Host "연결 처리 중 오류: $($_.Exception.Message)" -ForegroundColor DarkYellow
  } finally {
    $client.Close()
  }
}
