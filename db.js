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

  db.run(`
    CREATE TABLE IF NOT EXISTS transcript (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      entry_type TEXT NOT NULL,
      agent TEXT DEFAULT 'main',
      agent_id TEXT,
      model TEXT,
      tool TEXT,
      tool_use_id TEXT,
      content TEXT,
      is_error INTEGER DEFAULT 0,
      usage_input INTEGER DEFAULT 0,
      usage_output INTEGER DEFAULT 0,
      usage_cache_read INTEGER DEFAULT 0,
      usage_cache_create INTEGER DEFAULT 0,
      timestamp INTEGER NOT NULL
    )
  `);

  db.run('CREATE INDEX IF NOT EXISTS idx_transcript_session ON transcript(session_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_transcript_ts ON transcript(timestamp)');

  saveDb();
  return db;
}

export function insertSession(session) {
  db.run(
    'INSERT OR REPLACE INTO sessions (id, start_time, end_time, duration_seconds, est_tokens, working_dir) VALUES (?, ?, ?, ?, ?, ?)',
    [session.id, session.start_time, session.end_time || null, session.duration_seconds || null, session.est_tokens || 0, session.working_dir || null]
  );
}

export function insertEvent(event) {
  var payload = event.payload || JSON.stringify(event);
  db.run(
    'INSERT INTO events (session_id, event_type, agent_type, agent_id, parent_agent_id, payload, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [event.session_id, event.event_type, event.agent_type || null, event.agent_id || null, event.parent_agent_id || null, payload, event.timestamp]
  );
}

export function insertTranscriptEntries(sessionId, entries) {
  var dedupStmt = db.prepare(
    'SELECT COUNT(*) FROM transcript WHERE session_id = ? AND timestamp = ? AND entry_type = ? AND agent = ? AND content = ?'
  );
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    var content = e.text || e.summary || e.result || '';
    var usage = e.usage || {};
    var entryType = e.entry_type || 'unknown';
    var agent = e.agent || 'main';
    var ts = e.timestamp || Date.now();

    // Dedup: skip if identical entry exists
    dedupStmt.bind([sessionId, ts, entryType, agent, content]);
    if (dedupStmt.step()) {
      var count = dedupStmt.get()[0];
      dedupStmt.reset();
      if (count > 0) continue;
    } else {
      dedupStmt.reset();
    }

    db.run(
      'INSERT INTO transcript (session_id, entry_type, agent, agent_id, model, tool, tool_use_id, content, is_error, usage_input, usage_output, usage_cache_read, usage_cache_create, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        sessionId,
        entryType,
        agent,
        e.agent_id || null,
        e.model || null,
        e.tool || null,
        e.tool_use_id || null,
        content,
        e.is_error ? 1 : 0,
        usage.input || 0,
        usage.output || 0,
        usage.cache_read || 0,
        usage.cache_create || 0,
        ts
      ]
    );
  }
  dedupStmt.free();
}

export function getTranscriptEntries(sessionId, limit, offset) {
  limit = limit || 500;
  offset = offset || 0;
  var stmt = db.prepare(
    'SELECT * FROM transcript WHERE session_id = ? ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?'
  );
  stmt.bind([sessionId, limit, offset]);
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
    columns.forEach(function(col, i) { obj[col] = row[i]; });
    return obj;
  });
}

export function getAllSessions(limit) {
  var n = limit || 50;
  var stmt = db.prepare(
    'SELECT s.*, COALESCE(t.cnt, 0) AS entry_count, COALESCE(t.total_input, 0) AS total_input_tokens, COALESCE(t.total_output, 0) AS total_output_tokens FROM sessions s LEFT JOIN (SELECT session_id, COUNT(*) AS cnt, SUM(usage_input) AS total_input, SUM(usage_output) AS total_output FROM transcript GROUP BY session_id) t ON t.session_id = s.id ORDER BY s.start_time DESC LIMIT ?'
  );
  stmt.bind([n]);
  var rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

export function updateSessionEnd(sessionId, endTime, durationSeconds, estTokens) {
  db.run(
    'UPDATE sessions SET end_time = ?, duration_seconds = ?, est_tokens = ? WHERE id = ?',
    [endTime, durationSeconds, estTokens, sessionId]
  );
}

export function getStats() {
  var now = Date.now();
  var startOfDay = Math.floor(now / 86400000) * 86400000;

  var sessionsToday = db.exec('SELECT COUNT(*) FROM sessions WHERE start_time >= ?', [startOfDay]);
  var sessionCount = sessionsToday.length > 0 ? sessionsToday[0].values[0][0] : 0;

  var tokensToday = db.exec(
    'SELECT SUM(usage_input), SUM(usage_output) FROM transcript WHERE timestamp >= ?',
    [startOfDay]
  );
  var inputTokens = tokensToday.length > 0 ? (tokensToday[0].values[0][0] || 0) : 0;
  var outputTokens = tokensToday.length > 0 ? (tokensToday[0].values[0][1] || 0) : 0;

  var agentsToday = db.exec(
    "SELECT COUNT(DISTINCT agent) FROM transcript WHERE timestamp >= ? AND agent != 'main'",
    [startOfDay]
  );
  var agentCount = agentsToday.length > 0 ? agentsToday[0].values[0][0] : 0;

  return {
    sessions_today: sessionCount || 0,
    input_tokens_today: inputTokens || 0,
    output_tokens_today: outputTokens || 0,
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
