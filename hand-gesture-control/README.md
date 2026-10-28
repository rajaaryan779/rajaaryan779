# Hand Gesture Control (Windows)

Control your cursor with your webcam and hand gestures, using MediaPipe + OpenCV + pyautogui.

## Setup
Use Python 3.9–3.12 (64-bit). In PowerShell:

```powershell
cd hand-gesture-control
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python main.py
```

## Gestures
| Gesture | Action |
|---|---|
| Index finger up | Move cursor |
| Pinch thumb + index | Left click (hold = drag) |
| Index + middle up | Scroll (move hand up/down) |
| Index + middle + ring up | Right click |
| Fist / open palm | Idle |

Press **Q** or **Esc** in the preview window to quit. Throwing the mouse into a screen corner triggers the pyautogui fail-safe.

Tune `MARGIN`, `SMOOTHING`, `PINCH_ON/OFF` and `SCROLL_GAIN` at the top of `main.py`.
