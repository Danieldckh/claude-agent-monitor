import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

var __dirname = path.dirname(fileURLToPath(import.meta.url));
var DB_PATH = path.join(__dirname, 'data', 'monitor.db');

var db = null;

export async function initDb() {
  var SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    var buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      start_time INTEGER,
      end_time INTEGER,
      duration_seconds INTEGER,
      est_tokens INTEGER DEFAULT 0,
      working_dir TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      event_type TEXT,
      agent_type TEXT,
      agent_id TEXT,
      parent_agent_id TEXT,
      payload TEXT,
      timestamp INTEGER
    )
  `);

  db.run('CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp)');
  db.run('CREATE INDEX IF NOT EXISTS idx_events_agent_id ON events(agent_id)');

  db.run(`
    CREATE TABLE IF NOT EXISTS usage_hourly (
      hour_start INTEGER PRIMARY KEY,
      session_count INTEGER DEFAULT 0,
      total_duration_seconds INTEGER DEFAULT 0,
      est_tokens INTEGER DEFAULT 0,
      agent_count INTEGER DEFAULT 0
    )
  `);

  saveDb();
  return db;
}

export function insertSession(session) {
  db.run(
    `INSERT OR REPLACE INTO sessions (id, start_time, end_time, duration_seconds, est_tokens, working_dir)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [session.id, session.start_time, session.end_time || null, session.duration_seconds || null, session.est_tokens || 0, session.working_dir || null]
  );
  saveDb();
}

