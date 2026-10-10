# -*- coding: utf-8 -*-
"""
네이버 맞춤법 검사기(스마트에디터/검색 결과에 쓰이는 비공개 API)를 호출해
한국어 문장의 맞춤법/띄어쓰기를 검사하는 모듈.

주의:
  - 이 엔드포인트는 네이버가 공식적으로 제공하는 "오픈 API"가 아니라,
    검색 결과 화면에서 쓰는 내부 엔드포인트를 그대로 호출하는 방식입니다
    (py-hanspell 등 여러 오픈소스 프로젝트가 같은 방식을 사용합니다).
    네이버 쪽 사정으로 응답 형식이 바뀌거나 막힐 수 있습니다. 그럴 경우
    이 파일의 _call_api()만 고쳐주면 나머지 코드는 그대로 씁니다.
  - 한 번에 보낼 수 있는 글자 수에 제한이 있어서(대략 500자), 자막 한
    줄(segment) 단위로 나눠서 호출하는 걸 전제로 설계했습니다.
"""

import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import List

import requests

SPELLER_URL = "https://m.search.naver.com/p/csearch/ocontent/util/SpellerProxy"
MAX_CHARS = 490

_HEADERS = {
    "user-agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "referer": "https://search.naver.com/",
}

_TAG_MAP = [
    ("<em class='green_text'>", "<<SPC>>"),
    ("<em class=\"green_text\">", "<<SPC>>"),
    ("<em class='red_text'>", "<<SPELL>>"),
    ("<em class=\"red_text\">", "<<SPELL>>"),
    ("<em class='violet_text'>", "<<AMBIG>>"),
    ("<em class=\"violet_text\">", "<<AMBIG>>"),
    ("<em class='blue_text'>", "<<STAT>>"),
    ("<em class=\"blue_text\">", "<<STAT>>"),
    ("</em>", "<<END>>"),
]


class SpellCheckError(Exception):
    pass


@dataclass
class WordResult:
    text: str
    kind: str  # "spell" | "spacing" | "ambiguous" | "stat" | "ok"


@dataclass
class CheckResult:
    original: str
    corrected: str
    error_count: int
    words: List[WordResult]


def _strip_tags(html: str) -> str:
    wrapped = f"<content>{html}</content>".replace("<br>", " ")
    try:
        root = ET.fromstring(wrapped)
        return "".join(root.itertext())
    except ET.ParseError:
        # 혹시 파싱이 깨지면 태그만 대충 제거해서라도 반환
        import re as _re
        return _re.sub(r"<[^>]+>", "", wrapped).replace("<content>", "").replace("</content>", "")


PASSPORT_PAGE = (
    "https://search.naver.com/search.naver?where=nexearch&sm=top_hty&fbm=0&ie=utf8"
    "&query=%EB%A7%9E%EC%B6%A4%EB%B2%95%EA%B2%80%EC%82%AC%EA%B8%B0"
)
_passport_key = None


def _fetch_passport_key(session: requests.Session, timeout: float = 10.0):
    """네이버 검색 페이지에서 맞춤법 검사기용 passportKey를 가져옴."""
    import re

    resp = session.get(PASSPORT_PAGE, headers=_HEADERS, timeout=timeout)
    resp.raise_for_status()
    m = re.search(r"passportKey=([^&\"'}\\s]+)", resp.text)
    return m.group(1) if m else None


def _parse_body(body: str) -> dict:
    """JSON 또는 JSONP(콜백함수(...)) 형태 응답을 모두 처리."""
    import json

    body = body.strip()
    if not body.startswith("{"):
        start, end = body.find("("), body.rfind(")")
        if start != -1 and end > start:
            body = body[start + 1:end]
    return json.loads(body)


def _request(text: str, session: requests.Session, key, timeout: float) -> dict:
    params = {"where": "nexearch", "color_blindness": "0", "q": text}
    if key:
        params["passportKey"] = key
    resp = session.get(SPELLER_URL, params=params, headers=_HEADERS, timeout=timeout)
    resp.raise_for_status()
    try:
        return _parse_body(resp.text)
    except ValueError as e:
        raise SpellCheckError(f"응답을 해석할 수 없습니다: {resp.text[:200]}") from e


def _call_api(text: str, session: requests.Session, timeout: float = 10.0) -> dict:
    global _passport_key
    if _passport_key is None:
        try:
            _passport_key = _fetch_passport_key(session, timeout)
        except requests.RequestException:
            _passport_key = None

    data = _request(text, session, _passport_key, timeout)
    msg = data.get("message", {}) if isinstance(data, dict) else {}

    # 키가 만료됐거나 잘못된 경우: 새로 받아서 한 번 더 시도
    if "result" not in msg:
        _passport_key = _fetch_passport_key(session, timeout)
        data = _request(text, session, _passport_key, timeout)
        msg = data.get("message", {}) if isinstance(data, dict) else {}

    if "result" not in msg:
        raise SpellCheckError(f"예상한 응답 구조가 아닙니다: {str(data)[:200]}")
    return msg["result"]


def check_text(text: str, session: requests.Session = None, retries: int = 2) -> CheckResult:
    """짧은 문장 하나(<=약 490자)를 검사합니다."""
    if not text or not text.strip():
        return CheckResult(original=text, corrected=text, error_count=0, words=[])

    if len(text) > MAX_CHARS:
        raise SpellCheckError(
            f"한 번에 검사할 수 있는 길이({MAX_CHARS}자)를 넘었습니다. "
            "더 짧게 나눠서 호출해주세요."
        )

    owns_session = session is None
    session = session or requests.Session()
    last_err = None
    try:
        for attempt in range(retries + 1):
            try:
                result = _call_api(text, session)
                break
            except (requests.RequestException, SpellCheckError) as e:
                last_err = e
                if attempt < retries:
                    time.sleep(0.8 * (attempt + 1))
                else:
                    raise SpellCheckError(f"맞춤법 검사 API 호출에 실패했습니다: {e}") from e
    finally:
        if owns_session:
            session.close()

    html = result.get("html", "")
    error_count = int(result.get("errata_count", 0))
    corrected = _strip_tags(html)

    marked = html
    for old, new in _TAG_MAP:
        marked = marked.replace(old, new)

    words = []
    for token in marked.split(" "):
        if token == "":
            continue
        kind = "ok"
        for tag, label in (
            ("<<SPELL>>", "spell"),
            ("<<SPC>>", "spacing"),
            ("<<AMBIG>>", "ambiguous"),
            ("<<STAT>>", "stat"),
        ):
            if token.startswith(tag):
                kind = label
                token = token[len(tag):]
                break
        token = token.replace("<<END>>", "")
        words.append(WordResult(text=token, kind=kind))

    return CheckResult(
        original=text,
        corrected=corrected.strip(),
        error_count=error_count,
        words=words,
    )


def split_long_text(text: str, max_len: int = MAX_CHARS) -> List[str]:
    """MAX_CHARS보다 긴 텍스트를 문장 경계 위주로 나눔."""
    import re
    if len(text) <= max_len:
        return [text]
    parts = re.split(r"(?<=[.!?。！？\n])\s+", text)
    chunks = []
    buf = ""
    for part in parts:
        if len(buf) + len(part) + 1 > max_len:
            if buf:
                chunks.append(buf.strip())
            buf = part
            # 문장 하나가 그 자체로도 너무 길면 강제로 자름
            while len(buf) > max_len:
                chunks.append(buf[:max_len])
                buf = buf[max_len:]
        else:
            buf = (buf + " " + part).strip()
    if buf:
        chunks.append(buf.strip())
    return chunks
