require("dotenv").config();

const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
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
   업로드 (게시글 이미지)
====================== */
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use("/uploads", express.static(uploadsDir));

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const userDir = path.join(uploadsDir, String(req.user.id));
    fs.mkdirSync(userDir, { recursive: true });
    cb(null, userDir);
  },
  filename(req, file, cb) {
    cb(null, `${Date.now()}_${file.originalname}`);
  },
});
const upload = multer({ storage });

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
   출석
====================== */
app.get(
  "/api/attendance",
  requireAuth,
  h(async (req, res) => {
    const { start, end } = req.query;
    const rows = await all(
      "SELECT attended_on FROM attendance WHERE user_id = ? AND attended_on BETWEEN ? AND ?",
      [req.user.id, start || "0000-01-01", end || "9999-12-31"]
    );
    res.json({ rows });
  })
);

app.post(
  "/api/attendance",
  requireAuth,
  h(async (req, res) => {
    const attendedOn = (req.body && req.body.attended_on) || new Date().toISOString().slice(0, 10);
    await run(
      `INSERT INTO attendance (user_id, attended_on) VALUES (?, ?)
       ON CONFLICT (user_id, attended_on) DO NOTHING`,
      [req.user.id, attendedOn]
    );
    res.json({ ok: true, attended_on: attendedOn });
  })
);

/* ======================
   게시판
====================== */
app.get(
  "/api/posts",
  requireAuth,
  h(async (req, res) => {
    const posts = await all(
      `SELECT posts.id, posts.title, posts.content, posts.image_url, posts.views,
              posts.created_at, posts.user_id, users.display_name
       FROM posts JOIN users ON users.id = posts.user_id
       ORDER BY posts.created_at DESC, posts.id DESC`
    );
    res.json({ posts });
  })
);

app.post(
  "/api/posts",
  requireAuth,
  upload.single("image"),
  h(async (req, res) => {
    const { title, content } = req.body || {};
    if (!title || !content) {
      return res.status(400).json({ error: "제목과 내용을 입력하세요." });
    }

    const imageUrl = req.file ? `/uploads/${req.user.id}/${req.file.filename}` : null;

    const info = await run(
      "INSERT INTO posts (user_id, title, content, image_url) VALUES (?, ?, ?, ?)",
      [req.user.id, title, content, imageUrl]
    );

    res.json({ id: Number(info.lastInsertRowid) });
  })
);

app.get(
  "/api/posts/:id",
  requireAuth,
  h(async (req, res) => {
    const post = await get(
      `SELECT posts.*, users.display_name FROM posts
       JOIN users ON users.id = posts.user_id
       WHERE posts.id = ?`,
      [req.params.id]
    );

    if (!post) return res.status(404).json({ error: "게시글을 찾을 수 없습니다." });

    await run("UPDATE posts SET views = views + 1 WHERE id = ?", [req.params.id]);
    post.views += 1;

    res.json({ post });
  })
);

