# -*- coding: utf-8 -*-
"""
영상/자막 맞춤법 검사기
- 영상(또는 음성) 파일을 올리면 자동으로 한국어 자막을 추출(STT)하고,
- 자막 파일(.srt/.vtt)이나 텍스트(.txt)를 올리면 바로,
한국어 맞춤법/띄어쓰기를 검사해서 보여주는 간단한 웹 앱입니다.

실행 방법: streamlit run app.py
"""

import hashlib
import os
import tempfile
import time

import requests
import streamlit as st

import spellcheck
from srt_io import Segment, format_timestamp, parse_srt, parse_vtt, split_plain_text, write_srt

st.set_page_config(page_title="영상/자막 맞춤법 검사기", page_icon="📝", layout="wide")

VIDEO_AUDIO_EXTS = {"mp4", "mov", "mkv", "avi", "webm", "m4a", "mp3", "wav"}
SUBTITLE_EXTS = {"srt", "vtt"}
TEXT_EXTS = {"txt"}

MODEL_CHOICES = {
    "tiny (가장 빠름, 정확도 낮음)": "tiny",
    "base (권장: 무료 호스팅에서도 비교적 안전)": "base",
    "small (속도/정확도 균형, 리소스 더 필요)": "small",
    "medium (느림, 정확도 높음 — 무료 호스팅에서는 비권장)": "medium",
}


def file_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:16]


def get_segments_from_upload(uploaded_file, model_size: str):
    ext = uploaded_file.name.rsplit(".", 1)[-1].lower()
    data = uploaded_file.getvalue()
    key = file_hash(data) + f"_{model_size}"

    if "segments_cache" not in st.session_state:
        st.session_state.segments_cache = {}
    if key in st.session_state.segments_cache:
        return st.session_state.segments_cache[key], ext

    if ext in SUBTITLE_EXTS:
        text = data.decode("utf-8", errors="ignore")
        segments = parse_srt(text) if ext == "srt" else parse_vtt(text)
    elif ext in TEXT_EXTS:
        text = data.decode("utf-8", errors="ignore")
        segments = split_plain_text(text)
    elif ext in VIDEO_AUDIO_EXTS:
        import transcribe

        with tempfile.NamedTemporaryFile(suffix=f".{ext}", delete=False) as tmp:
            tmp.write(data)
            tmp_path = tmp.name

        progress = st.progress(0.0, text="음성 인식(STT) 준비 중... (처음 실행이면 모델 다운로드로 시간이 걸릴 수 있어요)")

        def cb(cur, total):
            frac = min(cur / total, 1.0) if total else 0.0
            progress.progress(frac, text=f"음성 인식 중... {cur:.0f}s / {total:.0f}s")

        try:
            segments = transcribe.transcribe_to_segments(tmp_path, model_size=model_size, progress_cb=cb)
        finally:
            os.unlink(tmp_path)
        progress.progress(1.0, text="음성 인식 완료")
    else:
        raise ValueError(f"지원하지 않는 파일 형식입니다: .{ext}")

    st.session_state.segments_cache[key] = segments
    return segments, ext


def run_spellcheck(segments, key):
    if "spellcheck_cache" not in st.session_state:
        st.session_state.spellcheck_cache = {}
    if key in st.session_state.spellcheck_cache:
        return st.session_state.spellcheck_cache[key]

    st.session_state.spellcheck_warnings = []
    results = []
    progress = st.progress(0.0, text="맞춤법 검사 중...")
    session = requests.Session()
    errors_seen = 0
    try:
        for i, seg in enumerate(segments):
            try:
                chunks = spellcheck.split_long_text(seg.text)
                if len(chunks) == 1:
                    res = spellcheck.check_text(seg.text, session=session)
                else:
                    # 너무 긴 세그먼트는 나눠서 검사한 뒤 합침
                    corrected_parts = []
                    err_count = 0
                    for c in chunks:
                        r = spellcheck.check_text(c, session=session)
                        corrected_parts.append(r.corrected)
                        err_count += r.error_count
                    res = spellcheck.CheckResult(
                        original=seg.text,
                        corrected=" ".join(corrected_parts),
                        error_count=err_count,
                        words=[],
                    )
            except spellcheck.SpellCheckError as e:
                errors_seen += 1
                res = spellcheck.CheckResult(
                    original=seg.text, corrected=seg.text, error_count=-1, words=[]
                )
                st.session_state.setdefault("spellcheck_warnings", []).append(str(e))

            results.append((seg, res))
            progress.progress((i + 1) / len(segments), text=f"맞춤법 검사 중... {i + 1}/{len(segments)}")
            time.sleep(0.15)  # 서버 과호출 방지용 짧은 대기
    finally:
        session.close()

    st.session_state.spellcheck_cache[key] = results
    return results


st.title("📝 영상/자막 맞춤법 검사기")
st.caption(
    "영상·음성 파일을 올리면 자동으로 자막을 추출(STT)하고, 자막(.srt/.vtt)이나 텍스트(.txt)를 "
    "올리면 바로 한국어 맞춤법·띄어쓰기를 검사해줍니다."
)

