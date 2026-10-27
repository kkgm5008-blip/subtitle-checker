# -*- coding: utf-8 -*-
"""설치 파일을 만듭니다.

실행: python3 build_ccx.py
  dist/subtitle-checker-premiere-<버전>.ccx          프리미어 플러그인 (plugin/ 폴더를 묶은 것)
  dist/subtitle-checker-premiere-<버전>-windows.zip  .ccx + 구독 연결 프로그램 + 읽어보기
"""

import json
import pathlib
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent
PLUGIN = ROOT / "plugin"
BRIDGE = ROOT / "bridge" / "claude-bridge.ps1"
DIST = ROOT / "dist"

README = """자막 맞춤법 · AI 컨펌 (프리미어 프로 플러그인) {version}

1. subtitle-checker-premiere-{version}.ccx 를 더블클릭해서 설치하세요 (프리미어는 꺼 둔 상태로).
2. 내 Claude 구독으로 쓰려면 (추가 비용 없음):
   - PowerShell에서 다음 명령으로 Claude Code를 설치하고, claude 를 한 번 실행해 로그인하세요.
       irm https://claude.ai/install.ps1 | iex
   - claude-bridge.ps1 을 마우스 오른쪽 버튼으로 눌러 'PowerShell에서 실행'을 고르세요.
     프리미어 패널을 쓰는 동안 그 창을 켜 두면 됩니다.
3. 프리미어에서 창 > UXP 플러그인 > 자막 맞춤법 · AI 컨펌 을 열고,
   설정 탭에서 '구독 연결 확인'을 누르세요.

자세한 설명: GitHub 저장소 subtitle-checker 의 premiere-plugin/README.md
"""


def main():
    version = json.loads((PLUGIN / "manifest.json").read_text(encoding="utf-8"))["version"]
    DIST.mkdir(exist_ok=True)
    for old in DIST.glob("subtitle-checker-premiere-*"):
        old.unlink()

    ccx = DIST / f"subtitle-checker-premiere-{version}.ccx"
    files = sorted(p for p in PLUGIN.rglob("*") if p.is_file() and not p.name.startswith("."))
    with zipfile.ZipFile(ccx, "w", zipfile.ZIP_DEFLATED) as z:
        for p in files:
            z.write(p, p.relative_to(PLUGIN).as_posix())

    bundle = DIST / f"subtitle-checker-premiere-{version}-windows.zip"
    with zipfile.ZipFile(bundle, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(ccx, ccx.name)
        z.write(BRIDGE, BRIDGE.name)
        # 메모장에서 깨지지 않게 BOM이 있는 UTF-8, 윈도우 줄바꿈
        # zip 안 파일 이름은 영어로 (옛 윈도우 압축 풀기에서 한글 이름이 깨짐)
        text = README.format(version=version).replace("\n", "\r\n")
        z.writestr("README.txt", "﻿" + text)

    for out in (ccx, bundle):
        print(f"{out.relative_to(ROOT)} ({out.stat().st_size // 1024}KB)")


if __name__ == "__main__":
    main()
