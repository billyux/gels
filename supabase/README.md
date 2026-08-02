# Supabase 설정 메모

프로젝트 ref: `sqxvkpavtwpglneamntd`

## DB 마이그레이션 적용
```
supabase db push --project-ref sqxvkpavtwpglneamntd
```

## Edge Function 배포
```
supabase functions deploy ai-chat --project-ref sqxvkpavtwpglneamntd
supabase functions deploy shelters --project-ref sqxvkpavtwpglneamntd
```

### shelters 함수 (무더위쉼터 지도)
국민재난안전포털(safekorea.go.kr)의 시설안전지도 페이지가 내부적으로 호출하는 공개
엔드포인트(`facilityDataList.do`)를 그대로 프록시합니다. 로그인/인증키가 필요 없는 공개
데이터라 별도 API 키 발급 없이 바로 씁니다. 기본값은 부산진구(`sggCd=26230`) — 다른 지역을
보려면 국민안전24 지도 페이지에서 `/data/map/sgg/{시도코드}.json`으로 시군구 코드를 확인해서
`shelters?sggCd=<코드>`로 호출하면 됩니다.

이 API는 우리가 소유한 게 아니라 형식이 예고 없이 바뀔 수 있습니다 — 응답이 깨지면
`facilityDataList.do` 요청 파라미터(tableNm, sggCd, size)와 응답 필드(la/lo가 위도/경도)를
다시 확인하세요.

## 필수 secret
Gemini API 키를 Edge Function에서 쓸 수 있도록 등록해야 합니다 (git에는 절대 커밋하지 않음).
```
supabase secrets set GEMINI_API_KEY=<키> --project-ref sqxvkpavtwpglneamntd
```

## Auth 설정 (대시보드/Management API로 수동 설정, migration에 안 잡힘)
노인 사용자는 이메일/전화번호 인증 자체가 번거로워서, 최종적으로 **아이디 + 비밀번호** 방식으로 정착했습니다.
Supabase Auth는 로그인 식별자로 email 또는 phone만 지원하므로, 프론트엔드(`index.html`)에서 입력받은
아이디를 `아이디@gels.local` 형식의 가짜 이메일로 변환해서 내부적으로만 사용합니다 (실제 메일 발송 없음).

Supabase 대시보드 > Authentication > Providers > Email 에서:
- **Confirm email**: off (`mailer_autoconfirm = true`) — 가짜 도메인이라 인증 메일을 받을 수 없으므로 반드시 꺼야 함

회원가입(`signUp`) 성공 시 Supabase가 세션을 즉시 내려주므로, 별도로 로그인 버튼을 누를 필요 없이
그대로 대시보드로 진입합니다 (`enterApp()` 자동 호출).

Phone provider(`external_phone_enabled`, `sms_autoconfirm`)는 이전 시도의 흔적으로 켜져 있지만
현재 프론트엔드는 사용하지 않습니다. 안 쓰면 대시보드에서 꺼도 무방합니다.

이미 이 프로젝트(`sqxvkpavtwpglneamntd`)에는 `mailer_autoconfirm=true`가 적용되어 있습니다.
새 프로젝트로 옮길 경우 위 옵션을 꼭 다시 켜주세요.
