const { createClient } = require("@libsql/client");
const path = require("path");
const fs = require("fs");

let client;
if (process.env.TURSO_DATABASE_URL) {
  // 운영 환경: Turso(원격, 영구 저장) — Render처럼 디스크가 휘발성인 곳에서도 데이터가 안전
  client = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
} else {
  // 로컬 개발: 파일 기반 SQLite (Turso 계정 없이도 바로 실행 가능)
  const dataDir = path.join(__dirname, "data");
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  client = createClient({ url: `file:${path.join(dataDir, "gels.db")}` });
}

async function migrate() {
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS activity_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sampled_at TEXT NOT NULL DEFAULT (datetime('now')),
      activity_level REAL NOT NULL,
      posture TEXT
    );

    CREATE INDEX IF NOT EXISTS activity_samples_user_time_idx
      ON activity_samples (user_id, sampled_at);

    CREATE TABLE IF NOT EXISTS health_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      symptom TEXT NOT NULL,
      fields TEXT NOT NULL DEFAULT '{}',
      conversation_count INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS health_reports_user_time_idx
      ON health_reports (user_id, updated_at);

    -- 가입 직후 서베이로 받는 기저질환. 행이 있으면 서베이를 마친 것
    CREATE TABLE IF NOT EXISTS health_profiles (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      conditions TEXT NOT NULL DEFAULT '[]',
      other_conditions TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

module.exports = { client, migrate };
