# 건강 기록 (PGHD 요약 리포트)

## 목적
AI 상담 중 어르신(또는 보호자)이 몸이 불편하다고 말한 내용을 증상별 PGHD(환자 생성 건강 데이터)
요약 리포트로 모아서, 병원 방문·검진 때 의료진에게 보여줄 수 있게 한다.

## 동작 흐름
1. 사용자가 AI 채팅(`/api/ai-chat`)에 메시지를 보낸다.
2. 서버는 `CHAT_SYSTEM_PROMPT`(쉬운 말, 증상 이야기면 ①공감 ②원인 ③집에서 할 것 ④병원 갈 때)로
   Gemini 답변을 만들어 바로 응답한다.
3. 응답과 별개로, 서버는 같은 메시지와 이 사용자의 기존 리포트 목록을 Gemini에 보내 다음을 판단시킨다.
   - 증상 이야기가 있는지, 있다면 기존 리포트 중 같은 증상이 있는지(`report_id`)
   - 말한 사람이 본인인지 보호자인지(`speaker`)
   - 신체 계통(`category`), 증상 이름(`symptom`)
   - 메시지에 실제로 나온 리포트 항목(아래 7개). 나오지 않은 항목은 비워 둔다.
4. 같은 증상 리포트가 있으면 새로 나온 항목만 덮어쓰고(출처 = 이번 화자) `conversation_count`를 1 늘린다.
   없으면 새 리포트를 만든다.
5. "건강 기록" 화면에서 증상별 카드로 보여주고, 인쇄/PDF 저장할 수 있다.

## 리포트 항목
| key | 화면 라벨 | 예시 |
|---|---|---|
| expression | 본인 표현 | "허리가 좀 아파" |
| onset | 시작 | 약 1~2주 전 ("지난주부터") |
| frequency | 빈도 | 거의 매일 |
| aggravating | 악화 상황 | 오래 앉아 있을 때 |
| impact | 생활 영향 | 밤에 자주 깸 |
| comparison | 이전과 비교 | 지난달에도 유사 증상 |
| medication | 복용 약 | (없으면 "미확인") |

각 항목 옆 배지는 그 내용을 말한 사람(본인 / 보호자)이다.

## 데이터 모델 (`server/db.js`)
```
health_reports
  id                  INTEGER PK
  user_id             INTEGER FK -> users.id
  category            TEXT   -- 신체 계통 (예: 근골격계)
  symptom             TEXT   -- 증상 이름 (예: 허리 통증(요통))
  fields              TEXT   -- JSON: { [key]: { value, source: "본인" | "보호자" } }
  conversation_count  INTEGER -- 이 증상이 언급된 대화 수
  created_at, updated_at
```
이전 버전의 `health_logs` 테이블은 더 이상 쓰지 않는다 (기존 데이터는 DB에 남아 있음).

## 기저질환 서베이
가입 직후(또는 아직 서베이를 안 한 기존 회원이 로그인할 때) 이미 앓고 있는 질환을 고르는 화면이 나온다.
고혈압·당뇨병 등 15개 선택지 + "없음" + 기타 질환 직접 입력. "나중에 할게요"로 건너뛰면 다음 로그인 때 다시 묻는다.
설정 화면과 건강 기록 화면의 "앓고 있는 질환" 카드에서 수정할 수 있다.

- 저장한 질환은 AI 상담 시스템 프롬프트에 붙여서 답변에 반영한다 (예: 당뇨가 있으면 주의점 안내).
- 건강 기록 화면 맨 위에 표시되어 리포트와 함께 인쇄된다.

```
health_profiles
  user_id           INTEGER PK FK -> users.id   -- 행이 있으면 서베이 완료
  conditions        TEXT   -- JSON 배열 (예: ["고혈압", "당뇨병"]), "없음"이면 []
  other_conditions  TEXT   -- 직접 입력한 기타 질환
  updated_at        TEXT
```

## 백엔드 API (`server/server.js`)
- `GET /api/health-profile` : 서베이 결과 (`profile: null`이면 아직 안 함)
- `PUT /api/health-profile` : 서베이 저장·수정
- `POST /api/ai-chat` : 대화 응답 + 백그라운드로 리포트 추출·누적
- `GET /api/health-reports` : 로그인한 사용자의 리포트 전체 (최근 갱신순)
- `DELETE /api/health-reports/:id` : 리포트 삭제 (본인 것만)
