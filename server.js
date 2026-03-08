import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  initDb,
  insertSession,
  insertEvent,
  insertTranscriptEntries,
  getTranscriptEntries,
  getActiveSessions,
  getAllSessions,
  updateSessionEnd,
  getStats,
  saveDb
} from './db.js';

var __dirname = path.dirname(fileURLToPath(import.meta.url));

var activeSessions = new Map();
var wsClients = new Set();

function broadcast(data) {
  var message = JSON.stringify(data);
  wsClients.forEach(function(client) {
    if (client.readyState === 1) {
      client.send(message);
    }
  });
}

function sessionsToObject(sessionsMap) {
  var obj = {};
  sessionsMap.forEach(function(session, id) {
    obj[id] = Object.assign({}, session);
  });
  return obj;
}

function restoreSessionsFromDb() {
  var dbSessions = getActiveSessions();
  for (var i = 0; i < dbSessions.length; i++) {
    var s = dbSessions[i];
    if (!activeSessions.has(s.id)) {
      activeSessions.set(s.id, {
        id: s.id,
        startTime: s.start_time,
        workingDir: s.working_dir || null
      });
    }
  }
  console.log('Restored ' + dbSessions.length + ' active sessions from DB');
}

async function main() {
  await initDb();
  restoreSessionsFromDb();

  var app = express();
  app.use(cors());
  app.use(express.json({ limit: '5mb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  var server = http.createServer(app);
  var wss = new WebSocketServer({ server: server });

  wss.on('connection', function(ws) {
    wsClients.add(ws);

    var snapshot = {
      type: 'snapshot',
      sessions: sessionsToObject(activeSessions),
      stats: getStats()
    };
    ws.send(JSON.stringify(snapshot));

    ws.on('close', function() {
      wsClients.delete(ws);
    });
  });

  // POST /events — session lifecycle events
  app.post('/events', function(req, res) {
    try {
      var event = req.body;
      var type = event.event_type;
      var now = event.timestamp || Date.now();
      if (now < 1e12) now = now * 1000;
      event.timestamp = now;

      insertEvent(event);

      if (type === 'session_start') {
        insertSession({
          id: event.session_id,
          start_time: now,
          working_dir: event.working_dir || null
        });
        activeSessions.set(event.session_id, {
          id: event.session_id,
          startTime: now,
          workingDir: event.working_dir || null
        });
        broadcast({ type: 'session_start', session_id: event.session_id, working_dir: event.working_dir, timestamp: now });
      } else if (type === 'session_end') {
        updateSessionEnd(event.session_id, now, 0, 0);
        activeSessions.delete(event.session_id);
        broadcast({ type: 'session_end', session_id: event.session_id, timestamp: now });
      }

      saveDb();
      res.json({ ok: true });
    } catch (err) {
      console.error('Error processing event:', err);
      res.status(500).json({ error: 'Failed to process event' });
    }
  });

  // POST /transcript — batch transcript entries from watcher
  app.post('/transcript', function(req, res) {
    try {
      var sessionId = req.body.session_id;
      var entries = req.body.entries || [];
      if (!sessionId || entries.length === 0) {
        return res.json({ ok: true, count: 0 });
      }

      insertTranscriptEntries(sessionId, entries);

      // Broadcast each entry to WebSocket clients
      broadcast({
        type: 'transcript_batch',
        session_id: sessionId,
        entries: entries
      });

      saveDb();
      res.json({ ok: true, count: entries.length });
    } catch (err) {
      console.error('Error processing transcript:', err);
      res.status(500).json({ error: 'Failed to process transcript' });
    }
  });

  // REST endpoints
  app.get('/api/stats', function(req, res) {
    try { res.json(getStats()); }
    catch (err) { res.status(500).json({ error: 'Failed to get stats' }); }
  });

  app.get('/api/sessions', function(req, res) {
    try { res.json(getActiveSessions()); }
    catch (err) { res.status(500).json({ error: 'Failed to get sessions' }); }
  });

  app.get('/api/sessions/history', function(req, res) {
    try {
      var limit = parseInt(req.query.limit, 10) || 50;
      res.json(getAllSessions(limit));
    } catch (err) { res.status(500).json({ error: 'Failed to get session history' }); }
  });

  app.get('/api/sessions/:id/transcript', function(req, res) {
    try {
      var limit = parseInt(req.query.limit, 10) || 500;
      var offset = parseInt(req.query.offset, 10) || 0;
      res.json(getTranscriptEntries(req.params.id, limit, offset));
    } catch (err) { res.status(500).json({ error: 'Failed to get transcript' }); }
  });

  var PORT = process.env.PORT || 3500;
  server.listen(PORT, function() {
    console.log('Claude Agent Monitor running on http://localhost:' + PORT);
  });
}

main().catch(function(err) {
  console.error('Failed to start server:', err);
  process.exit(1);
});
