# 건강 기록 리포트 기능

## 목적
AI 상담 중 사용자가 몸이 아프다고 말할 때, 단순히 "병원 가보세요" 식으로 끝내지 않고
증상·추정 병명·적합한 진료과를 따로 기록해서, 나중에 병원 검진·검사 때 참고할 수 있는
보고서로 제공한다.

## 동작 흐름
1. 사용자가 AI 채팅(`/api/ai-chat`)에 메시지를 보낸다.
2. 서버는 기존처럼 Gemini로 대화형 답변을 생성해 사용자에게 응답한다.
3. 응답과 별개로, 서버는 같은 메시지를 Gemini에 다시 보내 다음을 판단시킨다.
   - 이 메시지에 증상 언급이 있는가 (`has_symptom`)
   - 있다면: 증상 요약(`symptom`), 추정 가능한 병명(`possible_condition`, 확진 아님을 전제),
     적합한 진료과(`department`: 내과/외과/정형외과/신경과/이비인후과/안과/피부과/치과/
     비뇨의학과/산부인과/정신건강의학과 등 중 AI가 판단)
4. 증상 언급이 있었던 경우에만 `health_logs` 테이블에 기록한다 (일상 대화는 기록 안 함).
5. 사용자는 사이트의 "건강 기록" 화면에서 진료과별로 묶인 기록 목록을 보고,
   인쇄/PDF 저장 버튼으로 병원 방문 시 들고 갈 보고서를 출력할 수 있다.

## 데이터 모델 (`server/db.js`)
```
health_logs
  id                  INTEGER PK
  user_id             INTEGER FK -> users.id
  message             TEXT   -- 사용자가 보낸 원문 메시지
  symptom             TEXT   -- AI가 요약한 증상
  possible_condition  TEXT   -- AI가 추정한 병명/질환 (확진 아님)
  department          TEXT   -- AI가 판단한 진료과
  created_at          TEXT   -- 기록 시각
```

## 백엔드 API (`server/server.js`) — 완료
- `POST /api/ai-chat` : 기존 대화 응답 + 백그라운드로 증상 추출·저장
- `GET /api/health-logs` : 로그인한 사용자의 기록 전체 조회 (최신순)
- `DELETE /api/health-logs/:id` : 잘못 기록된 항목 삭제 (본인 것만)

## 프론트엔드 (`index.html`) — 예정
- 사이드바에 "🩺 건강 기록" 메뉴 추가
- 새 화면(`health-screen`): `GET /api/health-logs` 호출 후 진료과별로 그룹핑해서 표로 표시
  - 컬럼: 날짜, 말씀하신 내용, 증상, 추정 병명, 관리(삭제)
  - 진료과 소제목으로 구분 (예: "내과", "정형외과" ...)
- "🖨️ 인쇄 / PDF 저장" 버튼 → `window.print()` + 인쇄 시 사이드바/다른 화면 숨기는 `@media print` 스타일
- 기록이 없을 때 안내 문구 ("아직 기록된 증상이 없어요")

## 진행 상태
- [x] DB 스키마 (`health_logs`)
- [x] `/api/ai-chat` 증상 추출·저장 로직
- [x] `GET /api/health-logs`, `DELETE /api/health-logs/:id`
- [ ] 프론트엔드 화면 (목록 + 진료과별 그룹 + 인쇄)
- [ ] 사이드바 메뉴 연결
