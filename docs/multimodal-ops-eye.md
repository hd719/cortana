# Multimodal Ops Eye: Screenshot, OCR, and UI State Intelligence

## Overview

`ops-eye` is a local macOS toolchain for:
- taking screenshots (`screencapture`)
- extracting text (OCR via `tesseract`)
- optionally inferring UI state (frontmost app/window + error/dialog heuristics)

It outputs structured JSON for automation and monitoring workflows.

## Install / Setup

### 1) OCR engine

```bash
brew install tesseract
```

> Default install includes English (`eng`) language data.

### 2) Tool files

- Python implementation: `~/openclaw/tools/ops-eye/capture.py`
- CLI wrapper: `~/openclaw/tools/ops-eye/capture`

Both are executable.

## Usage

### Full-screen capture + OCR

```bash
~/openclaw/tools/ops-eye/capture
```

### Full-screen + UI state detection

```bash
~/openclaw/tools/ops-eye/capture --ui-state
```

### Save screenshot file

```bash
~/openclaw/tools/ops-eye/capture --output-image ~/openclaw/tmp/ops-eye.png
```

### Capture specific window

```bash
~/openclaw/tools/ops-eye/capture --mode window --window-id 12345 --ui-state
```

### Keep temp screenshot (default temp files are cleaned)

```bash
~/openclaw/tools/ops-eye/capture --keep-temp
```

## JSON Output Shape

```json
{
  "ok": true,
  "timestamp_utc": "2026-02-25T16:00:00+00:00",
  "capture": {
    "path": "/path/or/null",
    "bytes": 123456,
    "mode": "full",
    "window_id": null
  },
  "ocr": {
    "text": "...",
    "line_count": 20,
    "char_count": 420,
    "language": "eng"
  },
  "frontmost": {
    "app_name": "Google Chrome",
    "window_title": "Dashboard"
  },
  "ui_state": {
    "severity": "normal|warning",
    "signals": ["error_keywords_detected"],
    "error_pattern_matches": ["\\berror\\b"]
  },
  "engine": {
    "ocr": "tesseract",
    "platform": "macOS"
  }
}
```

## Notes

- macOS Screen Recording permission may be required for terminal/shell host.
- `--mode window` requires a valid `CGWindowID`.
- UI-state detection is heuristic (keyword-based) and intended as a fast signal, not a guaranteed diagnosis.
