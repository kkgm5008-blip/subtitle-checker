# 프리미어 프로 플러그인: 자막 맞춤법 · AI 컨펌

프리미어 프로 안에서 패널로 열어 쓰는 플러그인입니다.

- **맞춤법**: 자막(SRT·VTT·TXT 파일, 또는 타임라인의 그래픽 텍스트)을 Claude나 네이버 맞춤법 검사기로 검사합니다. 바뀐 글자를 색으로 보여 주고, 시간을 누르면 그 위치로 재생헤드가 이동합니다. 수정할 곳을 타임라인 마커로 찍고, 교정된 SRT로 저장할 수 있습니다.
- **AI 컨펌**: 시퀀스에서 정지 화면(프레임)을 뽑아 Claude에게 보냅니다. Claude가 화면 속 글자의 맞춤법, 자막 가독성, 화면 구성, 요청사항을 보고 **컨펌 / 수정 후 컨펌 / 재작업 필요** 판정과 시간별 수정 목록을 줍니다. 수정 목록은 타임라인 마커(빨강=필수, 주황=권장, 파랑=참고)로 찍을 수 있습니다.

## 준비물

- **Premiere Pro 25.6 이상** (UXP 플러그인을 지원하는 버전). 도움말 > Premiere Pro 정보에서 버전을 확인하세요.
- **Anthropic API 키** (Claude를 쓸 때). [console.anthropic.com](https://console.anthropic.com)에서 결제 수단을 등록하고 API Keys 메뉴에서 만듭니다. claude.ai 구독(Pro·Max)과는 별도로, 쓴 만큼 과금됩니다.
  - 네이버 엔진으로 맞춤법만 검사할 때는 키가 없어도 됩니다. AI 컨펌은 키가 필요합니다.

## 설치

### 방법 1: .ccx 파일 더블클릭 (권장)

1. 이 저장소의 [`premiere-plugin/dist/subtitle-checker-premiere-1.0.0.ccx`](dist/subtitle-checker-premiere-1.0.0.ccx) 파일을 내려받습니다 (GitHub에서 파일을 열고 Download raw file).
2. 프리미어를 끈 상태에서 파일을 더블클릭합니다. Creative Cloud 데스크톱 앱이 설치를 진행합니다. 마켓플레이스 밖에서 받은 플러그인이라는 확인 창이 나오면 설치를 계속하세요.
3. 프리미어를 켜고 **창(Window) > UXP 플러그인(UXP Plugins) > 자막 맞춤법 · AI 컨펌**을 엽니다.

### 방법 2: 더블클릭이 안 될 때 (명령어로 설치)

Windows (PowerShell):

```powershell
& "C:\Program Files\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe" /install "$env:USERPROFILE\Downloads\subtitle-checker-premiere-1.0.0.ccx"
```

macOS (터미널):

```bash
"/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent" --install ~/Downloads/subtitle-checker-premiere-1.0.0.ccx
```

### 방법 3: 개발자 모드 (UXP Developer Tool)

1. 프리미어 **설정(Settings) > 플러그인(Plugins) > 개발자 모드 사용(Enable developer mode)**을 켜고 프리미어를 다시 시작합니다.
2. Creative Cloud 앱에서 **UXP Developer Tool**을 설치해 엽니다.
3. **Add Plugin** → `premiere-plugin/plugin/manifest.json` 선택 → **Load**.

이 방법은 프리미어를 다시 켤 때마다 Load를 다시 눌러야 할 수 있어요. 코드를 고치면서 쓸 때 편합니다.

## 사용법

### 처음 한 번: API 키 넣기

설정 탭 → 키 붙여넣기 → **저장** → **연결 테스트**. 키는 이 컴퓨터의 보안 저장소에만 저장됩니다.

### 맞춤법 검사

1. **자막 불러오기**
   - 프리미어 캡션 자막: 텍스트 패널(창 > 텍스트)의 캡션 탭 ··· 메뉴에서 **SRT 파일로 내보내기**를 한 뒤, 패널에서 **자막 파일 열기**.
   - Vrew 같은 다른 프로그램에서 만든 SRT도 그대로 열 수 있어요. 파일은 UTF-8이어야 합니다.
   - 문자 도구나 MOGRT로 넣은 그래픽 자막: **타임라인 그래픽 텍스트 읽기**.
2. 검사 엔진을 고르고 **맞춤법 검사 시작**.
   - Claude: 문맥까지 보고 고치고, 이유를 알려 줍니다 (유료).
   - 네이버: 무료지만 네이버 쪽 사정으로 막힐 수 있어요.
3. 결과 보기: 빨간 취소선은 지울 글자, 초록은 새 글자, `␣`는 띄어쓰기입니다. 시간 버튼을 누르면 재생헤드가 그 자막으로 갑니다. 원하지 않는 제안은 **이 제안 빼기**.
4. **타임라인에 마커로 표시**: 수정할 자막마다 노란 마커가 생깁니다 (확인이 필요한 곳은 파란 마커). 마커 패널에서 하나씩 넘겨 보며 고치면 됩니다.
5. **교정된 자막 저장**: 저장한 SRT를 프로젝트로 가져와(Ctrl/Cmd+I) 타임라인에 끌어다 놓으면 캡션 트랙으로 들어갑니다. 그래픽 자막은 마커를 보며 직접 고쳐 주세요.

### AI 컨펌

1. 검토할 시퀀스를 엽니다. 일부만 볼 때는 인/아웃 점을 찍고 **검토 구간**을 '인·아웃 구간만'으로 고릅니다.
2. 프레임 간격, 최대 프레임 수, 검토 초점, 요청사항(예: "자막은 하단 중앙, 로고는 오른쪽 위에 계속")을 정합니다. 아래에 예상 프레임 수와 비용이 나옵니다.
3. **컨펌 요청** → 프레임을 뽑고 Claude가 봅니다 (보통 1~3분).
4. 판정, 총평, 수정 목록과 그 시점의 화면이 나옵니다. 시간을 누르면 그 위치로 이동합니다.
5. **타임라인에 마커로 표시**하면 빨강(필수)·주황(권장)·파랑(참고) 마커가 생깁니다. **AI 마커 모두 지우기**는 이 플러그인이 만든 마커만 지웁니다.

팁: 맞춤법 탭에서 자막을 먼저 불러오면 컨펌 때 자막 목록도 함께 보내서 화면과 대조하고, **불러온 자막마다 한 장씩** 옵션으로 자막이 바뀔 때마다 한 장씩 확인할 수 있어요.

## 알아 둘 점

- Claude는 **정지 화면만** 봅니다. 소리, 움직임, 프레임과 프레임 사이 내용은 볼 수 없어요. 간격을 좁히면 더 꼼꼼해지지만 비용이 늘어납니다.
- 프리미어 API로는 캡션 트랙의 글자를 바로 읽을 수 없어서 SRT로 내보낸 뒤 불러옵니다. 캡션이 컨펌용 프레임 이미지에 찍혀 나오는지는 프리미어 버전에 따라 다를 수 있어요.
- **타임라인 그래픽 텍스트 읽기**는 프리미어 버전이나 그래픽 종류에 따라 일부 텍스트를 못 읽을 수 있어요. 그럴 때는 AI 컨펌(검토 초점: 자막·맞춤법 위주)으로 화면 속 글자를 검사하세요.
- 대략의 비용: Claude Opus 5.5로 프레임 40장 컨펌 한 번에 0.3~0.6달러, 자막 300줄 맞춤법 검사에 0.05~0.2달러. Sonnet 5.5는 절반, Haiku 5.5는 훨씬 저렴합니다 (설정 탭에서 모델 변경).
- Claude가 안전 정책 때문에 요청을 거절하면, Anthropic 서버가 권장 대체 모델로 자동으로 다시 시도하도록 켜 두었습니다 (Opus·Sonnet).
- 보내는 데이터: 컨펌 때는 프레임 이미지·요청사항·(선택 시) 자막 목록이 Anthropic API로, 맞춤법 검사 때는 자막 글자만 갑니다. 네이버 엔진을 고르면 자막 글자가 네이버로 갑니다.
- 프리미어 버전에 따라 동작이 다를 수 있어요. 오류 메시지가 나오면 그대로 알려 주세요.

## 개발

```
premiere-plugin/
  plugin/              ← 프리미어에 설치되는 플러그인 (manifest.json, index.html, main.js)
    lib/claude.js      Claude API 호출, 맞춤법·컨펌 프롬프트와 응답 형식
    lib/premiere.js    프리미어 UXP API (프레임 내보내기, 마커, 재생헤드, 그래픽 텍스트)
    lib/naver.js       네이버 맞춤법 검사기 (루트의 spellcheck.py를 옮긴 것)
    lib/srt.js         SRT·VTT·TXT 읽기/쓰기 (루트의 srt_io.py와 같은 규칙)
    lib/…              비교, 프레임 시점, 리포트, 저장소
  tests/               Node 테스트 (가짜 프리미어로 패널 전체를 눌러 보는 테스트 포함)
  build_ccx.py         plugin/ → dist/*.ccx
```

- 테스트: `cd premiere-plugin && npm install && npm test`
- 설치 파일 다시 만들기: `python3 build_ccx.py`
- 프리미어 UXP API 타입: [`@adobe/premierepro`](https://www.npmjs.com/package/@adobe/premierepro), 예제: [AdobeDocs/uxp-premiere-pro-samples](https://github.com/AdobeDocs/uxp-premiere-pro-samples)
