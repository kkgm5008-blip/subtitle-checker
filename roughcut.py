# -*- coding: utf-8 -*-
"""
러프 컷(컷편집) 제안 모듈.

자막 구간(Segment)과 단어별 타임코드를 보고 아래 부분을 잘라낸
"남길 구간" 목록을 만듭니다.
  - 일정 길이 이상 말이 없는 구간(무음)
  - "음", "어" 같은 군더더기 소리
  - 같은 말을 다시 한 NG 테이크 (마지막 테이크만 남김)

결과는 premiere_xml.py로 프리미어 프로용 XML을 만들 때, 그리고 잘린 길이에
맞춘 자막(.srt)을 만들 때 씁니다.

판단은 모두 규칙 기반이라 완벽하지 않습니다. 화면에서 구간별로 켜고 끌 수 있게
하고, 세밀한 다듬기는 프리미어 프로에서 하는 걸 전제로 합니다.
"""

import math
import re
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import List, Optional, Sequence, Set, Tuple

from srt_io import Segment, Word

DEFAULT_FILLERS = "음, 어, 아, 으, 에, 흠, 엄"

# NG 테이크 판단 기준
RETAKE_LOOKAHEAD = 2  # 몇 구간 뒤까지 비교할지
RETAKE_MAX_GAP = 20.0  # 이 시간(초) 안에 다시 말한 경우만 NG로 봄
RETAKE_MIN_CHARS = 4  # 너무 짧은 말("네", "그래서")은 비교하지 않음

_NON_WORD_RE = re.compile(r"[^0-9A-Za-z가-힣]")


@dataclass
class Decision:
    keep: bool
    reason: str = ""  # 화면에 보여줄 판단 이유


def _normalize(text: str) -> str:
    return _NON_WORD_RE.sub("", text).lower()


def parse_fillers(text: str) -> Set[str]:
    """'음, 어, 아' 같은 입력을 비교하기 좋은 집합으로 변환."""
    return {_normalize(t) for t in re.split(r"[,\s]+", text) if _normalize(t)}


def is_filler(token: str, fillers: Set[str]) -> bool:
    """'음', '어어', '으음...'처럼 군더더기 소리로만 된 단어인지."""
    t = _normalize(token)
    if not t:
        return False
    if t in fillers:
        return True
    # '어어어', '으음'처럼 한 글자짜리 군더더기가 이어진 경우
    singles = {f for f in fillers if len(f) == 1}
    return all(ch in singles for ch in t)


def _is_filler_only(text: str, fillers: Set[str]) -> bool:
    tokens = [t for t in text.split() if _normalize(t)]
    return bool(tokens) and all(is_filler(t, fillers) for t in tokens)


def strip_fillers(text: str, fillers: Set[str]) -> str:
    """자막 문장에서 군더더기 단어만 뺌 (줄바꿈은 유지)."""
    lines = []
    for line in text.split("\n"):
        kept = [t for t in line.split() if not is_filler(t, fillers)]
        if kept:
            lines.append(" ".join(kept))
    return "\n".join(lines)


def _is_retake(a: str, b: str) -> bool:
    """정규화된 앞 구간 a를 뒤 구간 b에서 다시 말한 것처럼 보이는지."""
    if len(a) < RETAKE_MIN_CHARS or len(b) < RETAKE_MIN_CHARS:
        return False
    # 말하다 끊고 처음부터 다시 시작한 경우: "오늘은 제가" → "오늘은 제가 소개할 곳은..."
    head = a[: max(6, math.ceil(len(a) * 0.7))]
    if b.startswith(head):
        return True
    # 표현만 조금 바꿔서 거의 같은 문장을 다시 말한 경우
    return SequenceMatcher(None, a, b[: math.ceil(len(a) * 1.2)]).ratio() >= 0.85


def propose_cuts(
    segments: Sequence[Segment],
    fillers: Set[str],
    remove_fillers: bool = True,
    remove_retakes: bool = True,
) -> List[Decision]:
    """구간마다 남길지/뺄지 제안."""
    decisions = [Decision(keep=True) for _ in segments]
    norm = [_normalize(s.text) for s in segments]
    for i, seg in enumerate(segments):
        if remove_fillers and _is_filler_only(seg.text, fillers):
            decisions[i] = Decision(keep=False, reason="군더더기 소리")
            continue
        if not remove_retakes:
            continue
        for j in range(i + 1, min(i + 1 + RETAKE_LOOKAHEAD, len(segments))):
            nxt = segments[j]
            if seg.end is not None and nxt.start is not None and nxt.start - seg.end > RETAKE_MAX_GAP:
                break
            if _is_retake(norm[i], norm[j]):
                decisions[i] = Decision(keep=False, reason=f"NG 의심 (#{nxt.index}에서 다시 말함)")
                break
    return decisions


