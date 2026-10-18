"""Build data/videos.json (Muscle & Strength page URL -> video URL) from the video ID sheet.

Usage: python3 tools/import_videos.py Workout_Video_IDs.xlsx data/videos.json
Expected columns: Workout Day, Exercise, Platform, Video ID, ..., Source URL.
"""
import json
import sys

import openpyxl


def main(src, dst):
    ws = openpyxl.load_workbook(src).active
    header = [str(c.value or "").strip().lower() for c in ws[1]]
    col = {name: header.index(name) for name in ("workout day", "platform", "video id", "source url")}
    out = {}
    for row in ws.iter_rows(min_row=2, values_only=True):
        if str(row[col["workout day"]] or "").strip().lower() == "abs":
            continue
        platform = str(row[col["platform"]] or "").strip().lower()
        vid = str(row[col["video id"]] or "").strip()
        src_url = str(row[col["source url"]] or "").strip()
        if not (vid and src_url):
            continue
        if platform == "youtube":
            out[src_url] = f"https://www.youtube.com/watch?v={vid}"
        elif platform == "vimeo":
            out[src_url] = f"https://vimeo.com/{vid}"
    with open(dst, "w") as fh:
        json.dump(out, fh, indent=1, sort_keys=True)
    print(f"{len(out)} videos -> {dst}")


if __name__ == "__main__":
    main(*sys.argv[1:3])
