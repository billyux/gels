"""
라즈베리파이 - 행동 패턴 수집기
--------------------------------
고령자 AI 케어 프로젝트: ESP32 카메라의 영상을 받아서 MediaPipe Pose로
자세를 분석하고, 일정 주기로 "활동량"을 계산해 Supabase에 기록합니다.

이 데이터가 1주일 정도 쌓이면(웹 대시보드 쪽에서) 시간대별 평소 활동
패턴의 기준선을 만들고, 그 기준에서 벗어나는 시간대를 감지하는 데
쓰입니다.

⚠ 실제 라즈베리파이에서 실행해서 확인한 적은 없습니다 (원격 코드 작성만
가능). OpenCV로 MJPEG 스트림 열기, MediaPipe Pose 추론은 둘 다 표준적인
방법이지만, 실제 환경(라즈베리파이 OS 버전, 카메라 해상도 등)에 따라
설치나 미세 조정이 필요할 수 있습니다.

필요한 것 (요구사항은 requirements.txt 참고):
    pip install -r requirements.txt

환경변수로 설정(커밋되는 코드에 직접 값을 넣지 마세요):
    ESP32_STREAM_URL   예: http://192.168.0.50/stream
    SUPABASE_URL        예: https://sqxvkpavtwpglneamntd.supabase.co
    SUPABASE_ANON_KEY   Supabase 프로젝트의 publishable/anon key
    DEVICE_USERNAME     대시보드에 로그인할 때 쓰는 아이디 (예: billy)
    DEVICE_PASSWORD     그 계정의 비밀번호

실행:
    export ESP32_STREAM_URL=http://192.168.0.50/stream
    export SUPABASE_URL=https://sqxvkpavtwpglneamntd.supabase.co
    export SUPABASE_ANON_KEY=sb_publishable_...
    export DEVICE_USERNAME=billy
    export DEVICE_PASSWORD=billy##1108
    python activity_logger.py
"""

import os
import sys
import time
import math

import cv2
import requests
import mediapipe as mp

ESP32_STREAM_URL = os.environ.get("ESP32_STREAM_URL")
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY")
DEVICE_USERNAME = os.environ.get("DEVICE_USERNAME")
DEVICE_PASSWORD = os.environ.get("DEVICE_PASSWORD")

SAMPLE_INTERVAL_SEC = 60  # 이 주기마다 활동량을 계산해서 Supabase에 기록

REQUIRED_ENV = {
    "ESP32_STREAM_URL": ESP32_STREAM_URL,
    "SUPABASE_URL": SUPABASE_URL,
    "SUPABASE_ANON_KEY": SUPABASE_ANON_KEY,
    "DEVICE_USERNAME": DEVICE_USERNAME,
    "DEVICE_PASSWORD": DEVICE_PASSWORD,
}


def check_env():
    missing = [k for k, v in REQUIRED_ENV.items() if not v]
    if missing:
        print(f"환경변수가 안 채워져 있어요: {', '.join(missing)}")
        sys.exit(1)


def username_to_email(username: str) -> str:
    # 웹 프론트엔드(index.html)의 usernameToEmail()과 반드시 동일한 규칙이어야
    # 같은 계정으로 인식됩니다.
    cleaned = "".join(ch for ch in username.strip().lower() if ch.isalnum() or ch in "._-")
    return f"{cleaned}@gels.local"


def sign_in():
    """아이디/비밀번호로 로그인해서 access_token, refresh_token을 받아옵니다."""
    resp = requests.post(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
        headers={"apikey": SUPABASE_ANON_KEY, "Content-Type": "application/json"},
        json={"email": username_to_email(DEVICE_USERNAME), "password": DEVICE_PASSWORD},
        timeout=10,
    )
    resp.raise_for_status()
    data = resp.json()
    return data["access_token"], data["refresh_token"], data["user"]["id"]


def refresh_session(refresh_token):
    resp = requests.post(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=refresh_token",
        headers={"apikey": SUPABASE_ANON_KEY, "Content-Type": "application/json"},
        json={"refresh_token": refresh_token},
        timeout=10,
    )
    resp.raise_for_status()
    data = resp.json()
    return data["access_token"], data["refresh_token"]


