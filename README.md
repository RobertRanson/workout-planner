# Workout Planner

A simple, phone-friendly workout tracker that replaces my Google Sheets tracker. It's a static site with no build step, hosted on GitHub Pages.

## Features

- **Today screen**: the next workout in the rotation (Chest & Triceps → Legs & Core 1 → Back & Biceps → Legs & Core 2 → Upper Body), how long ago each workout was last done, and a colour-coded calendar of the last 12 weeks (same colours as the old sheet).
- **Guided workout flow**: one exercise at a time. Each set shows last session's weight and reps as placeholders.
  - Tap ✓ on an empty set to log exactly what you did last time.
  - Use −/+ to nudge the weight (step size is in Settings), or type a value.
  - "Copy last session" fills every set at once.
  - A rest timer starts after each set, with a beep and a vibration when it's done.
  - Progression hints, e.g. "you hit the top of the rep range on every set — go heavier".
  - The screen stays awake during a workout, and a half-finished workout survives a reload or a closed tab.
- **Exercise videos**: the Muscle & Strength video (YouTube or Vimeo) is embedded on every exercise from `data/videos.json`. Tap **＋ Add video / Change video** to paste your own YouTube or Vimeo link, which overrides the built-in one on that device.
- **History**: full calendar by year, every session (tap to view, edit or delete), and a per-exercise progress chart.
- **Backup**: data lives in your browser's local storage. Settings → Export/Import JSON moves it between devices. CSV export is also available.
- **Installable**: on iPhone, open the site in Safari, then Share → Add to Home Screen. It works offline once loaded.

## Hosting on GitHub Pages

1. In the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Push to the default branch. `.github/workflows/pages.yml` publishes the site to `https://<user>.github.io/workout-planner/`.

## Re-importing the spreadsheet

`data/seed.json` was generated from the Google Sheet (`File → Download → .xlsx`):

```sh
pip install openpyxl
python3 tools/import_xlsx.py Workout_Tracker.xlsx data/seed.json
```

Exercise videos come from a separate sheet. Every tab with Workout Day, Exercise, Platform, Video ID and (Exercise) Source URL columns is read, and rows are matched to exercises by URL, then by name:

```sh
python3 tools/import_videos.py data/videos.json Workout_Video_IDs.xlsx Workout_YouTube_Replacements.xlsx
```

The app only reads the seed on first load, or on Settings → Reset. Abs workouts are not imported.

## Local development

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```
