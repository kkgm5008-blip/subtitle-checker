# 자막 맞춤법 · AI 컨펌 - 구독 연결 프로그램
#
# 프리미어 플러그인이 보낸 작업을 이 PC의 Claude Code(claude -p)로 실행합니다.
# Claude Code에 로그인한 내 Claude 구독(Pro·Max)으로 돌아가서 API 비용이 따로 들지 않습니다.
# 127.0.0.1(이 PC 안)에서만 연결을 받습니다. 끄려면 이 창을 닫으세요.
#
# Windows PowerShell 5.1과 PowerShell 7에서 동작합니다.

param(
  [int]$Port = 0,
  [string]$Claude = ""
)

$ErrorActionPreference = "Stop"
$BridgeVersion = "1.3.2"
# 윈도우가 Hyper-V·WSL용으로 49152 이상 포트를 묶어 두는 일이 있어서 그 아래 포트를 차례로 시도
$Ports = if ($Port -gt 0) { @($Port) } else { @(41234, 41235, 41236, 41237) }
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

# 로그인 상태 (claude auth status, 사용량을 쓰지 않음). 옛 버전에는 이 명령이 없음
function Get-ClaudeAuth([string]$exe) {
  try {
    $r = Invoke-Claude $exe @("auth", "status", "--json") ([System.IO.Path]::GetTempPath()) "" 15000
    $text = ([string]$r.out).Trim()
    if ($text.StartsWith("{")) {
      $j = $text | ConvertFrom-Json
      return @{ checked = $true; loggedIn = [bool]$j.loggedIn; method = [string]$j.authMethod; plan = [string]$j.subscriptionType; email = [string]$j.email }
    }
    return @{ checked = $false; detail = (([string]$r.out) + " " + ([string]$r.err)).Trim() }
  } catch {
    return @{ checked = $false; detail = $_.Exception.Message }
  }
}

function Write-AuthStatus($auth) {
  if (-not $auth.checked) {
    Write-Host "로그인 상태를 확인하지 못했어요 (Claude Code가 옛 버전일 수 있어요. PowerShell에서 'claude update')." -ForegroundColor DarkYellow
  } elseif ($auth.loggedIn) {
    $who = @($auth.email, $auth.plan, $auth.method) | Where-Object { $_ }
    Write-Host ("Claude 로그인: 됨 ({0})" -f ($who -join ", ")) -ForegroundColor Green
  } else {
    Write-Host "Claude 로그인: 안 됨. 새 PowerShell 창에서 'claude' 를 실행하고 /login 으로 내 Claude 계정에 로그인한 뒤 이 창을 다시 여세요." -ForegroundColor Yellow
  }
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
    if (-not $script:ClaudeExe) {
      # 연결 프로그램을 켠 뒤에 Claude Code를 설치했을 수도 있어서 다시 찾아봄
      $script:ClaudeExe = Find-Claude
      if ($script:ClaudeExe) { $script:ClaudeVersion = Get-ClaudeVersion $script:ClaudeExe }
    }
    if (-not $script:ClaudeExe) { return @(200, (To-Json @{ ok = $false; error = "claude_not_found"; bridge = $BridgeVersion }), $null) }
    $auth = Get-ClaudeAuth $script:ClaudeExe
    return @(200, (To-Json @{ ok = $true; bridge = $BridgeVersion; claude = $script:ClaudeExe; version = $script:ClaudeVersion; auth = $auth }), $null)
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

function Open-Listeners {
  foreach ($p in $Ports) {
    $opened = @()
    foreach ($addr in @([System.Net.IPAddress]::Loopback, [System.Net.IPAddress]::IPv6Loopback)) {
      try {
        $l = New-Object System.Net.Sockets.TcpListener($addr, $p)
        $l.Start()
        $opened += $l
      } catch {
        # IPv6가 꺼진 PC도 있어서 IPv4만 열려도 됨
      }
    }
    if ($opened.Count -gt 0 -and $opened[0].LocalEndpoint.Address.Equals([System.Net.IPAddress]::Loopback)) {
      return @{ port = $p; listeners = $opened }
    }
    foreach ($l in $opened) { try { $l.Stop() } catch { } }
    Write-Host "포트 $p 은(는) 다른 프로그램이 쓰고 있어서 다음 포트를 시도해요." -ForegroundColor DarkYellow
  }
  return $null
}

function Serve-Client($client) {
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

try {
  $script:ClaudeExe = Find-Claude
  $script:ClaudeVersion = ""
  Write-Host "자막 맞춤법 · AI 컨펌 - 구독 연결 프로그램 $BridgeVersion"
  Write-Host "--------------------------------------------"
  if ($script:ClaudeExe) {
    $script:ClaudeVersion = Get-ClaudeVersion $script:ClaudeExe
    Write-Host "Claude Code: $($script:ClaudeExe) $($script:ClaudeVersion)"
    Write-AuthStatus (Get-ClaudeAuth $script:ClaudeExe)
  } else {
    Write-Host "Claude Code를 찾지 못했어요. PowerShell에서 아래 명령으로 설치한 뒤 'claude'를 한 번 실행해 로그인하세요. (이 창은 켜 둬도 돼요)" -ForegroundColor Yellow
    Write-Host "  irm https://claude.ai/install.ps1 | iex" -ForegroundColor Yellow
  }
  if ($env:ANTHROPIC_API_KEY) { Write-Host "환경 변수 ANTHROPIC_API_KEY는 빼고 실행해서 API 요금이 아니라 구독으로 돌아요." }
  [void](New-Item -ItemType Directory -Force -Path $WorkRoot)

  $server = Open-Listeners
  if (-not $server) {
    Write-Host "포트($($Ports -join ', '))를 하나도 열지 못했어요. 이미 켜져 있는 연결 프로그램 창이 있으면 그 창을 쓰세요." -ForegroundColor Red
    Read-Host "엔터를 누르면 닫힙니다"
    exit 1
  }
  Write-Host "준비 완료: 127.0.0.1:$($server.port) 에서 기다리는 중. 프리미어 패널을 쓰는 동안 이 창을 켜 두세요." -ForegroundColor Green

  while ($true) {
    $served = $false
    foreach ($l in $server.listeners) {
      if ($l.Pending()) {
        $client = $l.AcceptTcpClient()
        Serve-Client $client
        $served = $true
      }
    }
    if (-not $served) { Start-Sleep -Milliseconds 40 }
  }
} catch {
  # 'PowerShell에서 실행'은 끝나면 창이 바로 닫혀서, 오류를 읽을 수 있게 기다림
  Write-Host ""
  Write-Host "구독 연결 프로그램이 멈췄어요: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "이 문구를 그대로 알려 주세요."
  Read-Host "엔터를 누르면 닫힙니다"
  exit 1
}