app.delete(
  "/api/posts/:id",
  requireAuth,
  h(async (req, res) => {
    const post = await get("SELECT user_id FROM posts WHERE id = ?", [req.params.id]);
    if (!post) return res.status(404).json({ error: "게시글을 찾을 수 없습니다." });
    if (post.user_id !== req.user.id) {
      return res.status(403).json({ error: "본인 글만 삭제할 수 있습니다." });
    }

    await run("DELETE FROM posts WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  })
);

/* ======================
   물 섭취 기록
====================== */
app.get(
  "/api/water-log/today",
  requireAuth,
  h(async (req, res) => {
    const today = new Date().toISOString().slice(0, 10);
    const row = await get("SELECT cups FROM water_log WHERE user_id = ? AND logged_on = ?", [
      req.user.id,
      today,
    ]);
    res.json({ cups: row?.cups || 0 });
  })
);

app.post(
  "/api/water-log/increment",
  requireAuth,
  h(async (req, res) => {
    const date = (req.body && req.body.logged_on) || new Date().toISOString().slice(0, 10);

    await run(
      `INSERT INTO water_log (user_id, logged_on, cups) VALUES (?, ?, 1)
       ON CONFLICT (user_id, logged_on)
       DO UPDATE SET cups = cups + 1, updated_at = datetime('now')`,
      [req.user.id, date]
    );

    const row = await get("SELECT cups FROM water_log WHERE user_id = ? AND logged_on = ?", [
      req.user.id,
      date,
    ]);

    res.json({ cups: row.cups });
  })
);

app.get(
  "/api/water-log",
  requireAuth,
  h(async (req, res) => {
    const { start, end } = req.query;
    const rows = await all(
      "SELECT logged_on, cups FROM water_log WHERE user_id = ? AND logged_on BETWEEN ? AND ?",
      [req.user.id, start || "0000-01-01", end || "9999-12-31"]
    );
    res.json({ rows });
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

// 사용자 메시지에 증상 언급이 있으면 증상/추정 병명/진료과를 JSON으로 추출
async function extractHealthInfo(text) {
  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  text:
                    "다음은 고령자가 AI 상담사에게 보낸 메시지입니다. " +
                    "이 메시지에 몸이 아프거나 불편한 증상(통증, 어지러움, 소화불량 등)에 대한 언급이 있는지 판단하세요.\n\n" +
                    `메시지: "${text}"\n\n` +
                    "증상 언급이 있다면 symptom(증상 요약), possible_condition(추정 가능한 병명·질환, 확진 아님을 전제로 가능성만), " +
                    "department(가장 적합한 진료과 하나. 예: 내과, 외과, 정형외과, 신경과, 이비인후과, 안과, 피부과, 치과, 비뇨의학과, 산부인과, 정신건강의학과 중 선택하거나 그 외 적절한 과)를 채우고, " +
                    "증상 언급이 없다면 has_symptom을 false로 하고 나머지는 빈 문자열로 두세요. " +
                    "아래 JSON 형식으로만 답하세요.\n" +
                    '{"has_symptom": boolean, "symptom": string, "possible_condition": string, "department": string}',
                },
              ],
            },
          ],
          generationConfig: { responseMimeType: "application/json" },
        }),
      }
    );

    const data = await geminiRes.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (!parsed.has_symptom || !parsed.symptom) return null;

    return {
      symptom: String(parsed.symptom).slice(0, 500),
      possible_condition: String(parsed.possible_condition || "").slice(0, 500),
      department: String(parsed.department || "").slice(0, 100),
    };
  } catch (err) {
    console.error("증상 추출 실패:", err);
    return null;
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

    try {
      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts: [{ text: `친절한 고령자 AI 상담사입니다. 쉬운 말로 답해주세요. 질문: ${text}` }],
              },
            ],
          }),
        }
      );

      const data = await geminiRes.json();
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
      const healthInfo = await extractHealthInfo(text);
      if (healthInfo) {
        await run(
          "INSERT INTO health_logs (user_id, message, symptom, possible_condition, department) VALUES (?, ?, ?, ?, ?)",
          [req.user.id, text, healthInfo.symptom, healthInfo.possible_condition, healthInfo.department]
        );
      }
    } catch (err) {
      console.error("건강 기록 저장 실패:", err);
    }
  })
);

/* ======================
   건강 기록 (증상 리포트)
====================== */
app.get(
  "/api/health-logs",
  requireAuth,
  h(async (req, res) => {
    const rows = await all(
      "SELECT id, message, symptom, possible_condition, department, created_at FROM health_logs WHERE user_id = ? ORDER BY created_at DESC",
      [req.user.id]
    );
    res.json({ logs: rows });
  })
);

app.delete(
  "/api/health-logs/:id",
  requireAuth,
  h(async (req, res) => {
    const log = await get("SELECT user_id FROM health_logs WHERE id = ?", [req.params.id]);
    if (!log) return res.status(404).json({ error: "기록을 찾을 수 없습니다." });
    if (log.user_id !== req.user.id) {
      return res.status(403).json({ error: "본인 기록만 삭제할 수 있습니다." });
    }

    await run("DELETE FROM health_logs WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  })
);

/* ======================
   무더위쉼터 (safekorea.go.kr 프록시)
====================== */
const SHELTER_SOURCE_URL =
  "https://www.safekorea.go.kr/safekorea-kor/flsm/flsm/facilityDataList.do";

app.get(
  "/api/shelters",
  requireAuth,
  h(async (req, res) => {
    const sggCd = req.query.sggCd || "26";

    try {
      const sourceRes = await fetch(SHELTER_SOURCE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest",
          "Accept": "application/json, text/javascript, */*; q=0.01",
          "Referer":
            "https://www.safekorea.go.kr/safekorea-kor/flsm/flsm/facilitiesSafteyMap.do?menuSn=2&baseMapNm=naver",
        },
        body: `tableNm=TFK_HTW_RSTR_TEMP&tableKorNm=${encodeURIComponent("무더위쉼터")}&sggCd=${sggCd}&page=1&size=3000`,
      });

      const data = await sourceRes.json();

      const shelters = (data.mapList || [])
        .filter((s) => s.la && s.lo)
        .map((s) => ({
          name: s.rstrNm,
          address: s.rnDtlAdres,
          lat: s.la,
          lng: s.lo,
          capacity: s.usePsblNmpr,
          aircon: s.chckMatterAirconPosesAt === "Y",
          nightOpen: s.chckMatterNightOpnAt === "Y",
        }));

      res.json({ shelters });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
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
