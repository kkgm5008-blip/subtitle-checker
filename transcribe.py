# -*- coding: utf-8 -*-
"""
영상/음성 파일에서 한국어 자막(세그먼트)을 뽑아내는 모듈.
faster-whisper를 사용합니다 (CPU에서도 동작, GPU 있으면 더 빠름).
"""

from typing import List, Optional

from srt_io import Segment, Word

_MODEL_CACHE = {}


def _get_model(model_size: str):
    if model_size not in _MODEL_CACHE:
        from faster_whisper import WhisperModel

        # CPU만 있다고 가정하고 int8로 양자화 (속도/메모리 절약).
        # GPU(CUDA)가 있으면 device="cuda", compute_type="float16"으로 바꾸면 더 빠릅니다.
        _MODEL_CACHE[model_size] = WhisperModel(
            model_size, device="cpu", compute_type="int8"
        )
    return _MODEL_CACHE[model_size]


def transcribe_to_segments(
    file_path: str,
    model_size: str = "small",
    language: str = "ko",
    progress_cb: Optional[callable] = None,
) -> List[Segment]:
    """
    영상/음성 파일을 받아 Segment(타임코드 + 텍스트) 리스트로 변환합니다.
    progress_cb(현재초, 전체초)를 주면 진행률 콜백을 받을 수 있습니다.
    """
    model = _get_model(model_size)

    segments_iter, info = model.transcribe(
        file_path,
        language=language,
        vad_filter=True,
        beam_size=5,
        word_timestamps=True,  # 러프 컷에서 무음/군더더기를 단어 단위로 자르기 위해 필요
    )

    total = getattr(info, "duration", None)
    segments = []
    for i, seg in enumerate(segments_iter, start=1):
        text = seg.text.strip()
        if not text:
            continue
        words = [
            Word(start=w.start, end=w.end, text=w.word.strip())
            for w in (seg.words or [])
            if w.word.strip()
        ]
        segments.append(Segment(index=i, start=seg.start, end=seg.end, text=text, words=words or None))
        if progress_cb and total:
            progress_cb(seg.end, total)

    return segments
