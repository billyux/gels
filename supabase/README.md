# Supabase 설정 메모

프로젝트 ref: `sqxvkpavtwpglneamntd`

## DB 마이그레이션 적용
```
supabase db push --project-ref sqxvkpavtwpglneamntd
```

## Edge Function 배포
```
supabase functions deploy ai-chat --project-ref sqxvkpavtwpglneamntd
```

## 필수 secret
Gemini API 키를 Edge Function에서 쓸 수 있도록 등록해야 합니다 (git에는 절대 커밋하지 않음).
```
supabase secrets set GEMINI_API_KEY=<키> --project-ref sqxvkpavtwpglneamntd
```

## Auth 설정 (대시보드/Management API로 수동 설정, migration에 안 잡힘)
노인 사용자는 이메일이 없는 경우가 많아 이메일 대신 전화번호+비밀번호 로그인을 사용합니다.
Supabase 대시보드 > Authentication > Providers > Phone 에서:
- **Enable Phone provider**: on
- **Confirm phone number**: off (SMS 발송 없이 즉시 가입/로그인되도록 — 별도 SMS 프로바이더(Twilio 등) 비용 없이 사용하기 위함)

이미 이 프로젝트(`sqxvkpavtwpglneamntd`)에는 적용되어 있습니다. 새 프로젝트로 옮길 경우 위 두 옵션을 꼭 다시 켜주세요.
