require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const { client: db, migrate } = require("./db");

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const app = express();
app.use(cors());
app.use(express.json());

/* ======================
   DB 헬퍼
====================== */
// libsql은 결과를 { rows, lastInsertRowid(BigInt), rowsAffected } 형태로 돌려줌
async function run(sql, args = []) {
  return db.execute({ sql, args });
}
async function get(sql, args = []) {
  const { rows } = await db.execute({ sql, args });
  return rows[0];
}
async function all(sql, args = []) {
  const { rows } = await db.execute({ sql, args });
  return rows;
}

function getUserById(id) {
  return get("SELECT id, username, display_name FROM users WHERE id = ?", [id]);
}

/* ======================
   인증
====================== */
function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: "30d" });
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "로그인이 필요합니다." });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "세션이 만료되었습니다. 다시 로그인해주세요." });
  }
}

// 라우트 핸들러의 rejected promise를 express 에러 핸들링으로 넘겨줌
function h(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

app.post(
  "/api/auth/signup",
  h(async (req, res) => {
    const { name, username, password } = req.body || {};
    if (!name || !username || !password) {
      return res.status(400).json({ error: "이름, 아이디, 비밀번호를 모두 입력하세요." });
    }

    const cleanedUsername = String(username).trim().toLowerCase().replace(/[^a-z0-9._-]/g, "");
    if (!cleanedUsername) {
      return res.status(400).json({ error: "사용할 수 있는 아이디가 아닙니다." });
    }

    const existing = await get("SELECT id FROM users WHERE username = ?", [cleanedUsername]);
    if (existing) {
      return res.status(409).json({ error: "이미 사용 중인 아이디입니다." });
    }

    const passwordHash = bcrypt.hashSync(password, 10);
    const info = await run(
      "INSERT INTO users (username, password_hash, display_name) VALUES (?, ?, ?)",
      [cleanedUsername, passwordHash, name]
    );

    const user = await getUserById(Number(info.lastInsertRowid));
    res.json({ token: signToken(user), user });
  })
);

app.post(
  "/api/auth/signin",
  h(async (req, res) => {
    const { username, password } = req.body || {};
    const cleanedUsername = String(username || "").trim().toLowerCase().replace(/[^a-z0-9._-]/g, "");

    const row = await get("SELECT * FROM users WHERE username = ?", [cleanedUsername]);
    if (!row || !bcrypt.compareSync(password || "", row.password_hash)) {
      return res.status(401).json({ error: "아이디 또는 비밀번호가 올바르지 않습니다." });
    }

    const user = await getUserById(row.id);
    res.json({ token: signToken(user), user });
  })
);

app.get(
  "/api/me",
  requireAuth,
  h(async (req, res) => {
    const user = await getUserById(req.user.id);
    if (!user) return res.status(401).json({ error: "사용자를 찾을 수 없습니다." });
    res.json({ user });
  })
);

/* ======================
   기저질환 서베이
====================== */
async function getHealthProfile(userId) {
  const row = await get("SELECT conditions, other_conditions FROM health_profiles WHERE user_id = ?", [userId]);
  if (!row) return null;
  return { conditions: JSON.parse(row.conditions || "[]"), other_conditions: row.other_conditions || "" };
}

// profile이 null이면 아직 서베이를 안 한 것
app.get(
  "/api/health-profile",
  requireAuth,
  h(async (req, res) => {
    res.json({ profile: await getHealthProfile(req.user.id) });
  })
);

app.put(
  "/api/health-profile",
  requireAuth,
  h(async (req, res) => {
    const { conditions, other_conditions } = req.body || {};
    const cleaned = (Array.isArray(conditions) ? conditions : [])
      .map((c) => String(c).trim().slice(0, 50))
      .filter(Boolean)
      .slice(0, 30);
    const other = String(other_conditions || "").trim().slice(0, 300);

    await run(
      `INSERT INTO health_profiles (user_id, conditions, other_conditions) VALUES (?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET conditions = excluded.conditions,
         other_conditions = excluded.other_conditions, updated_at = datetime('now')`,
      [req.user.id, JSON.stringify(cleaned), other]
    );

    res.json({ profile: { conditions: cleaned, other_conditions: other } });
  })
);

/* ======================
   활동량 기록 (하드웨어 로거)
====================== */
app.post(
  "/api/activity-samples",
  requireAuth,
  h(async (req, res) => {
    const { activity_level, posture } = req.body || {};
    if (typeof activity_level !== "number") {
      return res.status(400).json({ error: "activity_level(number)이 필요합니다." });
    }

    await run("INSERT INTO activity_samples (user_id, activity_level, posture) VALUES (?, ?, ?)", [
      req.user.id,
      activity_level,
      posture || null,
    ]);

    res.json({ ok: true });
  })
);

/* ======================
   AI 챗봇 (Gemini 프록시)
====================== */
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

// 답변 형식: 쉬운 말 + 증상 이야기면 ①~④ 순서. 음성으로도 읽어주므로 꾸밈 기호는 쓰지 않게 함
const CHAT_SYSTEM_PROMPT = `당신은 어르신을 돕는 다정한 AI 상담사입니다.

말투 규칙
- 어르신이 바로 알아들을 수 있는 쉬운 말과 존댓말로 답하세요.
- 어려운 의학 용어나 영어는 쓰지 마세요. 꼭 필요하면 쉬운 말로 풀어서 함께 말해 주세요.
- 문장은 짧게 쓰세요.
- 답변은 소리로도 읽어 드리므로 *, #, 표, 목록 기호 같은 꾸밈 기호는 쓰지 마세요.

몸이 아프거나 불편하다는 이야기에는 아래 순서와 번호를 그대로 지켜 답하세요. 번호마다 한두 문장만 쓰세요.
① 공감 한마디
② 왜 그럴 수 있는지 (병을 단정하지 말고 "~일 수 있어요"처럼 가능성으로)
③ 집에서 해 보실 수 있는 것
④ 이럴 때는 꼭 병원에 가세요

예시
질문: 허리가 좀 아파
답변:
① 허리가 아프시면 앉고 일어나실 때 많이 불편하시겠어요.
② 오래 앉아 계시거나 무거운 것을 드시면 허리 근육이 뭉쳐서 아플 수 있어요.
③ 따뜻한 수건으로 허리를 데워 주시고, 한 자리에 오래 앉아 계시지 말고 가끔 일어나 천천히 걸어 보세요.
④ 다리가 저리거나 힘이 빠지면, 또는 일주일이 지나도 낫지 않으면 꼭 정형외과에 가 보세요.

몸 상태와 상관없는 일상 이야기에는 번호 없이 짧고 다정하게 답하세요.`;

async function callGemini(payload) {
  const geminiRes = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return geminiRes.json();
}

/* ======================
   건강 기록 (PGHD 요약 리포트)
====================== */
// 리포트 항목 순서 = 화면 표시 순서
const REPORT_FIELDS = ["expression", "onset", "frequency", "aggravating", "impact", "comparison", "medication"];

// 메시지에서 리포트 항목을 추출. 같은 증상의 기존 리포트가 있으면 그 id를 돌려받아 누적함
async function extractHealthReport(text, existingReports) {
  const existing = existingReports.map((r) => ({ id: r.id, category: r.category, symptom: r.symptom }));

  try {
    const data = await callGemini({
      contents: [
        {
          role: "user",
          parts: [
            {
              text:
                "다음은 어르신 돌봄 AI 상담에 들어온 메시지입니다. 말한 사람은 어르신 본인일 수도, 보호자(가족 등)일 수도 있습니다.\n" +
                `메시지: "${text}"\n\n` +
                "이 메시지에 몸이 아프거나 불편한 증상 이야기가 있는지 판단하고, 있다면 PGHD(환자 생성 건강 데이터) 요약 리포트 항목을 채우세요.\n\n" +
                `이 사용자의 기존 리포트 목록: ${JSON.stringify(existing)}\n` +
                "- report_id: 같은 증상에 대한 기존 리포트가 있으면 그 id, 새 증상이면 null\n" +
                '- speaker: 어르신 본인이 자기 이야기를 하면 "본인", 보호자가 어르신에 대해 말하면 "보호자"\n' +
                "- category: 신체 계통 (예: 근골격계, 소화기계, 호흡기계, 순환기계, 신경계, 피부, 비뇨기계, 눈·귀, 정신건강, 기타)\n" +
                "- symptom: 증상 이름 (예: 허리 통증(요통))\n" +
                "- fields: 메시지에 실제로 나온 내용만 20자 안쪽으로 짧게 쓰고, 나오지 않은 항목은 빈 문자열로 두세요. 추측해서 채우지 마세요.\n" +
                '  expression(본인 표현: 증상을 말한 원래 말 그대로 짧게 인용), onset(시작 시점, 예: 약 1~2주 전 ("지난주부터")), ' +
                "frequency(빈도, 예: 거의 매일), aggravating(악화 상황, 예: 오래 앉아 있을 때), impact(생활 영향, 예: 밤에 자주 깸), " +
                "comparison(이전과 비교, 예: 지난달에도 유사 증상), medication(복용 약)\n\n" +
                "증상 이야기가 없으면 has_symptom을 false로 하세요. 아래 JSON 형식으로만 답하세요.\n" +
                '{"has_symptom": boolean, "report_id": number|null, "speaker": "본인"|"보호자", "category": string, "symptom": string, ' +
                '"fields": {"expression": string, "onset": string, "frequency": string, "aggravating": string, "impact": string, "comparison": string, "medication": string}}',
            },
          ],
        },
      ],
      generationConfig: { responseMimeType: "application/json" },
    });

    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (!parsed.has_symptom || !parsed.symptom) return null;

    const fields = {};
    for (const key of REPORT_FIELDS) {
      const value = String(parsed.fields?.[key] || "").trim().slice(0, 200);
      if (value) fields[key] = value;
    }

    return {
      reportId: existing.some((r) => r.id === parsed.report_id) ? parsed.report_id : null,
      speaker: parsed.speaker === "보호자" ? "보호자" : "본인",
      category: String(parsed.category || "기타").slice(0, 50),
      symptom: String(parsed.symptom).slice(0, 100),
      fields,
    };
  } catch (err) {
    console.error("증상 추출 실패:", err);
    return null;
  }
}

// 이번에 나온 항목만 덮어쓰고(출처 = 이번 화자), 대화 횟수를 1 늘림
async function saveHealthReport(userId, info, existingReports) {
  const target = existingReports.find((r) => r.id === info.reportId);
  const fields = target ? JSON.parse(target.fields || "{}") : {};

  for (const [key, value] of Object.entries(info.fields)) {
    fields[key] = { value, source: info.speaker };
  }

  if (target) {
    await run(
      `UPDATE health_reports SET fields = ?, conversation_count = conversation_count + 1, updated_at = datetime('now')
       WHERE id = ? AND user_id = ?`,
      [JSON.stringify(fields), target.id, userId]
    );
  } else {
    await run("INSERT INTO health_reports (user_id, category, symptom, fields) VALUES (?, ?, ?, ?)", [
      userId,
      info.category,
      info.symptom,
      JSON.stringify(fields),
    ]);
  }
}

app.post(
  "/api/ai-chat",
  requireAuth,
  h(async (req, res) => {
    const { text } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "text가 필요합니다." });
    }

    if (!GEMINI_API_KEY) {
      return res.json({
        answer:
          "(안내) 서버에 GEMINI_API_KEY가 설정되어 있지 않아 실제 AI 응답 대신 이 안내 문구를 보여드립니다. " +
          "server/.env에 GEMINI_API_KEY를 설정하면 실제 응답을 받을 수 있습니다.",
      });
    }

    // 서베이에서 받은 기저질환을 알려줘서 답변에 반영 (예: 당뇨가 있으면 단 음식 주의)
    let systemPrompt = CHAT_SYSTEM_PROMPT;
    const profile = await getHealthProfile(req.user.id);
    const knownConditions = profile
      ? [...profile.conditions, profile.other_conditions].filter(Boolean).join(", ")
      : "";
    if (knownConditions) {
      systemPrompt +=
        `\n\n이 어르신이 이미 앓고 계신 질환: ${knownConditions}\n` +
        "답할 때 이 질환을 고려해서, 조심해야 할 점이 있으면 쉬운 말로 함께 알려 드리세요.";
    }

    try {
      const data = await callGemini({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text }] }],
      });

      if (data.error) {
        return res.status(502).json({ error: data.error.message });
      }

      const answer = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      res.json({ answer: answer || "응답을 생성하지 못했습니다." });
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }

    // 응답을 보낸 뒤 백그라운드로 증상 추출·저장 (실패해도 사용자 응답에는 영향 없음)
    try {
      const existingReports = await all(
        "SELECT id, category, symptom, fields FROM health_reports WHERE user_id = ?",
        [req.user.id]
      );
      const info = await extractHealthReport(text, existingReports);
      if (info) await saveHealthReport(req.user.id, info, existingReports);
    } catch (err) {
      console.error("건강 기록 저장 실패:", err);
    }
  })
);

app.get(
  "/api/health-reports",
  requireAuth,
  h(async (req, res) => {
    const rows = await all(
      `SELECT id, category, symptom, fields, conversation_count, updated_at
       FROM health_reports WHERE user_id = ? ORDER BY updated_at DESC`,
      [req.user.id]
    );
    const reports = rows.map((r) => ({ ...r, fields: JSON.parse(r.fields || "{}") }));
    res.json({ reports });
  })
);

app.delete(
  "/api/health-reports/:id",
  requireAuth,
  h(async (req, res) => {
    const report = await get("SELECT user_id FROM health_reports WHERE id = ?", [req.params.id]);
    if (!report) return res.status(404).json({ error: "기록을 찾을 수 없습니다." });
    if (report.user_id !== req.user.id) {
      return res.status(403).json({ error: "본인 기록만 삭제할 수 있습니다." });
    }

    await run("DELETE FROM health_reports WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  })
);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "서버 오류가 발생했습니다." });
});

migrate()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`gels 백엔드 서버 실행 중: http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("DB 초기화 실패:", err);
    process.exit(1);
  });