with st.sidebar:
    st.header("설정")
    model_label = st.selectbox("음성 인식(STT) 모델 (영상/음성 파일일 때만 사용)", list(MODEL_CHOICES.keys()), index=1)
    model_size = MODEL_CHOICES[model_label]
    st.caption("자막(.srt/.vtt)이나 텍스트(.txt)를 올리면 이 설정은 쓰이지 않습니다.")
    st.divider()
    st.caption(
        "⚠️ 맞춤법 검사는 네이버 맞춤법 검사기를 이용하며, 인터넷 연결이 필요합니다. "
        "너무 자주/많이 호출하면 일시적으로 막힐 수 있어요."
    )

uploaded_file = st.file_uploader(
    "영상/음성 파일 (mp4, mov, mkv, mp3, wav 등) 또는 자막·텍스트 파일 (srt, vtt, txt)",
    type=sorted(VIDEO_AUDIO_EXTS | SUBTITLE_EXTS | TEXT_EXTS),
)

if uploaded_file is not None:
    try:
        with st.spinner("파일 처리 중..."):
            segments, ext = get_segments_from_upload(uploaded_file, model_size)
    except Exception as e:
        st.error(f"파일을 처리하는 중 오류가 발생했습니다: {e}")
        st.stop()

    if not segments:
        st.warning("텍스트를 추출하지 못했습니다. 파일 내용을 확인해주세요.")
        st.stop()

    st.success(f"총 {len(segments)}개 구간을 찾았습니다. 맞춤법 검사를 진행합니다.")

    sc_key = file_hash(uploaded_file.getvalue()) + "_sc"
    results = run_spellcheck(segments, sc_key)

    warnings = st.session_state.get("spellcheck_warnings")
    if warnings:
        st.warning(
            f"일부 구간({len(warnings)}개)에서 맞춤법 검사 API 호출에 실패했습니다. "
            "인터넷 연결 상태를 확인하거나 잠시 후 다시 시도해보세요."
        )

    total = len(results)
    changed = sum(1 for _, r in results if r.corrected.strip() != r.original.strip())
    total_errors = sum(max(r.error_count, 0) for _, r in results)

    c1, c2, c3 = st.columns(3)
    c1.metric("전체 구간", total)
    c2.metric("수정 제안된 구간", changed)
    c3.metric("총 오류 수(추정)", total_errors)

    st.divider()
    st.subheader("검사 결과")

    show_only_changed = st.checkbox("수정 제안이 있는 구간만 보기", value=True)

    for seg, res in results:
        is_changed = res.corrected.strip() != res.original.strip()
        if show_only_changed and not is_changed:
            continue

        timecode = ""
        if seg.start is not None:
            timecode = f"`{format_timestamp(seg.start)} → {format_timestamp(seg.end)}`  "

        with st.container(border=True):
            st.markdown(f"**#{seg.index}** {timecode}")
            col1, col2 = st.columns(2)
            with col1:
                st.markdown("원문")
                st.write(res.original)
            with col2:
                st.markdown("교정 제안" if is_changed else "원문 그대로 (문제 없음)")
                if res.error_count == -1:
                    st.write("⚠️ 검사 실패")
                elif is_changed:
                    st.markdown(f":red[{res.corrected}]")
                else:
                    st.write(res.corrected)

    st.divider()
    st.subheader("결과 다운로드")

    has_timecodes = any(seg.start is not None for seg, _ in results)

    report_lines = ["# 영상/자막 맞춤법 검사 리포트", ""]
    corrected_segments = []
    for seg, res in results:
        tc = f"[{format_timestamp(seg.start)} - {format_timestamp(seg.end)}] " if seg.start is not None else f"[#{seg.index}] "
        report_lines.append(f"{tc}원문: {res.original}")
        if res.corrected.strip() != res.original.strip():
            report_lines.append(f"{' ' * len(tc)}수정: {res.corrected}")
        report_lines.append("")
        corrected_segments.append(Segment(index=seg.index, start=seg.start, end=seg.end, text=res.corrected or res.original))

    report_text = "\n".join(report_lines)

    dl1, dl2 = st.columns(2)
    with dl1:
        st.download_button(
            "📄 검사 리포트 (.txt) 다운로드",
            data=report_text.encode("utf-8"),
            file_name="맞춤법_검사_리포트.txt",
            mime="text/plain",
        )
    with dl2:
        if has_timecodes:
            srt_text = write_srt(corrected_segments)
            st.download_button(
                "🎬 수정된 자막 (.srt) 다운로드",
                data=srt_text.encode("utf-8"),
                file_name="corrected.srt",
                mime="text/plain",
            )
        else:
            st.caption("타임코드가 없는 입력이라 자막 파일로는 내려받을 수 없어요.")
else:
    st.info("위에 파일을 올리면 시작합니다.")
