#!/usr/bin/env python3
"""Check that a make-video output folder has what the exercise asks for.

Usage: python3 scripts/check_output.py <out_dir>
Needs ffprobe (comes with ffmpeg).
"""
import json
import shutil
import struct
import subprocess
import sys
from pathlib import Path


def png_size(path):
    with open(path, "rb") as f:
        head = f.read(24)
    if head[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    return struct.unpack(">II", head[16:24])


def probe(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout
    return json.loads(out)


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: python3 scripts/check_output.py <out_dir>")
    out = Path(sys.argv[1])
    problems = []

    video = out / "video.mp4"
    if not video.is_file():
        problems.append("video.mp4 is missing")
    elif not shutil.which("ffprobe"):
        problems.append("ffprobe not found; install ffmpeg to check video.mp4")
    else:
        info = probe(video)
        streams = info.get("streams", [])
        v = next((s for s in streams if s.get("codec_type") == "video"), None)
        if not v:
            problems.append("video.mp4 has no video stream")
        else:
            if (v.get("width"), v.get("height")) != (1920, 1080):
                problems.append(f"video is {v.get('width')}x{v.get('height')}, expected 1920x1080")
            if v.get("codec_name") != "h264":
                problems.append(f"video codec is {v.get('codec_name')}, expected h264")
        if not any(s.get("codec_type") == "audio" for s in streams):
            problems.append("video.mp4 has no audio track")
        duration = float(info.get("format", {}).get("duration", 0))
        if not 15 <= duration <= 25:
            problems.append(f"video is {duration:.1f}s long, expected 15-25s")

    poster = out / "poster.png"
    if not poster.is_file():
        problems.append("poster.png is missing")
    elif png_size(poster) != (1920, 1080):
        problems.append(f"poster.png is {png_size(poster) or 'not a PNG'}, expected (1920, 1080)")

    caption = out / "caption.txt"
    if not caption.is_file():
        problems.append("caption.txt is missing")
    elif not caption.read_text(encoding="utf-8").strip():
        problems.append("caption.txt is empty")

    if problems:
        print("\n".join(f"✗ {p}" for p in problems))
        sys.exit(1)
    print(f"✓ {out} looks good")


if __name__ == "__main__":
    main()