def insert_sample(access_token, user_id, activity_level, posture):
    resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/activity_samples",
        headers={
            "apikey": SUPABASE_ANON_KEY,
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
        },
        json={
            "user_id": user_id,
            "activity_level": activity_level,
            "posture": posture,
        },
        timeout=10,
    )
    if resp.status_code >= 300:
        print(f"Supabase 기록 실패 ({resp.status_code}): {resp.text}")


# MediaPipe Pose의 랜드마크 인덱스 (공식 문서 기준)
LEFT_SHOULDER, RIGHT_SHOULDER = 11, 12
LEFT_HIP, RIGHT_HIP = 23, 24
LEFT_ANKLE, RIGHT_ANKLE = 27, 28


def estimate_posture(landmarks):
    """아주 단순한 자세 추정: 어깨~발목의 세로/가로 비율로 서있음/앉음(또는 누움)을 구분.
    정밀한 판정이 아니라, 활동 패턴 참고용 라벨입니다."""
    shoulder_y = (landmarks[LEFT_SHOULDER].y + landmarks[RIGHT_SHOULDER].y) / 2
    hip_y = (landmarks[LEFT_HIP].y + landmarks[RIGHT_HIP].y) / 2
    ankle_y = (landmarks[LEFT_ANKLE].y + landmarks[RIGHT_ANKLE].y) / 2

    vertical_span = abs(ankle_y - shoulder_y)
    hip_to_shoulder = abs(hip_y - shoulder_y)

    if vertical_span < 0.15:
        return "lying"  # 세로로 거의 안 퍼져있으면 누워있을 가능성
    if hip_to_shoulder < vertical_span * 0.35:
        return "sitting"
    return "standing"


def landmark_movement(prev, curr):
    """두 프레임 사이 주요 관절들의 이동 거리 합 (활동량 지표)"""
    if prev is None:
        return 0.0
    total = 0.0
    for idx in (LEFT_SHOULDER, RIGHT_SHOULDER, LEFT_HIP, RIGHT_HIP, LEFT_ANKLE, RIGHT_ANKLE):
        dx = curr[idx].x - prev[idx].x
        dy = curr[idx].y - prev[idx].y
        total += math.sqrt(dx * dx + dy * dy)
    return total


def main():
    check_env()

    print("Supabase 로그인 중...")
    access_token, refresh_token, user_id = sign_in()
    print(f"로그인 완료 (user_id={user_id})")

    print(f"ESP32 스트림 여는 중: {ESP32_STREAM_URL}")
    cap = cv2.VideoCapture(ESP32_STREAM_URL)
    if not cap.isOpened():
        print("스트림을 열 수 없어요. ESP32_STREAM_URL이 맞는지, 같은 네트워크인지 확인해주세요.")
        sys.exit(1)

    mp_pose = mp.solutions.pose
    pose = mp_pose.Pose(model_complexity=0, min_detection_confidence=0.5, min_tracking_confidence=0.5)

    prev_landmarks = None
    movement_accum = 0.0
    frame_count = 0
    last_posture = None
    window_start = time.time()
    token_issued_at = time.time()

    print("행동 패턴 수집 시작 (Ctrl+C로 종료)")

    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                print("프레임을 못 읽었어요. 재연결 시도...")
                time.sleep(2)
                cap.release()
                cap = cv2.VideoCapture(ESP32_STREAM_URL)
                continue

            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            result = pose.process(rgb)

            if result.pose_landmarks:
                landmarks = result.pose_landmarks.landmark
                movement_accum += landmark_movement(prev_landmarks, landmarks)
                prev_landmarks = landmarks
                last_posture = estimate_posture(landmarks)
                frame_count += 1

            now = time.time()

            # 액세스 토큰은 보통 1시간 후 만료되므로 50분마다 미리 갱신
            if now - token_issued_at > 50 * 60:
                access_token, refresh_token = refresh_session(refresh_token)
                token_issued_at = now
                print("Supabase 세션 갱신 완료")

            if now - window_start >= SAMPLE_INTERVAL_SEC:
                activity_level = movement_accum / frame_count if frame_count else 0.0
                insert_sample(access_token, user_id, activity_level, last_posture)
                print(f"기록: activity_level={activity_level:.4f}, posture={last_posture}")

                movement_accum = 0.0
                frame_count = 0
                window_start = now

    except KeyboardInterrupt:
        print("종료합니다.")
    finally:
        cap.release()
        pose.close()


if __name__ == "__main__":
    main()
