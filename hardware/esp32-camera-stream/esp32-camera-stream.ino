/*
  ESP32-S3 카메라 MJPEG 스트리밍 서버 (Seeed Studio XIAO ESP32S3 Sense 기준)
  ------------------------------------------------------------------------
  고령자 AI 케어 프로젝트 — 행동 분석용 영상을 같은 네트워크의
  라즈베리파이로 전송하기 위한 펌웨어입니다.

  라즈베리파이(activity_logger.py)가 http://<이 보드의 IP>/stream 으로
  접속하면 MJPEG(연속 JPEG) 스트림을 받아갈 수 있습니다.

  ⚠ 실제 보드에 업로드해서 테스트해본 적은 없습니다 (원격 코드 작성만 가능).
  Espressif의 공식 CameraWebServer 예제와 동일한 구조(esp_http_server 기반)로
  작성했지만, 실제 동작 확인은 직접 해주셔야 합니다.

  Arduino IDE 설정 (XIAO ESP32S3 Sense 기준):
  - 보드 매니저에서 "esp32" (Espressif) 설치
  - Tools > Board: "XIAO_ESP32S3"
  - Tools > PSRAM: "OPI PSRAM" (반드시 켜야 함 — 안 켜면 카메라 초기화 실패)
  - 아래 WIFI_SSID / WIFI_PASSWORD 를 실제 값(라즈베리파이와 같은 네트워크)으로 변경
  - 카메라 보드 자체를 XIAO 본체에 꽂아야 함 (Sense 확장보드에 카메라 모듈 연결)
*/

#include "esp_camera.h"
#include "esp_http_server.h"
#include <WiFi.h>

// ===== 여기를 사용자 환경에 맞게 수정하세요 =====
const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
// ================================================

// Seeed Studio XIAO ESP32S3 Sense 카메라 핀맵
// (다른 보드로 바꾸면 이 부분을 그 보드의 camera_pins.h 값으로 교체해야 함)
#define PWDN_GPIO_NUM     -1
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM     10
#define SIOD_GPIO_NUM     40
#define SIOC_GPIO_NUM     39
#define Y9_GPIO_NUM       48
#define Y8_GPIO_NUM       11
#define Y7_GPIO_NUM       12
#define Y6_GPIO_NUM       14
#define Y5_GPIO_NUM       16
#define Y4_GPIO_NUM       18
#define Y3_GPIO_NUM       17
#define Y2_GPIO_NUM       15
#define VSYNC_GPIO_NUM    38
#define HREF_GPIO_NUM     47
#define PCLK_GPIO_NUM     13

httpd_handle_t cameraServer = NULL;

static esp_err_t streamHandler(httpd_req_t *req){
    camera_fb_t *fb = NULL;
    esp_err_t res = ESP_OK;
    char partBuf[64];

    static const char *STREAM_CONTENT_TYPE = "multipart/x-mixed-replace;boundary=frame";
    static const char *STREAM_BOUNDARY = "\r\n--frame\r\n";
    static const char *STREAM_PART = "Content-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n";

    res = httpd_resp_set_type(req, STREAM_CONTENT_TYPE);
    if(res != ESP_OK) return res;

    while(true){
        fb = esp_camera_fb_get();
        if(!fb){
            Serial.println("프레임 캡처 실패");
            res = ESP_FAIL;
        }else if(fb->format != PIXFORMAT_JPEG){
            Serial.println("JPEG 포맷이 아님");
            esp_camera_fb_return(fb);
            res = ESP_FAIL;
        }

        if(res == ESP_OK){
            size_t hlen = snprintf(partBuf, sizeof(partBuf), STREAM_PART, fb->len);
            res = httpd_resp_send_chunk(req, partBuf, hlen);
        }
        if(res == ESP_OK){
            res = httpd_resp_send_chunk(req, (const char *)fb->buf, fb->len);
        }
        if(fb) esp_camera_fb_return(fb);
        if(res == ESP_OK){
            res = httpd_resp_send_chunk(req, STREAM_BOUNDARY, strlen(STREAM_BOUNDARY));
        }

        if(res != ESP_OK) break; // 클라이언트(라즈베리파이) 연결이 끊기면 루프 종료
    }
    return res;
}

