# ESP32 카메라 + 라즈베리파이 행동 패턴 수집 (프로토타입)

⚠️ **아래 코드는 원격으로 작성만 했고, 실제 보드/라즈베리파이에 올려서 동작을
확인해본 적이 없습니다.** ESP32 카메라 스트리밍과 MediaPipe Pose 둘 다
표준적으로 잘 알려진 방법으로 작성했지만, 실제 하드웨어에서의 동작 확인·
디버깅은 직접 해주셔야 합니다. "완성"이 아니라 가능성을 보기 위한
프로토타입입니다.

## 전체 흐름

```
[ESP32-S3 카메라] --MJPEG 스트림(HTTP)--> [라즈베리파이] --MediaPipe Pose 분석-->
  --활동량/자세 계산(1분 단위)--> [Supabase activity_samples 테이블] --> [웹 대시보드]
```

## 1) ESP32-S3 (Seeed Studio XIAO ESP32S3 Sense): `esp32-camera-stream/esp32-camera-stream.ino`

1. Arduino IDE에 ESP32 보드 패키지 설치 (파일 > 환경설정 > 추가 보드 매니저 URL에
   `https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json` 추가 후,
   보드 매니저에서 "esp32" 설치)
2. **Tools > Board**: "XIAO_ESP32S3" 선택
3. **Tools > PSRAM**: 반드시 **"OPI PSRAM"으로 켜기** — 안 켜면 카메라 초기화가
   실패합니다 (Seeed 공식 문서에서도 필수라고 안내함)
4. 스케치 상단의 `WIFI_SSID`, `WIFI_PASSWORD`를 실제 값(라즈베리파이와 같은
   네트워크/핫스팟)으로 수정
5. 카메라 모듈이 XIAO 본체의 커넥터에 정확히 꽂혀있는지 확인 (Sense 확장보드에
   카메라 리본 케이블 연결)
6. 업로드 후 시리얼 모니터(115200bps)에서 출력되는 IP 주소를 확인하세요.
   예: `카메라 스트림 주소: http://192.168.0.50/stream`
   - "PSRAM이 감지되지 않았어요" 로그가 뜨면 3번의 PSRAM 설정이 안 된 것이니
     다시 확인해주세요 (그래도 일단 더 낮은 해상도로 동작은 시도합니다)

## 2) 라즈베리파이: `raspberrypi-activity-logger/activity_logger.py`

```bash
cd hardware/raspberrypi-activity-logger
pip install -r requirements.txt

export ESP32_STREAM_URL=http://192.168.0.50/stream   # 1번에서 확인한 주소
export SUPABASE_URL=https://sqxvkpavtwpglneamntd.supabase.co
export SUPABASE_ANON_KEY=sb_publishable_nEam_xtX_VDlCBgABD4-4g_LTiVBK8i
export DEVICE_USERNAME=billy       # 대시보드 로그인 아이디
export DEVICE_PASSWORD=본인비밀번호

python activity_logger.py
```

- 라즈베리파이가 **대시보드에 로그인할 때 쓰는 것과 같은 계정**으로 로그인해서
  데이터를 기록합니다. 그래야 웹 대시보드에서 본인 데이터로 보여요.
- 비밀번호를 코드에 직접 적지 말고 항상 환경변수로 넘겨주세요 (터미널 기록에도
  남지 않게 하려면 `.env` 파일 + `python-dotenv` 사용을 추천).
- 1분마다 그 사이의 평균 움직임량(`activity_level`)과 마지막으로 판별된 자세
  (`posture`: standing/sitting/lying)를 Supabase `activity_samples` 테이블에
  기록합니다.
- MediaPipe Pose를 라즈베리파이 CPU만으로 돌리기 때문에 모델 성능(`model_complexity=0`,
  가장 가벼운 모델)을 낮춰뒀습니다. 라즈베리파이 사양에 따라 프레임 처리 속도가
  느릴 수 있어요 — 실제로 돌려보고 너무 느리면 ESP32 쪽 해상도(`FRAMESIZE_VGA`)를
  더 낮추는 것도 방법입니다.

## 3) 확인 방법

- 라즈베리파이 실행 로그에 `기록: activity_level=..., posture=...` 가 1분마다 찍히면 정상
- Supabase 대시보드(테이블 편집기)에서 `activity_samples` 테이블에 실시간으로 행이
  쌓이는지 확인
- 이 데이터가 최소 1주일 정도 쌓이면, 웹 대시보드 쪽에 "시간대별 평소 활동량
  기준선 계산 + 이상 감지 알림" 기능을 이어서 붙일 수 있습니다 (다음 단계).

## 문제 해결

- **스트림이 안 열림**: ESP32와 라즈베리파이가 같은 와이파이 네트워크에
  있는지, 방화벽이 80번 포트를 막고 있지 않은지 확인
- **MediaPipe 설치 실패**: 라즈베리파이 OS/Python 버전에 따라 mediapipe가
  아직 지원 안 되는 조합일 수 있습니다. 그 경우 Python 버전을 mediapipe가
  지원하는 버전(보통 3.9~3.11)으로 맞춰야 할 수 있어요.
- **로그인 실패**: `DEVICE_USERNAME`/`DEVICE_PASSWORD`가 실제 대시보드
  계정과 일치하는지, 그리고 그 계정이 이미 한 번 웹에서 가입되어 있는지 확인
