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
  getUsage5h,
  getUsageWeekly,
  getRecentEvents,
  getSessionEvents,
  getActiveSessions,
  updateHourlyUsage,
  updateSessionEnd,
  getStats,
  saveDb
} from './db.js';

var __dirname = path.dirname(fileURLToPath(import.meta.url));

// In-memory state: sessionId -> { id, startTime, workingDir, agents: Map(agentId -> agent) }
var activeSessions = new Map();

// WebSocket client tracking
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
    var sessionCopy = Object.assign({}, session);
    var agentsObj = {};
    if (session.agents) {
      session.agents.forEach(function(agent, agentId) {
        agentsObj[agentId] = agent;
      });
    }
    sessionCopy.agents = agentsObj;
    obj[id] = sessionCopy;
  });
  return obj;
}

async function main() {
  await initDb();

  var app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
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

  // POST /events — main event ingestion endpoint
  app.post('/events', function(req, res) {
    try {
      var event = req.body;
      var type = event.event_type;
      var now = event.timestamp || Math.floor(Date.now() / 1000);
      event.timestamp = now;

      // Insert event into DB
      var eventId = insertEvent(event);

      // Handle by event type
      if (type === 'session_start') {
        insertSession({
          id: event.session_id,
          start_time: now,
          working_dir: event.working_dir || null
        });

        activeSessions.set(event.session_id, {
          id: event.session_id,
          startTime: now,
          workingDir: event.working_dir || null,
          agents: new Map()
        });

        updateHourlyUsage(event);

      } else if (type === 'session_end') {
        var duration = event.duration_seconds || 0;
        var tokens = event.est_tokens || 0;
        updateSessionEnd(event.session_id, now, duration, tokens);
        activeSessions.delete(event.session_id);

      } else if (type === 'agent_spawn') {
        var session = activeSessions.get(event.session_id);
        if (session) {
          session.agents.set(event.agent_id, {
            id: event.agent_id,
            type: event.agent_type || 'unknown',
            parentAgentId: event.parent_agent_id || null,
            status: 'running',
            startTime: now,
            endTime: null,
            duration: null,
            thoughts: [],
            tasks: []
          });
        }
        updateHourlyUsage(event);

      } else if (type === 'agent_output') {
        var session = activeSessions.get(event.session_id);
        if (session) {
          var agent = session.agents.get(event.agent_id);
          if (agent) {
            agent.thoughts.push({
              text: event.payload || '',
              timestamp: now
            });
          }
        }

      } else if (type === 'agent_complete') {
        var session = activeSessions.get(event.session_id);
        if (session) {
          var agent = session.agents.get(event.agent_id);
          if (agent) {
            agent.status = 'completed';
            agent.endTime = now;
            agent.duration = event.duration_seconds || (now - agent.startTime);
          }
        }

      } else if (type === 'agent_error') {
        var session = activeSessions.get(event.session_id);
        if (session) {
          var agent = session.agents.get(event.agent_id);
          if (agent) {
            agent.status = 'error';
          }
        }

      } else if (type === 'task_update') {
        var session = activeSessions.get(event.session_id);
        if (session) {
          var agent = session.agents.get(event.agent_id);
          if (agent) {
            agent.tasks.push({
              taskId: event.task_id || null,
              status: event.task_status || null,
              description: event.task_description || event.payload || '',
              timestamp: now
            });
          }
        }
      }

      // Broadcast event to all WebSocket clients
      broadcast({
        type: 'event',
        event: Object.assign({}, event, { id: eventId })
      });

      // Save DB after mutations
      saveDb();

      res.json({ ok: true, eventId: eventId });
    } catch (err) {
      console.error('Error processing event:', err);
      res.status(500).json({ error: 'Failed to process event' });
    }
  });

  // REST endpoints
  app.get('/api/usage/5h', function(req, res) {
    try {
      res.json(getUsage5h());
    } catch (err) {
      res.status(500).json({ error: 'Failed to get usage data' });
    }
  });

  app.get('/api/usage/weekly', function(req, res) {
    try {
      res.json(getUsageWeekly());
    } catch (err) {
      res.status(500).json({ error: 'Failed to get weekly usage data' });
    }
  });

  app.get('/api/stats', function(req, res) {
    try {
      res.json(getStats());
    } catch (err) {
      res.status(500).json({ error: 'Failed to get stats' });
    }
  });

  app.get('/api/sessions', function(req, res) {
    try {
      res.json(getActiveSessions());
    } catch (err) {
      res.status(500).json({ error: 'Failed to get sessions' });
    }
  });

  app.get('/api/sessions/:id/events', function(req, res) {
    try {
      res.json(getSessionEvents(req.params.id));
    } catch (err) {
      res.status(500).json({ error: 'Failed to get session events' });
    }
  });

  app.get('/api/events/recent', function(req, res) {
    try {
      var limit = parseInt(req.query.limit, 10) || 50;
      res.json(getRecentEvents(limit));
    } catch (err) {
      res.status(500).json({ error: 'Failed to get recent events' });
    }
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