void startCameraServer(){
    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.server_port = 80;
    config.ctrl_port = 32768;

    httpd_uri_t streamUri = {
        .uri = "/stream",
        .method = HTTP_GET,
        .handler = streamHandler,
        .user_ctx = NULL
    };

    if(httpd_start(&cameraServer, &config) == ESP_OK){
        httpd_register_uri_handler(cameraServer, &streamUri);
    }else{
        Serial.println("HTTP 서버 시작 실패");
    }
}

void startCamera(){
    camera_config_t config;
    config.ledc_channel = LEDC_CHANNEL_0;
    config.ledc_timer   = LEDC_TIMER_0;
    config.pin_d0       = Y2_GPIO_NUM;
    config.pin_d1       = Y3_GPIO_NUM;
    config.pin_d2       = Y4_GPIO_NUM;
    config.pin_d3       = Y5_GPIO_NUM;
    config.pin_d4       = Y6_GPIO_NUM;
    config.pin_d5       = Y7_GPIO_NUM;
    config.pin_d6       = Y8_GPIO_NUM;
    config.pin_d7       = Y9_GPIO_NUM;
    config.pin_xclk     = XCLK_GPIO_NUM;
    config.pin_pclk     = PCLK_GPIO_NUM;
    config.pin_vsync    = VSYNC_GPIO_NUM;
    config.pin_href     = HREF_GPIO_NUM;
    config.pin_sccb_sda = SIOD_GPIO_NUM;
    config.pin_sccb_scl = SIOC_GPIO_NUM;
    config.pin_pwdn      = PWDN_GPIO_NUM;
    config.pin_reset    = RESET_GPIO_NUM;
    config.xclk_freq_hz = 20000000;
    config.pixel_format = PIXFORMAT_JPEG;

    // XIAO ESP32S3 Sense는 PSRAM(OPI PSRAM 옵션)을 켜야 카메라가 동작함.
    // 혹시 꺼져있는 상태로 올리면 여기서 자동으로 더 작은 해상도로 낮춰서
    // 최소한 동작은 하도록 안전장치를 둠 (권장: PSRAM 켜고 VGA로 사용).
    if(psramFound()){
        config.frame_size   = FRAMESIZE_VGA; // 640x480 — 라즈베리파이 자세 분석에 적당한 크기
        config.jpeg_quality = 12;
        config.fb_count     = 2;
        config.fb_location  = CAMERA_FB_IN_PSRAM;
    }else{
        Serial.println("⚠ PSRAM이 감지되지 않았어요. Tools > PSRAM을 OPI PSRAM으로 켜주세요.");
        config.frame_size   = FRAMESIZE_QVGA; // 320x240로 축소해서 DRAM만으로 동작 시도
        config.jpeg_quality = 15;
        config.fb_count     = 1;
        config.fb_location  = CAMERA_FB_IN_DRAM;
    }

    esp_err_t err = esp_camera_init(&config);
    if(err != ESP_OK){
        Serial.printf("카메라 초기화 실패: 0x%x\n", err);
        while(true) delay(1000);
    }
}

void setup(){
    Serial.begin(115200);
    delay(500);

    startCamera();

    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    Serial.print("WiFi 연결 중");
    while(WiFi.status() != WL_CONNECTED){
        delay(500);
        Serial.print(".");
    }
    Serial.println();

    startCameraServer();

    Serial.print("카메라 스트림 주소: http://");
    Serial.print(WiFi.localIP());
    Serial.println("/stream");
    Serial.println("이 주소를 라즈베리파이 activity_logger.py의 ESP32_STREAM_URL에 넣어주세요.");
}

void loop(){
    delay(10000); // 서버는 백그라운드(httpd)에서 자체적으로 처리되므로 loop는 비워둠
}