export function insertEvent(event) {
  // Store full event JSON as payload so timeline can reconstruct all fields
  var payload = event.payload || null;
  if (!payload && (event.event_type === 'agent_complete' || event.event_type === 'task_update' || event.event_type === 'session_start')) {
    payload = JSON.stringify(event);
  }
  db.run(
    `INSERT INTO events (session_id, event_type, agent_type, agent_id, parent_agent_id, payload, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [event.session_id, event.event_type, event.agent_type || null, event.agent_id || null, event.parent_agent_id || null, payload, event.timestamp]
  );
  var result = db.exec('SELECT last_insert_rowid() AS lastID');
  var lastID = result.length > 0 ? result[0].values[0][0] : null;
  saveDb();
  return lastID;
}

export function getUsage5h() {
  var fiveHoursAgo = Date.now() - (5 * 3600000);
  var stmt = db.prepare('SELECT * FROM usage_hourly WHERE hour_start >= ? ORDER BY hour_start ASC');
  stmt.bind([fiveHoursAgo]);
  var rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

export function getUsageWeekly() {
  var sevenDaysAgo = Date.now() - (7 * 86400000);
  var stmt = db.prepare(`
    SELECT
      (hour_start / 86400000) * 86400000 AS day_start,
      SUM(session_count) AS session_count,
      SUM(total_duration_seconds) AS total_duration_seconds,
      SUM(est_tokens) AS est_tokens,
      SUM(agent_count) AS agent_count
    FROM usage_hourly
    WHERE hour_start >= ?
    GROUP BY day_start
    ORDER BY day_start ASC
  `);
  stmt.bind([sevenDaysAgo]);
  var rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

export function getRecentEvents(limit) {
  var n = limit || 50;
  var stmt = db.prepare('SELECT * FROM events ORDER BY timestamp DESC LIMIT ?');
  stmt.bind([n]);
  var rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

export function getSessionEvents(sessionId) {
  var stmt = db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY timestamp ASC');
  stmt.bind([sessionId]);
  var rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

export function getAllSessions(limit) {
  var n = limit || 50;
  var stmt = db.prepare(`
    SELECT s.*, COALESCE(e.cnt, 0) AS event_count
    FROM sessions s
    LEFT JOIN (SELECT session_id, COUNT(*) AS cnt FROM events GROUP BY session_id) e ON e.session_id = s.id
    ORDER BY s.start_time DESC LIMIT ?
  `);
  stmt.bind([n]);
  var rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

export function getActiveSessions() {
  var result = db.exec('SELECT * FROM sessions WHERE end_time IS NULL ORDER BY start_time DESC');
  if (result.length === 0) return [];
  var columns = result[0].columns;
  return result[0].values.map(function(row) {
    var obj = {};
    columns.forEach(function(col, i) {
      obj[col] = row[i];
    });
    return obj;
  });
}

export function updateHourlyUsage(event) {
  var hourStart = Math.floor(event.timestamp / 3600000) * 3600000;

  db.run(`
    INSERT INTO usage_hourly (hour_start, session_count, total_duration_seconds, est_tokens, agent_count)
    VALUES (?, 0, 0, 0, 0)
    ON CONFLICT(hour_start) DO NOTHING
  `, [hourStart]);

  if (event.event_type === 'session_start') {
    db.run('UPDATE usage_hourly SET session_count = session_count + 1 WHERE hour_start = ?', [hourStart]);
  }

  if (event.event_type === 'agent_spawn') {
    db.run('UPDATE usage_hourly SET agent_count = agent_count + 1 WHERE hour_start = ?', [hourStart]);
  }

  if (event.est_tokens) {
    db.run('UPDATE usage_hourly SET est_tokens = est_tokens + ? WHERE hour_start = ?', [event.est_tokens, hourStart]);
  }

  if (event.duration_seconds) {
    db.run('UPDATE usage_hourly SET total_duration_seconds = total_duration_seconds + ? WHERE hour_start = ?', [event.duration_seconds, hourStart]);
  }

  saveDb();
}

export function updateSessionEnd(sessionId, endTime, durationSeconds, estTokens) {
  db.run(
    'UPDATE sessions SET end_time = ?, duration_seconds = ?, est_tokens = ? WHERE id = ?',
    [endTime, durationSeconds, estTokens, sessionId]
  );

  var hourStart = Math.floor(endTime / 3600000) * 3600000;
  db.run(`
    INSERT INTO usage_hourly (hour_start, session_count, total_duration_seconds, est_tokens, agent_count)
    VALUES (?, 0, ?, ?, 0)
    ON CONFLICT(hour_start) DO UPDATE SET
      total_duration_seconds = total_duration_seconds + ?,
      est_tokens = est_tokens + ?
  `, [hourStart, durationSeconds, estTokens, durationSeconds, estTokens]);

  saveDb();
}

export function getStats() {
  var now = Date.now();
  var startOfDay = Math.floor(now / 86400000) * 86400000;
  var twentyFourHoursAgo = now - 86400000;

  var sessionsToday = db.exec(
    'SELECT COUNT(*) FROM sessions WHERE start_time >= ?',
    [startOfDay]
  );
  var sessionCount = sessionsToday.length > 0 ? sessionsToday[0].values[0][0] : 0;

  var avgDuration = db.exec(
    'SELECT AVG(duration_seconds) FROM sessions WHERE start_time >= ? AND duration_seconds IS NOT NULL',
    [startOfDay]
  );
  var avgDur = avgDuration.length > 0 ? avgDuration[0].values[0][0] : 0;

  var tokens24h = db.exec(
    'SELECT SUM(est_tokens) FROM usage_hourly WHERE hour_start >= ?',
    [twentyFourHoursAgo]
  );
  var tokenCount = tokens24h.length > 0 ? tokens24h[0].values[0][0] : 0;

  var agentsToday = db.exec(
    "SELECT COUNT(DISTINCT agent_id) FROM events WHERE timestamp >= ? AND agent_id IS NOT NULL AND event_type = 'agent_spawn'",
    [startOfDay]
  );
  var agentCount = agentsToday.length > 0 ? agentsToday[0].values[0][0] : 0;

  return {
    sessions_today: sessionCount || 0,
    avg_duration_seconds: Math.round(avgDur || 0),
    tokens_24h: tokenCount || 0,
    agents_today: agentCount || 0
  };
}

export function saveDb() {
  if (!db) return;
  var data = db.export();
  var dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}
