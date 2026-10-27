# -*- coding: utf-8 -*-
"""
러프 컷 결과를 프리미어 프로에서 열 수 있는 XML(Final Cut Pro 7 XML, xmeml)로
만드는 모듈.

프리미어 프로에서 [파일 > 가져오기]로 이 XML을 고르면, 원본 영상을 남길 구간만
이어 붙인 시퀀스가 생깁니다. XML에는 원본 파일의 경로만 들어가고 영상 자체는
들어가지 않습니다.
"""

import os
import urllib.parse
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import List, Optional, Sequence, Tuple

# (화면 표시용, 실제 fps, XML timebase, NTSC 여부)
FRAME_RATES = [
    ("23.976", 24000 / 1001, 24, True),
    ("24", 24.0, 24, False),
    ("25", 25.0, 25, False),
    ("29.97", 30000 / 1001, 30, True),
    ("30", 30.0, 30, False),
    ("50", 50.0, 50, False),
    ("59.94", 60000 / 1001, 60, True),
    ("60", 60.0, 60, False),
]


@dataclass
class MediaInfo:
    name: str  # 원본 파일 이름 (예: interview.mp4)
    fps_label: str = "29.97"  # FRAME_RATES의 표시용 값, 또는 "15" 같은 정수 fps
    width: int = 1920
    height: int = 1080
    has_video: bool = True
    audio_channels: int = 2
    sample_rate: int = 48000
    duration: Optional[float] = None  # 초


def frame_rate(label: str) -> Tuple[float, int, bool]:
    """표시용 fps 값 → (실제 fps, XML timebase, NTSC 여부)."""
    for lab, fps, timebase, ntsc in FRAME_RATES:
        if lab == label:
            return fps, timebase, ntsc
    fps = round(float(label))
    return float(fps), fps, False


def rate_label(fps: float) -> str:
    """영상에서 읽은 fps를 가장 가까운 표준 값으로 맞춤 (표준과 거리가 멀면 정수로)."""
    lab, std, _, _ = min(FRAME_RATES, key=lambda r: abs(r[1] - fps))
    if abs(std - fps) / std < 0.01:
        return lab
    return str(round(fps))


def probe_media(path: str, name: str) -> MediaInfo:
    """영상/음성 파일의 fps, 해상도, 길이, 오디오 정보를 읽음."""
    import av

    info = MediaInfo(name=name, has_video=False)
    with av.open(path) as container:
        if container.duration:
            info.duration = container.duration / av.time_base
        vstream = next(
            # mp3 앨범 표지 같은 그림은 영상으로 치지 않음
            (s for s in container.streams.video if not (s.disposition & av.stream.Disposition.attached_pic)),
            None,
        )
        astream = next(iter(container.streams.audio), None)
        if astream is not None:
            cc = astream.codec_context
            info.sample_rate = cc.sample_rate or info.sample_rate
            if cc.layout is not None:
                info.audio_channels = cc.layout.nb_channels or info.audio_channels
        if vstream is not None:
            info.has_video = True
            rate = vstream.average_rate or vstream.guessed_rate
            if rate:
                info.fps_label = rate_label(float(rate))
            cc = vstream.codec_context
            info.width = cc.width or info.width
            info.height = cc.height or info.height
            # 휴대폰 세로 영상은 가로로 저장하고 회전 정보만 붙여두는 경우가 많음
            try:
                frame = next(container.decode(vstream))
                if abs(frame.rotation) % 180 == 90:
                    info.width, info.height = info.height, info.width
            except Exception:
                pass
    return info


def path_to_url(path: str) -> str:
    """'C:\\Videos\\a.mp4' 또는 '/Users/me/a.mp4' → XML에 넣는 file:// 주소."""
    p = path.strip().strip('"').strip("'").replace("\\", "/")
    if not p.startswith("/"):
        p = "/" + p
    return "file://localhost" + urllib.parse.quote(p, safe="/")


def source_name(path: str) -> str:
    return os.path.basename(path.strip().strip('"').strip("'").replace("\\", "/"))


def _text(parent: ET.Element, tag: str, value) -> ET.Element:
    el = ET.SubElement(parent, tag)
    el.text = str(value)
    return el


def _rate(parent: ET.Element, timebase: int, ntsc: bool) -> None:
    rate = ET.SubElement(parent, "rate")
    _text(rate, "timebase", timebase)
    _text(rate, "ntsc", "TRUE" if ntsc else "FALSE")


def _video_chars(parent: ET.Element, media: MediaInfo, timebase: int, ntsc: bool) -> None:
    chars = ET.SubElement(parent, "samplecharacteristics")
    _rate(chars, timebase, ntsc)
    _text(chars, "width", media.width)
    _text(chars, "height", media.height)
    _text(chars, "anamorphic", "FALSE")
    _text(chars, "pixelaspectratio", "square")
    _text(chars, "fielddominance", "none")


