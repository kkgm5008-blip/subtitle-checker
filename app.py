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

import pandas as pd
import requests
import streamlit as st

import premiere_xml
import roughcut
import spellcheck
from srt_io import Segment, format_timestamp, parse_srt, parse_vtt, split_plain_text, write_srt

st.set_page_config(page_title="영상/자막 맞춤법 검사기", page_icon="📝", layout="wide")

VIDEO_AUDIO_EXTS = {"mp4", "mov", "mkv", "avi", "webm", "m4a", "mp3", "wav"}
AUDIO_EXTS = {"m4a", "mp3", "wav"}
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
        return (*st.session_state.segments_cache[key], ext)

    media = None  # 영상/음성 파일일 때만 fps·해상도 등 원본 정보를 읽어둠 (러프 컷 XML용)
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

        try:
            media = premiere_xml.probe_media(tmp_path, uploaded_file.name)
        except Exception:
            media = None

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

    st.session_state.segments_cache[key] = (segments, media)
    return segments, media, ext


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


def _clock(seconds: float) -> str:
    seconds = int(round(seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def render_roughcut(results, media, upload_name, upload_ext, key):
    """무음/군더더기/NG를 잘라낸 러프 컷을 만들어 프리미어 프로용 XML과 자막으로 내려받게 함."""
    st.divider()
    st.subheader("✂️ 러프 컷 → 프리미어 프로")
    st.caption(
        "말이 없는 구간, '음·어' 같은 군더더기, 같은 말을 다시 한 NG 테이크를 잘라낸 편집본을 "
        "프리미어 프로용 XML로 만들어 드려요. 함께 받는 자막(.srt)은 잘린 길이에 맞춰져 있어요. "
        "자동 판단이라 완벽하지 않으니 아래 표에서 구간을 켜고 끄며 확인해주세요."
    )
    if upload_ext in SUBTITLE_EXTS:
        st.info(
            "자막 파일만으로 자르면 자막 타이밍 기준이라 덜 정확해요. 또 자막 시간이 원본 클립 기준"
            "(시퀀스 0초에 원본 하나만 놓인 상태에서 만든 자막)이어야 맞습니다. "
            "더 정확하게 하려면 영상이나 음성 파일을 올려주세요."
        )

    segments = [seg for seg, _ in results]
    texts = [res.corrected or res.original for _, res in results]

    c1, c2 = st.columns(2)
    with c1:
        min_silence = st.slider(
            "이보다 긴 무음은 잘라내기 (초)", 0.2, 3.0, 0.6, 0.1,
            help="숫자를 줄이면 더 촘촘하게(빠른 호흡으로) 잘립니다.",
        )
        padding = st.slider(
            "잘린 곳 앞뒤 여유 (초)", 0.0, 0.5, 0.15, 0.05,
            help="말의 첫소리·끝소리가 잘리지 않도록 남겨둘 시간이에요.",
        )
    with c2:
        remove_retakes = st.checkbox("NG 테이크 빼기 (같은 말을 다시 하면 마지막 것만 남김)", value=True)
        remove_fillers = st.checkbox("군더더기 소리 빼기", value=True)
        filler_text = st.text_input(
            "군더더기로 볼 소리 (쉼표로 구분)", value=roughcut.DEFAULT_FILLERS, disabled=not remove_fillers
        )
    fillers = roughcut.parse_fillers(filler_text) if remove_fillers else set()

    st.markdown("**원본 영상 정보** — 프리미어에 있는 원본 클립과 같아야 컷 위치가 정확해요")
    has_video_info = media is not None and media.has_video
    source = st.text_input(
        "원본 영상 파일 경로",
        value=upload_name if upload_ext in VIDEO_AUDIO_EXTS - AUDIO_EXTS else "",
        placeholder=r"예) C:\Users\나\Videos\촬영본.mp4  또는  /Users/나/Movies/촬영본.mov",
        help=(
            "내 컴퓨터에서의 전체 경로를 넣으면 프리미어가 바로 원본을 찾아요. "
            "윈도우: 파일을 Shift+우클릭 → '경로로 복사' / 맥: 파일 선택 후 Option+우클릭 → '경로 이름 복사'. "
            "파일 이름만 넣으면 XML을 열 때 프리미어가 원본 위치를 물어봅니다."
        ),
    )
    r0, r1, r2, r3 = st.columns(4)
    audio_only_source = media is not None and not media.has_video and upload_ext not in AUDIO_EXTS
    kind = r0.radio("원본 종류", ["영상", "오디오만"], index=1 if audio_only_source else 0)
    labels = [r[0] for r in premiere_xml.FRAME_RATES]
    default_label = media.fps_label if has_video_info else "29.97"
    if default_label not in labels:
        labels.append(default_label)
    fps_label = r1.selectbox(
        "프레임 속도 (fps)", labels, index=labels.index(default_label),
        help="프리미어에서 원본 클립을 우클릭 → [속성]에 나오는 프레임 속도와 같게 맞춰주세요.",
    )
    width = r2.number_input("가로 (px)", 16, 8192, media.width if has_video_info else 1920, step=2)
    height = r3.number_input("세로 (px)", 16, 8192, media.height if has_video_info else 1080, step=2)
    if kind == "영상" and not has_video_info:
        st.caption(
            "올린 파일에서 영상 정보를 읽지 못했어요. 프리미어에서 원본 클립을 우클릭 → [속성]으로 "
            "프레임 속도·해상도를 확인해 맞춰주세요."
        )

    proposed = roughcut.propose_cuts(segments, fillers, remove_fillers, remove_retakes)
    table = pd.DataFrame({
        "사용": [d.keep for d in proposed],
        "#": [s.index for s in segments],
        "시작": [_clock(s.start) for s in segments],
        "내용": texts,
        "판단": [d.reason for d in proposed],
    })
    edited = st.data_editor(
        table,
        # 설정이 바뀌면 제안도 바뀌므로 표의 수동 수정도 새로 시작
        key=f"rc_table_{key}_{remove_fillers}_{remove_retakes}_{filler_text}",
        hide_index=True,
        disabled=["#", "시작", "내용", "판단"],
        column_config={"사용": st.column_config.CheckboxColumn("사용", help="체크를 끄면 그 구간을 잘라냅니다.")},
    )
    decisions = [roughcut.Decision(keep=bool(k), reason=d.reason) for k, d in zip(edited["사용"], proposed)]

    fps = premiere_xml.frame_rate(fps_label)[0]
    duration = media.duration if media is not None else None
    ranges = roughcut.keep_ranges(segments, decisions, fillers, remove_fillers, min_silence, padding, duration)
    frame_ranges = roughcut.to_frame_ranges(ranges, fps)
    if not frame_ranges:
        st.warning("남길 구간이 없어요. 표에서 '사용'을 켜주세요.")
        return

    orig_sec = duration or max(s.end for s in segments)
    cut_sec = sum(b - a for a, b in frame_ranges) / fps
    k1, k2, k3 = st.columns(3)
    k1.metric("원본 길이", _clock(orig_sec))
    k2.metric("러프 컷 길이", _clock(cut_sec), f"-{(1 - cut_sec / orig_sec) * 100:.0f}%", delta_color="inverse")
    k3.metric("컷 수", len(frame_ranges))

    if not source.strip():
        st.warning("위에 원본 영상 파일 경로(또는 파일 이름)를 넣으면 다운로드 버튼이 나타나요.")
        return

    xml_media = premiere_xml.MediaInfo(
        name=premiere_xml.source_name(source),
        fps_label=fps_label,
        width=int(width),
        height=int(height),
        has_video=kind == "영상",
        audio_channels=media.audio_channels if media is not None else 2,
        sample_rate=media.sample_rate if media is not None else 48000,
        duration=duration,
    )
    stem = os.path.splitext(xml_media.name)[0] or "roughcut"
    xml_text = premiere_xml.build_sequence_xml(frame_ranges, xml_media, source, sequence_name=f"{stem} 러프컷")
    cut_subs = roughcut.remap_segments(segments, texts, decisions, frame_ranges, fps, fillers, remove_fillers)

    d1, d2 = st.columns(2)
    with d1:
        st.download_button(
            "🎞️ 프리미어용 XML 다운로드",
            data=xml_text.encode("utf-8"),
            file_name=f"{stem}_러프컷.xml",
            mime="application/xml",
        )
    with d2:
        st.download_button(
            "💬 러프 컷에 맞춘 자막 (.srt) 다운로드",
            data=write_srt(cut_subs).encode("utf-8"),
            file_name=f"{stem}_러프컷.srt",
            mime="text/plain",
        )
    with st.expander("프리미어 프로에서 여는 방법"):
        st.markdown(
            "1. 프리미어 프로에서 **파일 > 가져오기** (Ctrl+I / Cmd+I) → 받은 `.xml` 파일 선택\n"
            "2. 프로젝트 패널에 생긴 **러프컷 시퀀스**를 더블클릭해서 열기\n"
            "3. 클립이 빨간 화면(미디어 오프라인)이면 클립 우클릭 → **미디어 연결** → 원본 파일 선택\n"
            "4. 자막: **파일 > 가져오기**로 `_러프컷.srt`를 불러와 시퀀스 맨 앞(0초)에 끌어다 놓기\n\n"
            "원본은 건드리지 않고 새 시퀀스만 생기니, 마음에 안 들면 시퀀스를 지우고 설정을 바꿔 다시 받으면 됩니다."
        )


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
            segments, media, ext = get_segments_from_upload(uploaded_file, model_size)
    except Exception as e:
        st.error(f"파일을 처리하는 중 오류가 발생했습니다: {e}")
        st.stop()

    if not segments:
        st.warning("텍스트를 추출하지 못했습니다. 파일 내용을 확인해주세요.")
        st.stop()

    st.success(f"총 {len(segments)}개 구간을 찾았습니다. 맞춤법 검사를 진행합니다.")

    sc_key = file_hash(uploaded_file.getvalue()) + (f"_{model_size}" if ext in VIDEO_AUDIO_EXTS else "") + "_sc"
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

    if has_timecodes:
        render_roughcut(results, media, uploaded_file.name, ext, sc_key)
else:
    st.info("위에 파일을 올리면 시작합니다.")
