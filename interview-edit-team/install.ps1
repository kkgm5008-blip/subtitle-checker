# 인터뷰 편집 팀 파이프라인 설치
# 서브에이전트 4개(agents)와 /interview-edit 명령(commands)을 내 PC의 Claude Code 설정 폴더로 복사합니다.
# 같은 이름의 파일이 이미 있으면 .bak으로 백업한 뒤 덮어씁니다.
$ErrorActionPreference = 'Stop'
$claude = Join-Path $env:USERPROFILE '.claude'
foreach ($kind in @('agents', 'commands')) {
    $to = Join-Path $claude $kind
    New-Item -ItemType Directory -Force -Path $to | Out-Null
    Get-ChildItem -Path (Join-Path $PSScriptRoot $kind) -Filter *.md | ForEach-Object {
        $dest = Join-Path $to $_.Name
        if (Test-Path $dest) {
            Copy-Item $dest "$dest.bak" -Force
            Write-Host "기존 파일 백업: $dest.bak"
        }
        Copy-Item $_.FullName $dest -Force
        Write-Host "설치: $dest"
    }
}
Write-Host ''
Write-Host '설치 완료. Claude Code를 새로 열고 /interview-edit 를 입력하세요.'
Read-Host '엔터를 누르면 창이 닫힙니다'