def _words(seg: Segment) -> List[Word]:
    # 단어별 타임코드가 없으면(자막 파일 입력) 구간 전체를 한 단어처럼 다룸
    return seg.words or [Word(start=seg.start, end=seg.end, text=seg.text)]


def _kept_words(seg: Segment, fillers: Set[str], remove_fillers: bool) -> List[Word]:
    return [w for w in _words(seg) if not (remove_fillers and is_filler(w.text, fillers))]


def keep_ranges(
    segments: Sequence[Segment],
    decisions: Sequence[Decision],
    fillers: Set[str],
    remove_fillers: bool,
    min_silence: float,
    padding: float,
    duration: Optional[float] = None,
) -> List[Tuple[float, float]]:
    """
    원본에서 남길 구간 [(시작초, 끝초), ...]을 시간순으로 반환.
    min_silence보다 긴 무음과, 빼기로 한 말(NG/군더더기)은 잘라내고
    남는 말소리 앞뒤로 padding만큼 여유를 둡니다.
    """
    items = []  # (시작, 끝, 남길지)
    for seg, d in zip(segments, decisions):
        if seg.start is None or seg.end is None:
            continue
        for w in _words(seg):
            keep = d.keep and not (remove_fillers and is_filler(w.text, fillers))
            items.append((w.start, w.end, keep))
    items.sort(key=lambda x: x[0])

    # [시작, 끝, 앞쪽 여유 한계, 뒤쪽 여유 한계]
    # 여유(padding)가 빼기로 한 말까지 덮지 않도록 한계를 같이 기록해둠
    ranges = []
    cur = None
    last_drop_end = 0.0
    for start, end, keep in items:
        if not keep:
            if cur is not None:
                cur[3] = min(cur[3], start)
                ranges.append(cur)
                cur = None
            last_drop_end = max(last_drop_end, end)
            continue
        if cur is not None and start - cur[1] <= min_silence:
            cur[1] = max(cur[1], end)
        else:
            if cur is not None:
                ranges.append(cur)
            cur = [start, end, last_drop_end, math.inf]
    if cur is not None:
        ranges.append(cur)

    limit = duration if duration else math.inf
    out = []
    for start, end, lo, hi in ranges:
        s = max(start - padding, lo, 0.0)
        e = min(end + padding, hi, limit)
        if e <= s:
            continue
        if out and s <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], e))
        else:
            out.append((s, e))
    return out


def to_frame_ranges(ranges: Sequence[Tuple[float, float]], fps: float) -> List[Tuple[int, int]]:
    """초 단위 구간을 프레임 단위로 맞춤 (XML과 자막이 같은 기준을 쓰도록)."""
    out = []
    for s, e in ranges:
        a, b = int(round(s * fps)), int(round(e * fps))
        if b <= a:
            continue
        if out and a <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], b))
        else:
            out.append((a, b))
    return out


def map_time(t: float, frame_ranges: Sequence[Tuple[int, int]], fps: float) -> float:
    """원본 시각 t가 러프 컷 타임라인에서 몇 초인지. 잘린 틈에 있으면 그 컷 지점."""
    offset = 0
    for a, b in frame_ranges:
        if t < a / fps:
            break
        if t <= b / fps:
            return offset / fps + (t - a / fps)
        offset += b - a
    return offset / fps


def remap_segments(
    segments: Sequence[Segment],
    texts: Sequence[str],
    decisions: Sequence[Decision],
    frame_ranges: Sequence[Tuple[int, int]],
    fps: float,
    fillers: Set[str],
    remove_fillers: bool,
) -> List[Segment]:
    """러프 컷 타임라인에 맞춘 자막 구간 목록."""
    out = []
    for seg, text, d in zip(segments, texts, decisions):
        if not d.keep or seg.start is None or seg.end is None:
            continue
        kept = _kept_words(seg, fillers, remove_fillers)
        if not kept:
            continue
        if remove_fillers:
            text = strip_fillers(text, fillers)
        start = map_time(kept[0].start, frame_ranges, fps)
        end = map_time(kept[-1].end, frame_ranges, fps)
        if text.strip() and end > start:
            out.append(Segment(index=len(out) + 1, start=start, end=end, text=text.strip()))
    # 프리미어 캡션 트랙은 자막끼리 겹치면 안 되므로 앞 자막 끝을 당겨줌
    for prev, nxt in zip(out, out[1:]):
        prev.end = min(prev.end, nxt.start)
    return [s for s in out if s.end > s.start]
