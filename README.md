# 영상/자막 맞춤법 검사기

영상(또는 음성) 파일을 올리면 자동으로 한국어 음성을 텍스트로 바꾸고(STT),
자막 파일(.srt/.vtt)이나 텍스트(.txt)를 올리면 바로, 한국어 맞춤법·띄어쓰기를
검사해서 보여주는 간단한 웹 앱입니다.

## 할 수 있는 것

- 영상/음성 파일(mp4, mov, mkv, mp3, wav 등) → 자동 자막 추출 → 맞춤법 검사
- 자막 파일(srt, vtt) → 바로 맞춤법 검사
- 텍스트 파일(txt) → 바로 맞춤법 검사
- 결과를 구간별로 원문/교정본 비교해서 보여줌
- 검사 리포트(.txt) 다운로드, 교정된 자막(.srt) 다운로드

## 프리미어 프로 플러그인

프리미어 안에서 자막 맞춤법을 검사하고, Claude가 시퀀스 화면을 보고 컨펌(검수)해 주는
패널입니다. 설치와 사용법은 [`premiere-plugin/README.md`](premiere-plugin/README.md)를 보세요.

- 설치 파일: `premiere-plugin/dist/subtitle-checker-premiere-1.3.0-windows.zip` (Mac은 `.ccx`)
- 내 Claude 구독(PC의 Claude Code)으로 돌려서 추가 비용 없이 쓰거나, API 키로 쓸 수 있음
- 자막(SRT/VTT/TXT, 타임라인 그래픽 텍스트) 맞춤법 검사 → 타임라인 마커, 교정된 SRT 저장
- 프리미어가 그래픽 글자를 알려 주지 않으면 Claude가 화면을 보고 받아 적어서 검사
- 검수팀 리뷰: 프레임을 뽑아 '밤샘 콘텐츠 컴퍼니' 검수팀이 "몇 분 몇 초에 자막 느낌·멘트·디자인을 이렇게" 같은 의견과 대안, 판정을 줌

## 밤샘 콘텐츠 컴퍼니 (Claude 아티팩트)

`content-company/index.html`은 claude.ai 아티팩트 '밤샘 콘텐츠 컴퍼니'의 원본 코드입니다. 페이지 안에서 Claude·저장소 기능(`window.claude`)을 쓰기 때문에 claude.ai 아티팩트로
열어야 제대로 동작합니다.

## 파일 구성

- `app.py` — 웹 화면(Streamlit)
- `srt_io.py` — 자막(srt/vtt) 파싱 및 생성
- `spellcheck.py` — 네이버 맞춤법 검사 호출
- `transcribe.py` — 영상/음성 → 자막 텍스트 변환(STT, faster-whisper)
- `requirements.txt`, `packages.txt` — 필요한 패키지 목록
- `premiere-plugin/` — 프리미어 프로 UXP 플러그인
- `content-company/` — 밤샘 콘텐츠 컴퍼니 아티팩트 원본
