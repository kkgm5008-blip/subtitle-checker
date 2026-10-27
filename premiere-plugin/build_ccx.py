# -*- coding: utf-8 -*-
"""plugin/ 폴더를 프리미어에 설치할 수 있는 .ccx 파일(zip)로 묶습니다.

실행: python3 build_ccx.py  →  dist/subtitle-checker-premiere-<버전>.ccx
"""

import json
import pathlib
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent
PLUGIN = ROOT / "plugin"
DIST = ROOT / "dist"


def main():
    version = json.loads((PLUGIN / "manifest.json").read_text(encoding="utf-8"))["version"]
    DIST.mkdir(exist_ok=True)
    out = DIST / f"subtitle-checker-premiere-{version}.ccx"
    files = sorted(p for p in PLUGIN.rglob("*") if p.is_file() and not p.name.startswith("."))
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for p in files:
            z.write(p, p.relative_to(PLUGIN).as_posix())
    print(f"{out.relative_to(ROOT)} ({len(files)}개 파일, {out.stat().st_size // 1024}KB)")


if __name__ == "__main__":
    main()