def _audio_chars(parent: ET.Element, media: MediaInfo) -> None:
    chars = ET.SubElement(parent, "samplecharacteristics")
    _text(chars, "depth", 16)
    _text(chars, "samplerate", media.sample_rate)


def build_sequence_xml(
    frame_ranges: Sequence[Tuple[int, int]],
    media: MediaInfo,
    source_path: str,
    sequence_name: str = "러프컷",
) -> str:
    """
    frame_ranges: 원본에서 남길 구간 [(시작 프레임, 끝 프레임), ...]
    source_path: 사용자 컴퓨터에서의 원본 파일 경로 (모르면 파일 이름만)
    """
    if not frame_ranges:
        raise ValueError("남길 구간이 없습니다.")
    fps, timebase, ntsc = frame_rate(media.fps_label)
    src_frames = max(b for _, b in frame_ranges)
    if media.duration:
        src_frames = max(src_frames, int(round(media.duration * fps)))
    total = sum(b - a for a, b in frame_ranges)
    count = len(frame_ranges)
    stereo = media.audio_channels >= 2
    file_written = False

    def file_el(parent: ET.Element) -> None:
        # 원본 파일 정의는 처음 한 번만 전부 쓰고, 그 뒤로는 id로만 가리킴
        nonlocal file_written
        f = ET.SubElement(parent, "file", id="file-1")
        if file_written:
            return
        file_written = True
        _text(f, "name", media.name)
        _text(f, "pathurl", path_to_url(source_path or media.name))
        _rate(f, timebase, ntsc)
        _text(f, "duration", src_frames)
        fmedia = ET.SubElement(f, "media")
        if media.has_video:
            _video_chars(ET.SubElement(fmedia, "video"), media, timebase, ntsc)
        faudio = ET.SubElement(fmedia, "audio")
        _audio_chars(faudio, media)
        _text(faudio, "channelcount", media.audio_channels)

    def clip_el(track: ET.Element, clip_id: int, a: int, b: int, start: int, **attrs) -> ET.Element:
        clip = ET.SubElement(track, "clipitem", id=f"clipitem-{clip_id}", **attrs)
        _text(clip, "name", media.name)
        _text(clip, "enabled", "TRUE")
        _text(clip, "duration", src_frames)
        _rate(clip, timebase, ntsc)
        _text(clip, "start", start)
        _text(clip, "end", start + (b - a))
        _text(clip, "in", a)
        _text(clip, "out", b)
        file_el(clip)
        return clip

    def links(clip: ET.Element, j: int) -> None:
        # 같은 컷의 영상/오디오를 묶어서 프리미어에서 함께 움직이도록 함
        link = ET.SubElement(clip, "link")
        _text(link, "linkclipref", f"clipitem-{j}")
        _text(link, "mediatype", "video")
        _text(link, "trackindex", 1)
        _text(link, "clipindex", j)
        link = ET.SubElement(clip, "link")
        _text(link, "linkclipref", f"clipitem-{count + j}")
        _text(link, "mediatype", "audio")
        _text(link, "trackindex", 1)
        _text(link, "clipindex", j)
        _text(link, "groupindex", 1)

    root = ET.Element("xmeml", version="4")
    seq = ET.SubElement(root, "sequence", id="sequence-1")
    _text(seq, "name", sequence_name)
    _text(seq, "duration", total)
    _rate(seq, timebase, ntsc)
    tc = ET.SubElement(seq, "timecode")
    _rate(tc, timebase, ntsc)
    _text(tc, "string", "00:00:00:00")
    _text(tc, "frame", 0)
    _text(tc, "displayformat", "NDF")

    seq_media = ET.SubElement(seq, "media")
    video = ET.SubElement(seq_media, "video")
    _video_chars(ET.SubElement(video, "format"), media, timebase, ntsc)
    vtrack = ET.SubElement(video, "track")

    audio = ET.SubElement(seq_media, "audio")
    _text(audio, "numOutputChannels", 2)
    _audio_chars(ET.SubElement(audio, "format"), media)
    atrack = ET.SubElement(audio, "track", premiereTrackType="Stereo" if stereo else "Mono")

    start = 0
    for j, (a, b) in enumerate(frame_ranges, start=1):
        if media.has_video:
            links(clip_el(vtrack, j, a, b, start), j)
        aclip = clip_el(atrack, count + j, a, b, start, premiereChannelType="stereo" if stereo else "mono")
        source = ET.SubElement(aclip, "sourcetrack")
        _text(source, "mediatype", "audio")
        _text(source, "trackindex", 1)
        if media.has_video:
            links(aclip, j)
        start += b - a

    ET.indent(root, space="  ")
    body = ET.tostring(root, encoding="unicode")
    return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n' + body + "\n"
