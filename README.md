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

## 파일 구성

- `app.py` — 웹 화면(Streamlit)
- `srt_io.py` — 자막(srt/vtt) 파싱 및 생성
- `spellcheck.py` — 네이버 맞춤법 검사 호출
- `transcribe.py` — 영상/음성 → 자막 텍스트 변환(STT, faster-whisper)
- `requirements.txt`, `packages.txt` — 필요한 패키지 목록
