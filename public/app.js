(function() {
  'use strict';

  var sessions = {};
  var selectedNodeId = null;
  var activeTabSession = 'all';
  var ws = null;
  var reconnectTimer = null;

  var elTabs = document.getElementById('session-tabs');
  var elTree = document.getElementById('agent-tree');
  var elConnectionDot = document.getElementById('connection-status');
  var elConnectionLabel = document.getElementById('connection-label');
  var elSessionLabel = document.getElementById('active-session-label');
  var elHistoryCards = document.getElementById('history-cards');

  // Utilities
  function formatDuration(seconds) {
    if (seconds == null || isNaN(seconds)) return '0s';
    seconds = Math.round(seconds);
    if (seconds < 60) return seconds + 's';
    var m = Math.floor(seconds / 60);
    var s = seconds % 60;
    if (m < 60) return m + 'm ' + s + 's';
    var h = Math.floor(m / 60);
    m = m % 60;
    return h + 'h ' + m + 'm';
  }

  function formatNumber(n) {
    if (n == null || isNaN(n)) return '0';
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }

  function formatTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var now = new Date();
    var time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return 'Today ' + time;
    var yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday ' + time;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time;
  }

  function nowMs() { return Date.now(); }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      var keys = Object.keys(attrs);
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (key === 'className') node.className = attrs[key];
        else if (key === 'textContent') node.textContent = attrs[key];
        else if (key.indexOf('on') === 0) node.addEventListener(key.substring(2).toLowerCase(), attrs[key]);
        else node.setAttribute(key, attrs[key]);
      }
    }
    if (children) {
      if (typeof children === 'string') { node.textContent = children; }
      else if (Array.isArray(children)) {
        for (var i = 0; i < children.length; i++) {
          if (children[i]) {
            if (typeof children[i] === 'string') node.appendChild(document.createTextNode(children[i]));
            else node.appendChild(children[i]);
          }
        }
      } else { node.appendChild(children); }
    }
    return node;
  }

  // WebSocket
  function connect() {
    var protocol = location.protocol === 'https:' ? 'wss://' : 'ws://';
    ws = new WebSocket(protocol + location.host);
    ws.onopen = function() {
      elConnectionDot.className = 'status-dot connected';
      elConnectionLabel.textContent = 'Connected';
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    };
    ws.onclose = function() {
      elConnectionDot.className = 'status-dot disconnected';
      elConnectionLabel.textContent = 'Disconnected';
      reconnectTimer = setTimeout(connect, 3000);
    };
    ws.onmessage = function(evt) {
      try {
        var data = JSON.parse(evt.data);
        if (data.type === 'snapshot') handleSnapshot(data);
        else if (data.type === 'event') handleEvent(data.event);
        else handleEvent(data);
      } catch (e) { console.error('WS parse error:', e); }
    };
  }

  function handleSnapshot(data) {
    sessions = {};
    if (data.sessions) {
      var keys = Object.keys(data.sessions);
      for (var i = 0; i < keys.length; i++) {
        var s = data.sessions[keys[i]];
        sessions[keys[i]] = { id: s.id, startTime: s.startTime, workingDir: s.workingDir || '', ended: false, agents: s.agents || {} };
      }
    }
    if (data.stats) updateStats(data.stats);
    renderTree();
    refreshUsageBars();
    refreshSessionHistory();
  }

  function handleEvent(event) {
    var type = event.event_type;
    var sid = event.session_id;

    if (type === 'session_start') {
      sessions[sid] = { id: sid, startTime: event.timestamp, workingDir: event.working_dir || '', ended: false, agents: {} };
      activeTabSession = sid;
      refreshSessionHistory();
    } else if (type === 'session_end') {
      if (sessions[sid]) { sessions[sid].ended = true; sessions[sid].endTime = event.timestamp; }
      refreshSessionHistory();
    } else if (type === 'agent_spawn') {
      if (sessions[sid]) {
        sessions[sid].agents[event.agent_id] = {
          id: event.agent_id, type: event.agent_type || 'unknown',
          parentAgentId: event.parent_agent_id || null, status: 'running',
          startTime: event.timestamp, endTime: null, duration: null,
          thoughts: [], tasks: [], prompt: event.prompt || event.payload || '', result: null, error: null
        };
      }
    } else if (type === 'agent_output') {
      if (sessions[sid] && sessions[sid].agents[event.agent_id]) {
        sessions[sid].agents[event.agent_id].thoughts.push({ text: event.text || event.payload || '', timestamp: event.timestamp });
      }
    } else if (type === 'agent_complete') {
      if (sessions[sid] && sessions[sid].agents[event.agent_id]) {
        var a = sessions[sid].agents[event.agent_id];
        a.status = 'completed'; a.endTime = event.timestamp;
        a.duration = event.duration_seconds || Math.round((event.timestamp - a.startTime) / 1000);
        a.result = event.result || event.payload || '';
      }
    } else if (type === 'agent_error') {
      if (sessions[sid] && sessions[sid].agents[event.agent_id]) {
        sessions[sid].agents[event.agent_id].status = 'error';
        sessions[sid].agents[event.agent_id].error = event.error || event.payload || '';
      }
    } else if (type === 'task_update') {
      if (sessions[sid] && event.agent_id && sessions[sid].agents[event.agent_id]) {
        sessions[sid].agents[event.agent_id].tasks.push({
          taskId: event.task_id, status: event.status || 'pending',
          subject: event.subject || event.payload || '', timestamp: event.timestamp
        });
      }
    }
    renderTree();
    fetchStats();
  }

  // Tab rendering
  function renderTabs() {
    elTabs.textContent = '';
    var sids = Object.keys(sessions);
    if (sids.length === 0) return;

    var allTab = el('div', {
      className: 'session-tab' + (activeTabSession === 'all' ? ' active' : ''),
      onClick: function() { activeTabSession = 'all'; renderTabs(); renderTree(); }
    }, 'All');
    elTabs.appendChild(allTab);

    for (var i = 0; i < sids.length; i++) {
      (function(sid) {
        var s = sessions[sid];
        var agentCount = Object.keys(s.agents).length;
        var cls = 'session-tab' + (activeTabSession === sid ? ' active' : '') + (s.ended ? ' ended' : '');
        var tab = el('div', {
          className: cls,
          onClick: function() { activeTabSession = sid; renderTabs(); renderTree(); }
        }, [
          document.createTextNode(sid.substring(0, 8)),
          agentCount > 0 ? el('span', { className: 'tab-badge' }, String(agentCount)) : null
        ].filter(Boolean));
        elTabs.appendChild(tab);
      })(sids[i]);
    }
  }

  // Tree rendering
  function renderTree() {
    var sids = Object.keys(sessions);
    if (activeTabSession !== 'all') {
      sids = sids.filter(function(s) { return s === activeTabSession; });
    }
    renderTabs();
    elTree.textContent = '';

    if (sids.length === 0) {
      elTree.appendChild(el('div', { className: 'empty-state' }, 'Waiting for Claude Code events...'));
      elSessionLabel.textContent = 'No active sessions';
      return;
    }

    var active = 0;
    for (var i = 0; i < sids.length; i++) { if (!sessions[sids[i]].ended) active++; }
    elSessionLabel.textContent = active + ' active session' + (active !== 1 ? 's' : '');

    for (var i = 0; i < sids.length; i++) {
      elTree.appendChild(buildSessionNode(sessions[sids[i]]));
    }
  }

  function buildSessionNode(session) {
    var nid = session.id;
    var icon = session.ended ? '\u2705' : '\uD83D\uDD04';
    var elapsed = formatDuration(Math.round(((session.ended ? session.endTime : nowMs()) - session.startTime) / 1000));

    var toggle = el('span', { className: 'tree-toggle', textContent: '\u25BC' });
    toggle.addEventListener('click', function(e) { e.stopPropagation(); toggleNode(nid); });

    var header = el('div', { className: 'tree-node-header' + (selectedNodeId === nid ? ' selected' : '') }, [
      toggle, el('span', { className: 'tree-icon' }, icon),
      el('span', { className: 'tree-label' }, 'Session ' + nid.substring(0, 12)),
      el('span', { className: 'tree-duration' }, elapsed)
    ]);
    header.addEventListener('click', function() { selectNode(nid); });

    var kids = el('div', { className: 'tree-children', id: 'children-' + nid });

    if (selectedNodeId === nid) {
      kids.appendChild(el('div', { className: 'tree-detail' },
        'Working dir: ' + (session.workingDir || 'N/A') + '\nStarted: ' + new Date(session.startTime).toLocaleString() +
        '\nAgents: ' + Object.keys(session.agents).length
      ));
    }

    var agentKeys = Object.keys(session.agents);
    var rootAgents = agentKeys.filter(function(aid) {
      var a = session.agents[aid];
      return !a.parentAgentId || !session.agents[a.parentAgentId];
    });

    for (var j = 0; j < rootAgents.length; j++) {
      kids.appendChild(buildAgentNode(session, rootAgents[j], agentKeys));
    }

    return el('div', { className: 'tree-node root', 'data-node-id': nid }, [header, kids]);
  }

  function buildAgentNode(session, agentId, allKeys) {
    var agent = session.agents[agentId];
    if (!agent) return document.createTextNode('');

    var nid = session.id + '::' + agentId;
    var icon = agent.status === 'running' ? '\uD83D\uDD04' : agent.status === 'completed' ? '\u2705' : agent.status === 'error' ? '\u274C' : '\u23F8';
    var dur = agent.duration ? formatDuration(agent.duration) : (agent.status === 'running' ? formatDuration(Math.round((nowMs() - agent.startTime) / 1000)) : '');

    var childKeys = allKeys.filter(function(k) { return session.agents[k] && session.agents[k].parentAgentId === agentId; });
    var hasContent = childKeys.length > 0 || agent.thoughts.length > 0 || agent.tasks.length > 0 || selectedNodeId === nid;

    var toggle = el('span', { className: 'tree-toggle', textContent: hasContent ? '\u25BC' : ' ' });
    if (hasContent) {
      (function(id) { toggle.addEventListener('click', function(e) { e.stopPropagation(); toggleNode(id); }); })(nid);
    }

    var header = el('div', { className: 'tree-node-header' + (selectedNodeId === nid ? ' selected' : '') }, [
      toggle, el('span', { className: 'tree-icon' }, icon),
      el('span', { className: 'tree-label' }, agent.type || agentId),
      dur ? el('span', { className: 'tree-duration' }, dur) : null
    ].filter(Boolean));
    (function(id) { header.addEventListener('click', function() { selectNode(id); }); })(nid);

    var kids = el('div', { className: 'tree-children', id: 'children-' + nid.replace(/[^a-zA-Z0-9-]/g, '_') });

    if (selectedNodeId === nid) {
      var lines = [];
      lines.push('Type: ' + (agent.type || 'unknown'));
      lines.push('Status: ' + agent.status);
      if (agent.startTime) lines.push('Started: ' + new Date(agent.startTime).toLocaleString());
      if (agent.duration) lines.push('Duration: ' + formatDuration(agent.duration));

      var detailDiv = el('div', { className: 'tree-detail' });
      detailDiv.appendChild(el('div', {}, lines.join('\n')));

      if (agent.prompt) {
        detailDiv.appendChild(el('div', { className: 'detail-prompt' }, '\n--- Prompt ---\n' + agent.prompt));
      }
      if (agent.result) {
        detailDiv.appendChild(el('div', { className: 'detail-result' }, '\n--- Result ---\n' + agent.result));
      }
      if (agent.error) {
        detailDiv.appendChild(el('div', { className: 'detail-error' }, '\n--- Error ---\n' + agent.error));
      }
      if (agent.thoughts.length > 0) {
        var thoughtsDiv = el('div', {}, '\n--- Thoughts (' + agent.thoughts.length + ') ---');
        for (var t = 0; t < agent.thoughts.length; t++) {
          thoughtsDiv.appendChild(document.createTextNode('\n[' + new Date(agent.thoughts[t].timestamp).toLocaleTimeString() + '] ' + agent.thoughts[t].text));
        }
        detailDiv.appendChild(thoughtsDiv);
      }
      kids.appendChild(detailDiv);
    }

    // Tasks
    for (var i = 0; i < agent.tasks.length; i++) {
      var task = agent.tasks[i];
      kids.appendChild(el('div', { className: 'tree-task' }, [
        el('span', { className: 'task-badge ' + (task.status || 'pending') }, task.status || 'pending'),
        document.createTextNode(' ' + (task.subject || ''))
      ]));
    }

    // Last 5 thoughts
    var start = Math.max(0, agent.thoughts.length - 5);
    for (var i = start; i < agent.thoughts.length; i++) {
      var text = agent.thoughts[i].text || '';
      if (text.length > 200) text = text.substring(0, 200) + '...';
      kids.appendChild(el('div', { className: 'tree-thought', textContent: text }));
    }

    // Child agents
    for (var i = 0; i < childKeys.length; i++) {
      kids.appendChild(buildAgentNode(session, childKeys[i], allKeys));
    }

    return el('div', { className: 'tree-node', 'data-node-id': nid }, [header, kids]);
  }

  // Selection
  function selectNode(nid) {
    selectedNodeId = (selectedNodeId === nid) ? null : nid;
    renderTree();
  }

  function toggleNode(nid) {
    var safeId = 'children-' + nid.replace(/[^a-zA-Z0-9-]/g, '_');
    var childEl = document.getElementById(safeId);
    if (childEl) childEl.classList.toggle('collapsed');
  }

  // Usage bars with percentage
  function refreshUsageBars() {
    fetch('/api/usage/5h').then(function(r) { return r.json(); }).then(function(rows) {
      var total = 0;
      for (var i = 0; i < rows.length; i++) total += (rows[i].session_count || 0);
      var maxSessions = 20;
      var pct = Math.min(100, Math.round((total / maxSessions) * 100));
      document.getElementById('usage-5h-fill').style.width = pct + '%';
      document.getElementById('usage-5h-pct').textContent = pct + '%';
      document.getElementById('usage-5h-value').textContent = total + ' sess';
    }).catch(function() {});

    fetch('/api/usage/weekly').then(function(r) { return r.json(); }).then(function(rows) {
      var total = 0;
      for (var i = 0; i < rows.length; i++) total += (rows[i].session_count || 0);
      var maxWeekly = 100;
      var pct = Math.min(100, Math.round((total / maxWeekly) * 100));
      document.getElementById('usage-weekly-fill').style.width = pct + '%';
      document.getElementById('usage-weekly-pct').textContent = pct + '%';
      document.getElementById('usage-weekly-value').textContent = total + ' sess';
    }).catch(function() {});
  }

  // Session history cards
  function refreshSessionHistory() {
    fetch('/api/sessions/history?limit=50').then(function(r) { return r.json(); }).then(function(rows) {
      elHistoryCards.textContent = '';
      if (rows.length === 0) {
        elHistoryCards.appendChild(el('div', { className: 'empty-state', style: 'height:80px;font-size:11px;' }, 'No sessions yet'));
        return;
      }
      for (var i = 0; i < rows.length; i++) {
        (function(s) {
          var isActive = !s.end_time;
          var card = el('div', {
            className: 'history-card ' + (isActive ? 'active-session' : 'ended-session'),
            onClick: function() {
              if (sessions[s.id]) {
                activeTabSession = s.id;
                renderTabs();
                renderTree();
              }
            }
          }, [
            el('div', { className: 'history-card-name' }, s.id.substring(0, 16)),
            el('div', { className: 'history-card-time' }, formatTime(s.start_time))
          ]);
          elHistoryCards.appendChild(card);
        })(rows[i]);
      }
    }).catch(function() {});
  }

  // Stats
  function fetchStats() {
    fetch('/api/stats').then(function(r) { return r.json(); }).then(function(s) { updateStats(s); }).catch(function() {});
  }

  function updateStats(s) {
    document.getElementById('stat-sessions').textContent = s.sessions_today || 0;
    document.getElementById('stat-tokens').textContent = formatNumber(s.est_tokens_24h || s.tokens_24h || 0);
    document.getElementById('stat-agents').textContent = s.agents_today || 0;
  }

  // Toolbar
  document.getElementById('collapse-all-btn').addEventListener('click', function() {
    var all = elTree.querySelectorAll('.tree-children');
    for (var i = 0; i < all.length; i++) all[i].classList.add('collapsed');
  });
  document.getElementById('expand-all-btn').addEventListener('click', function() {
    var all = elTree.querySelectorAll('.tree-children');
    for (var i = 0; i < all.length; i++) all[i].classList.remove('collapsed');
  });

  // Auto-refresh
  setInterval(function() {
    var sids = Object.keys(sessions);
    for (var i = 0; i < sids.length; i++) {
      if (!sessions[sids[i]].ended) { renderTree(); return; }
    }
  }, 2000);
  setInterval(refreshUsageBars, 60000);
  setInterval(refreshSessionHistory, 30000);

  // Init
  connect();
  refreshUsageBars();
  fetchStats();
  refreshSessionHistory();
})();
