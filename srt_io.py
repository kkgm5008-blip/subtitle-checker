# -*- coding: utf-8 -*-
"""
자막 파일(SRT) 파싱/생성 유틸리티.
외부 라이브러리 없이 동작하도록 직접 구현했습니다 (환경에 따라 pysrt 같은
패키지가 설치되지 않는 경우가 있어서 의존성을 최소화했습니다).
"""

import re
from dataclasses import dataclass
from typing import List, Optional


@dataclass
class Word:
    start: float  # 초 단위
    end: float
    text: str


@dataclass
class Segment:
    index: int
    start: Optional[float]  # 초 단위. 타임코드가 없는 일반 텍스트면 None
    end: Optional[float]
    text: str
    words: Optional[List[Word]] = None  # 음성 인식으로 만든 경우 단어별 타임코드 (러프 컷에 사용)


_TIME_RE = re.compile(
    r"(\d{2}):(\d{2}):(\d{2})[.,](\d{1,3})"
)


def _parse_timestamp(ts: str) -> float:
    m = _TIME_RE.search(ts)
    if not m:
        return 0.0
    h, mi, s, ms = m.groups()
    ms = ms.ljust(3, "0")[:3]
    return int(h) * 3600 + int(mi) * 60 + int(s) + int(ms) / 1000.0


def format_timestamp(seconds: float) -> str:
    if seconds < 0:
        seconds = 0
    total_ms = round(seconds * 1000)
    h, rem = divmod(total_ms, 3600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def parse_srt(content: str) -> List[Segment]:
    """SRT 형식 문자열을 Segment 리스트로 변환."""
    content = content.replace("\r\n", "\n").replace("\r", "\n")
    blocks = re.split(r"\n\s*\n", content.strip())
    segments = []
    auto_idx = 1
    for block in blocks:
        lines = [l for l in block.split("\n") if l.strip() != ""]
        if not lines:
            continue
        # 첫 줄이 숫자(인덱스)인 경우 건너뜀
        start_line = 0
        idx = auto_idx
        if lines[0].strip().isdigit():
            idx = int(lines[0].strip())
            start_line = 1
        if start_line >= len(lines):
            continue
        time_line = lines[start_line]
        if "-->" not in time_line:
            # 타임코드 줄이 아니면 이 블록은 건너뜀
            continue
        start_str, end_str = [p.strip() for p in time_line.split("-->")]
        start = _parse_timestamp(start_str)
        end = _parse_timestamp(end_str)
        text = "\n".join(lines[start_line + 1:]).strip()
        if text:
            segments.append(Segment(index=idx, start=start, end=end, text=text))
            auto_idx = idx + 1
    return segments


def parse_vtt(content: str) -> List[Segment]:
    """WebVTT 형식을 SRT와 유사하게 파싱 (간단 버전)."""
    content = content.replace("\r\n", "\n").replace("\r", "\n")
    content = re.sub(r"^WEBVTT.*\n", "", content.strip())
    # VTT는 마침표(.)를 소수점 구분자로 쓰므로 콤마로 바꿔서 동일 파서 재사용
    content = re.sub(
        r"(\d{2}:\d{2}:\d{2})\.(\d{1,3})", r"\1,\2", content
    )
    return parse_srt(content)


def write_srt(segments: List[Segment]) -> str:
    out = []
    for i, seg in enumerate(segments, start=1):
        start = format_timestamp(seg.start or 0)
        end = format_timestamp(seg.end or (seg.start or 0) + 2)
        out.append(f"{i}\n{start} --> {end}\n{seg.text}\n")
    return "\n".join(out)


def split_plain_text(text: str) -> List[Segment]:
    """타임코드가 없는 일반 텍스트(.txt)를 문장/줄 단위 Segment로 변환."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    # 빈 줄 기준으로 문단을 나누고, 문단이 너무 길면 문장 단위(. ! ? 및 한국어 종결부호)로 추가 분리
    raw_lines = [l.strip() for l in text.split("\n") if l.strip() != ""]
    segments = []
    idx = 1
    for line in raw_lines:
        if len(line) <= 450:
            segments.append(Segment(index=idx, start=None, end=None, text=line))
            idx += 1
        else:
            parts = re.split(r"(?<=[.!?。！？])\s+", line)
            buf = ""
            for part in parts:
                if len(buf) + len(part) + 1 > 450:
                    if buf:
                        segments.append(Segment(index=idx, start=None, end=None, text=buf.strip()))
                        idx += 1
                    buf = part
                else:
                    buf = (buf + " " + part).strip()
            if buf:
                segments.append(Segment(index=idx, start=None, end=None, text=buf.strip()))
                idx += 1
    return segments
