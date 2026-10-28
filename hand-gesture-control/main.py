"""Control a Windows PC with hand gestures via the webcam.

Gestures (either hand):
  index finger up              -> move the cursor
  pinch thumb + index          -> left click (hold the pinch to drag)
  index + middle up            -> scroll (move hand up/down)
  index + middle + ring up     -> right click
  fist / open palm             -> idle (cursor stays put)

Press Q or Esc in the preview window to quit. Slam the mouse into a screen
corner to trigger the pyautogui fail-safe if something goes wrong.
"""
import ctypes
import math
import time

import cv2
import mediapipe as mp
import pyautogui

# --- tuning ---------------------------------------------------------------
CAM_INDEX = 0
FRAME_W, FRAME_H = 640, 480
MARGIN = 0.18          # fraction of the frame ignored at each edge (hand reach box)
SMOOTHING = 0.35       # 0..1, lower = smoother but laggier
PINCH_ON = 0.28        # pinch distance / hand size below which we press
PINCH_OFF = 0.42       # ...and above which we release (hysteresis)
SCROLL_GAIN = 2500     # scroll clicks per unit of normalized vertical motion
SCROLL_DEADZONE = 0.004
RIGHT_CLICK_COOLDOWN = 0.8
# --------------------------------------------------------------------------

pyautogui.PAUSE = 0
pyautogui.FAILSAFE = True

try:  # make coordinates match physical pixels on scaled displays
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    pass

mp_hands = mp.solutions.hands
mp_draw = mp.solutions.drawing_utils

TIPS = {"index": (8, 6), "middle": (12, 10), "ring": (16, 14), "pinky": (20, 18)}


def dist(a, b):
    return math.hypot(a.x - b.x, a.y - b.y)


def fingers_up(lm):
    """Which of index/middle/ring/pinky are extended (tip above its PIP joint)."""
    return {name: lm[tip].y < lm[pip].y for name, (tip, pip) in TIPS.items()}


def classify(up):
    if up["index"] and up["middle"] and up["ring"] and not up["pinky"]:
        return "right_click"
    if up["index"] and up["middle"] and not up["ring"]:
        return "scroll"
    if up["index"] and not up["middle"] and not up["ring"]:
        return "point"
    return "idle"


def main():
    screen_w, screen_h = pyautogui.size()
    cap = cv2.VideoCapture(CAM_INDEX, cv2.CAP_DSHOW)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, FRAME_W)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, FRAME_H)
    if not cap.isOpened():
        raise SystemExit("Could not open the webcam (try CAM_INDEX = 1).")

    cur_x, cur_y = pyautogui.position()
    pressed = False
    last_scroll_y = None
    last_right_click = 0.0
    mode = "idle"

    with mp_hands.Hands(
        max_num_hands=1,
        model_complexity=0,
        min_detection_confidence=0.7,
        min_tracking_confidence=0.6,
    ) as hands:
        while cap.isOpened():
            ok, frame = cap.read()
            if not ok:
                break
            frame = cv2.flip(frame, 1)
            result = hands.process(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))

            mode = "no hand"
            if result.multi_hand_landmarks:
                hand = result.multi_hand_landmarks[0]
                lm = hand.landmark
                mp_draw.draw_landmarks(frame, hand, mp_hands.HAND_CONNECTIONS)

                up = fingers_up(lm)
                mode = classify(up)
                hand_size = dist(lm[0], lm[9]) or 1e-6  # wrist -> middle knuckle
                pinch = dist(lm[4], lm[8]) / hand_size

                # Pinch state machine (works while pointing, so you can drag).
                if not pressed and pinch < PINCH_ON:
                    pyautogui.mouseDown()
                    pressed = True
                elif pressed and pinch > PINCH_OFF:
                    pyautogui.mouseUp()
                    pressed = False
                if pressed:
                    mode = "drag/click"

                if mode in ("point", "drag/click"):
                    # Index PIP joint: steadier than the fingertip while pinching.
                    nx = (lm[6].x - MARGIN) / (1 - 2 * MARGIN)
                    ny = (lm[6].y - MARGIN) / (1 - 2 * MARGIN)
                    tx = min(max(nx, 0), 1) * (screen_w - 1)
                    ty = min(max(ny, 0), 1) * (screen_h - 1)
                    cur_x += (tx - cur_x) * SMOOTHING
                    cur_y += (ty - cur_y) * SMOOTHING
                    pyautogui.moveTo(cur_x, cur_y)
                    last_scroll_y = None
                elif mode == "scroll":
                    y = (lm[8].y + lm[12].y) / 2
                    if last_scroll_y is not None:
                        dy = last_scroll_y - y  # hand up -> scroll up
                        if abs(dy) > SCROLL_DEADZONE:
                            pyautogui.scroll(int(dy * SCROLL_GAIN))
                    last_scroll_y = y
                elif mode == "right_click":
                    now = time.time()
                    if now - last_right_click > RIGHT_CLICK_COOLDOWN:
                        pyautogui.click(button="right")
                        last_right_click = now
                    last_scroll_y = None
                else:
                    last_scroll_y = None
            else:
                if pressed:  # lost the hand mid-drag: never leave the button stuck
                    pyautogui.mouseUp()
                    pressed = False
                last_scroll_y = None

            cv2.putText(frame, mode, (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 255, 0), 2)
            cv2.imshow("Hand Gesture Control (Q to quit)", frame)
            if cv2.waitKey(1) & 0xFF in (ord("q"), 27):
                break

    if pressed:
        pyautogui.mouseUp()
    cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
