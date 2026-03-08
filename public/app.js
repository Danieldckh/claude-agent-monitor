(function() {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────
  var sessions = {};       // sessionId -> { id, startTime, workingDir, ended, agents: { agentId -> agent } }
  var selectedNodeId = null;
  var ws = null;
  var chart5h = null;
  var chartWeekly = null;
  var reconnectTimer = null;
  var treeRefreshTimer = null;
  var chartRefreshTimer = null;

  // ── DOM References ─────────────────────────────────────────────────
  var elTree = document.getElementById('agent-tree');
  var elConnectionDot = document.getElementById('connection-status');
  var elConnectionLabel = document.getElementById('connection-label');
  var elSessionLabel = document.getElementById('active-session-label');
  var elDetailPanel = document.getElementById('detail-panel');
  var elDetailTitle = document.getElementById('detail-title');
  var elDetailContent = document.getElementById('detail-content');

  // ── Utilities ──────────────────────────────────────────────────────
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

  function escapeHtml(str) {
    if (!str) return '';
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function nowEpoch() {
    return Math.floor(Date.now() / 1000);
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      var keys = Object.keys(attrs);
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (key === 'className') {
          node.className = attrs[key];
        } else if (key === 'textContent') {
          node.textContent = attrs[key];
        } else if (key.indexOf('on') === 0) {
          node.addEventListener(key.substring(2).toLowerCase(), attrs[key]);
        } else {
          node.setAttribute(key, attrs[key]);
        }
      }
    }
    if (children) {
      if (typeof children === 'string') {
        node.textContent = children;
      } else if (Array.isArray(children)) {
        for (var i = 0; i < children.length; i++) {
          if (children[i]) {
            if (typeof children[i] === 'string') {
              node.appendChild(document.createTextNode(children[i]));
            } else {
              node.appendChild(children[i]);
            }
          }
        }
      } else {
        node.appendChild(children);
      }
    }
    return node;
  }

  // ── WebSocket ──────────────────────────────────────────────────────
  function connect() {
    var protocol = location.protocol === 'https:' ? 'wss://' : 'ws://';
    var url = protocol + location.host;

    ws = new WebSocket(url);

    ws.onopen = function() {
      elConnectionDot.className = 'status-dot connected';
      elConnectionLabel.textContent = 'Connected';
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    ws.onclose = function() {
      elConnectionDot.className = 'status-dot disconnected';
      elConnectionLabel.textContent = 'Disconnected';
      reconnectTimer = setTimeout(function() {
        connect();
      }, 3000);
    };

    ws.onmessage = function(evt) {
      try {
        var data = JSON.parse(evt.data);
        if (data.type === 'snapshot') {
          handleSnapshot(data);
        } else if (data.type === 'event') {
          handleEvent(data.event);
        }
      } catch (e) {
        console.error('WS message parse error:', e);
      }
    };
  }

  // ── Snapshot Handler ───────────────────────────────────────────────
  function handleSnapshot(data) {
    sessions = {};
    if (data.sessions) {
      var keys = Object.keys(data.sessions);
      for (var i = 0; i < keys.length; i++) {
        var s = data.sessions[keys[i]];
        sessions[keys[i]] = {
          id: s.id,
          startTime: s.startTime,
          workingDir: s.workingDir || null,
          ended: false,
          agents: s.agents || {}
        };
      }
    }
    if (data.stats) {
      updateStats(data.stats);
    }
    renderTree();
    refreshCharts();
  }

  // ── Event Handler ─────────────────────────────────────────────────
  function handleEvent(event) {
    var type = event.event_type;
    var sid = event.session_id;

    if (type === 'session_start') {
      sessions[sid] = {
        id: sid,
        startTime: event.timestamp,
        workingDir: event.working_dir || null,
        ended: false,
        agents: {}
      };

    } else if (type === 'session_end') {
      if (sessions[sid]) {
        sessions[sid].ended = true;
        sessions[sid].endTime = event.timestamp;
        sessions[sid].duration = event.duration_seconds || 0;
      }

    } else if (type === 'agent_spawn') {
      if (sessions[sid]) {
        sessions[sid].agents[event.agent_id] = {
          id: event.agent_id,
          type: event.agent_type || 'unknown',
          parentAgentId: event.parent_agent_id || null,
          status: 'running',
          startTime: event.timestamp,
          endTime: null,
          duration: null,
          thoughts: [],
          tasks: [],
          prompt: event.payload || null,
          result: null,
          error: null
        };
      }

    } else if (type === 'agent_output') {
      if (sessions[sid] && sessions[sid].agents[event.agent_id]) {
        sessions[sid].agents[event.agent_id].thoughts.push({
          text: event.payload || '',
          timestamp: event.timestamp
        });
      }

    } else if (type === 'agent_complete') {
      if (sessions[sid] && sessions[sid].agents[event.agent_id]) {
        var agent = sessions[sid].agents[event.agent_id];
        agent.status = 'completed';
        agent.endTime = event.timestamp;
        agent.duration = event.duration_seconds || (event.timestamp - agent.startTime);
        agent.result = event.payload || null;
      }

    } else if (type === 'agent_error') {
      if (sessions[sid] && sessions[sid].agents[event.agent_id]) {
        var errAgent = sessions[sid].agents[event.agent_id];
        errAgent.status = 'error';
        errAgent.error = event.payload || 'Unknown error';
      }

    } else if (type === 'task_update') {
      if (sessions[sid] && sessions[sid].agents[event.agent_id]) {
        sessions[sid].agents[event.agent_id].tasks.push({
          taskId: event.task_id || null,
          status: event.task_status || null,
          description: event.task_description || event.payload || '',
          timestamp: event.timestamp
        });
      }
    }

    renderTree();
    fetchStats();
  }

  // ── Render Tree (DOM-based) ────────────────────────────────────────
  function renderTree() {
    var sessionIds = Object.keys(sessions);

    // Clear tree
    elTree.textContent = '';

    if (sessionIds.length === 0) {
      var emptyDiv = el('div', { className: 'empty-state' }, 'Waiting for Claude Code events...');
      elTree.appendChild(emptyDiv);
      elSessionLabel.textContent = 'No active sessions';
      return;
    }

    var activeCount = 0;
    for (var i = 0; i < sessionIds.length; i++) {
      if (!sessions[sessionIds[i]].ended) activeCount++;
    }
    elSessionLabel.textContent = activeCount + ' active session' + (activeCount !== 1 ? 's' : '');

    for (var i = 0; i < sessionIds.length; i++) {
      var session = sessions[sessionIds[i]];
      elTree.appendChild(buildSessionNode(session));
    }
  }

  function buildSessionNode(session) {
    var sessionNodeId = session.id;
    var isSelected = selectedNodeId === sessionNodeId;
    var statusIcon = session.ended ? '\u2705' : '\uD83D\uDD04';
    var elapsed = session.ended
      ? formatDuration(session.duration || (session.endTime ? session.endTime - session.startTime : 0))
      : formatDuration(nowEpoch() - session.startTime);

    var toggleSpan = el('span', { className: 'tree-toggle', textContent: '\u25BC' });
    toggleSpan.addEventListener('click', function(e) {
      e.stopPropagation();
      __toggleNode(sessionNodeId);
    });

    var header = el('div', { className: 'tree-node-header' + (isSelected ? ' selected' : '') }, [
      toggleSpan,
      el('span', { className: 'tree-icon' }, statusIcon),
      el('span', { className: 'tree-label' }, 'Session ' + sessionNodeId.substring(0, 8)),
      el('span', { className: 'tree-duration' }, elapsed),
      el('span', { className: 'tree-status ' + (session.ended ? 'completed' : 'running') })
    ]);
    header.addEventListener('click', function() {
      __selectNode(sessionNodeId);
    });

    var childrenContainer = el('div', { className: 'tree-children', id: 'children-' + sessionNodeId });

    // Find root agents
    var agentKeys = Object.keys(session.agents);
    var rootAgentKeys = [];
    for (var j = 0; j < agentKeys.length; j++) {
      var a = session.agents[agentKeys[j]];
      if (!a.parentAgentId || !session.agents[a.parentAgentId]) {
        rootAgentKeys.push(agentKeys[j]);
      }
    }

    for (var j = 0; j < rootAgentKeys.length; j++) {
      childrenContainer.appendChild(buildAgentNode(session, rootAgentKeys[j], agentKeys));
    }

    if (rootAgentKeys.length === 0 && !session.ended) {
      childrenContainer.appendChild(el('div', { className: 'placeholder' }, 'No agents spawned yet'));
    }

    var node = el('div', { className: 'tree-node root', 'data-node-id': sessionNodeId }, [
      header,
      childrenContainer
    ]);

    return node;
  }

  function buildAgentNode(session, agentId, allAgentKeys) {
    var agent = session.agents[agentId];
    if (!agent) return document.createTextNode('');

    var nodeId = session.id + '::' + agentId;
    var isSelected = selectedNodeId === nodeId;

    // Status icon
    var statusIcon = '\u23F8'; // idle
    if (agent.status === 'running') statusIcon = '\uD83D\uDD04';
    else if (agent.status === 'completed') statusIcon = '\u2705';
    else if (agent.status === 'error') statusIcon = '\u274C';

    // Duration
    var duration = '';
    if (agent.duration != null) {
      duration = formatDuration(agent.duration);
    } else if (agent.status === 'running' && agent.startTime) {
      duration = formatDuration(nowEpoch() - agent.startTime);
    }

    // Find children
    var childKeys = [];
    for (var i = 0; i < allAgentKeys.length; i++) {
      var other = session.agents[allAgentKeys[i]];
      if (other && other.parentAgentId === agentId) {
        childKeys.push(allAgentKeys[i]);
      }
    }

    var hasChildren = childKeys.length > 0 || (agent.tasks && agent.tasks.length > 0) || (agent.thoughts && agent.thoughts.length > 0);

    // Toggle
    var toggleSpan;
    if (hasChildren) {
      toggleSpan = el('span', { className: 'tree-toggle', textContent: '\u25BC' });
      (function(nid) {
        toggleSpan.addEventListener('click', function(e) {
          e.stopPropagation();
          __toggleNode(nid);
        });
      })(nodeId);
    } else {
      toggleSpan = el('span', { className: 'tree-toggle', style: 'visibility:hidden' }, '\u25BC');
    }

    var headerChildren = [
      toggleSpan,
      el('span', { className: 'tree-icon' }, statusIcon),
      el('span', { className: 'tree-label' }, agent.type || agentId)
    ];
    if (duration) {
      headerChildren.push(el('span', { className: 'tree-duration' }, duration));
    }

    var header = el('div', { className: 'tree-node-header' + (isSelected ? ' selected' : '') }, headerChildren);
    (function(nid) {
      header.addEventListener('click', function() {
        __selectNode(nid);
      });
    })(nodeId);

    var nodeChildren = [header];

    if (hasChildren) {
      var childrenContainer = el('div', { className: 'tree-children', id: 'children-' + nodeId });

      // Tasks
      if (agent.tasks && agent.tasks.length > 0) {
        for (var i = 0; i < agent.tasks.length; i++) {
          var task = agent.tasks[i];
          var badgeClass = 'task-badge';
          if (task.status) badgeClass += ' ' + task.status;
          var taskDiv = el('div', { className: 'tree-task' }, [
            el('span', { className: badgeClass }, task.status || 'task'),
            document.createTextNode(' ' + (task.description || ''))
          ]);
          childrenContainer.appendChild(taskDiv);
        }
      }

      // Last 5 thoughts
      if (agent.thoughts && agent.thoughts.length > 0) {
        var start = Math.max(0, agent.thoughts.length - 5);
        for (var i = start; i < agent.thoughts.length; i++) {
          var thought = agent.thoughts[i];
          var text = thought.text || '';
          if (text.length > 120) text = text.substring(0, 120) + '...';
          childrenContainer.appendChild(el('div', { className: 'tree-thought', textContent: text }));
        }
      }

      // Child agents
      for (var i = 0; i < childKeys.length; i++) {
        childrenContainer.appendChild(buildAgentNode(session, childKeys[i], allAgentKeys));
      }

      nodeChildren.push(childrenContainer);
    }

    return el('div', { className: 'tree-node', 'data-node-id': nodeId }, nodeChildren);
  }

  // ── Node Selection ─────────────────────────────────────────────────
  function __selectNode(nodeId) {
    selectedNodeId = nodeId;

    var parts = nodeId.split('::');
    var sessionId = parts[0];
    var agentId = parts.length > 1 ? parts[1] : null;

    var session = sessions[sessionId];
    if (!session) return;

    // Clear detail content
    elDetailContent.textContent = '';

    if (!agentId) {
      // Session node selected
      var agentCount = Object.keys(session.agents).length;
      var elapsed = session.ended
        ? formatDuration(session.duration || 0)
        : formatDuration(nowEpoch() - session.startTime);

      elDetailTitle.textContent = 'Session ' + sessionId.substring(0, 8);

      var section = el('div', { className: 'detail-section' }, [
        el('p', {}, [el('strong', {}, 'Session ID: '), document.createTextNode(sessionId)]),
        el('p', {}, [el('strong', {}, 'Working Dir: '), document.createTextNode(session.workingDir || 'N/A')]),
        el('p', {}, [el('strong', {}, 'Started: '), document.createTextNode(new Date(session.startTime * 1000).toLocaleString())]),
        el('p', {}, [el('strong', {}, 'Status: '), document.createTextNode(session.ended ? 'Ended' : 'Running')]),
        el('p', {}, [el('strong', {}, 'Duration: '), document.createTextNode(elapsed)]),
        el('p', {}, [el('strong', {}, 'Agents: '), document.createTextNode(String(agentCount))])
      ]);
      elDetailContent.appendChild(section);

    } else {
      // Agent node selected
      var agent = session.agents[agentId];
      if (!agent) return;

      elDetailTitle.textContent = agent.type || agentId;

      var items = [
        el('p', {}, [el('strong', {}, 'Agent ID: '), document.createTextNode(agentId)]),
        el('p', {}, [el('strong', {}, 'Type: '), document.createTextNode(agent.type || 'unknown')]),
        el('p', {}, [el('strong', {}, 'Status: '), document.createTextNode(agent.status || 'idle')])
      ];

      if (agent.startTime) {
        items.push(el('p', {}, [el('strong', {}, 'Started: '), document.createTextNode(new Date(agent.startTime * 1000).toLocaleString())]));
      }
      if (agent.duration != null) {
        items.push(el('p', {}, [el('strong', {}, 'Duration: '), document.createTextNode(formatDuration(agent.duration))]));
      } else if (agent.status === 'running' && agent.startTime) {
        items.push(el('p', {}, [el('strong', {}, 'Elapsed: '), document.createTextNode(formatDuration(nowEpoch() - agent.startTime))]));
      }
      if (agent.parentAgentId) {
        items.push(el('p', {}, [el('strong', {}, 'Parent: '), document.createTextNode(agent.parentAgentId)]));
      }

      if (agent.prompt) {
        var promptPre = el('pre', {}, agent.prompt);
        items.push(el('div', { className: 'detail-subsection' }, [el('strong', {}, 'Prompt:'), promptPre]));
      }

      if (agent.result) {
        var resultPre = el('pre', {}, agent.result);
        items.push(el('div', { className: 'detail-subsection' }, [el('strong', {}, 'Result:'), resultPre]));
      }

      if (agent.error) {
        var errorPre = el('pre', { style: 'color:#f85149' }, agent.error);
        items.push(el('div', { className: 'detail-subsection' }, [el('strong', {}, 'Error:'), errorPre]));
      }

      // All thoughts
      if (agent.thoughts && agent.thoughts.length > 0) {
        var thoughtItems = [el('strong', {}, 'Thoughts (' + agent.thoughts.length + '):')];
        for (var i = 0; i < agent.thoughts.length; i++) {
          var t = agent.thoughts[i];
          var time = new Date(t.timestamp * 1000).toLocaleTimeString();
          var timeEl = el('small', { style: 'color:#8b949e' }, time);
          var thoughtDiv = el('div', { className: 'tree-thought', style: 'margin:4px 0' }, [timeEl, document.createTextNode(' ' + t.text)]);
          thoughtItems.push(thoughtDiv);
        }
        items.push(el('div', { className: 'detail-subsection' }, thoughtItems));
      }

      // Tasks
      if (agent.tasks && agent.tasks.length > 0) {
        var taskItems = [el('strong', {}, 'Tasks (' + agent.tasks.length + '):')];
        for (var i = 0; i < agent.tasks.length; i++) {
          var task = agent.tasks[i];
          var badgeClass = 'task-badge';
          if (task.status) badgeClass += ' ' + task.status;
          var taskDiv = el('div', { style: 'margin:4px 0' }, [
            el('span', { className: badgeClass }, task.status || 'task'),
            document.createTextNode(' ' + (task.description || ''))
          ]);
          taskItems.push(taskDiv);
        }
        items.push(el('div', { className: 'detail-subsection' }, taskItems));
      }

      var section = el('div', { className: 'detail-section' }, items);
      elDetailContent.appendChild(section);
    }

    // Un-minimize the detail panel
    elDetailPanel.classList.remove('minimized');
    renderTree();
  }
  window.__selectNode = __selectNode;

  // ── Node Toggle ────────────────────────────────────────────────────
  function __toggleNode(nodeId) {
    var childrenEl = document.getElementById('children-' + nodeId);
    if (childrenEl) {
      childrenEl.classList.toggle('collapsed');
    }
  }
  window.__toggleNode = __toggleNode;

  // ── Toolbar Buttons ────────────────────────────────────────────────
  document.getElementById('collapse-all-btn').addEventListener('click', function() {
    var allChildren = elTree.querySelectorAll('.tree-children');
    for (var i = 0; i < allChildren.length; i++) {
      allChildren[i].classList.add('collapsed');
    }
  });

  document.getElementById('expand-all-btn').addEventListener('click', function() {
    var allChildren = elTree.querySelectorAll('.tree-children');
    for (var i = 0; i < allChildren.length; i++) {
      allChildren[i].classList.remove('collapsed');
    }
  });

  document.getElementById('detail-close-btn').addEventListener('click', function() {
    elDetailPanel.classList.toggle('minimized');
  });

  // ── Charts ─────────────────────────────────────────────────────────
  function initCharts() {
    var darkTheme = {
      gridColor: '#21262d',
      tickColor: '#484f58',
      legendColor: '#8b949e'
    };

    var ctx5h = document.getElementById('chart-5h').getContext('2d');
    chart5h = new Chart(ctx5h, {
      type: 'bar',
      data: {
        labels: [],
        datasets: [
          {
            label: 'Sessions',
            data: [],
            backgroundColor: 'rgba(63, 185, 80, 0.7)',
            borderColor: 'rgba(63, 185, 80, 1)',
            borderWidth: 1
          },
          {
            label: 'Agents',
            data: [],
            backgroundColor: 'rgba(56, 139, 253, 0.7)',
            borderColor: 'rgba(56, 139, 253, 1)',
            borderWidth: 1
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            grid: { color: darkTheme.gridColor },
            ticks: { color: darkTheme.tickColor, maxRotation: 45 }
          },
          y: {
            grid: { color: darkTheme.gridColor },
            ticks: { color: darkTheme.tickColor },
            beginAtZero: true
          }
        },
        plugins: {
          legend: {
            labels: { color: darkTheme.legendColor }
          }
        }
      }
    });

    var ctxWeekly = document.getElementById('chart-weekly').getContext('2d');
    chartWeekly = new Chart(ctxWeekly, {
      type: 'bar',
      data: {
        labels: [],
        datasets: [
          {
            label: 'Sessions',
            data: [],
            backgroundColor: 'rgba(63, 185, 80, 0.7)',
            borderColor: 'rgba(63, 185, 80, 1)',
            borderWidth: 1
          },
          {
            label: 'Est. Tokens K',
            data: [],
            backgroundColor: 'rgba(163, 113, 247, 0.7)',
            borderColor: 'rgba(163, 113, 247, 1)',
            borderWidth: 1
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            grid: { color: darkTheme.gridColor },
            ticks: { color: darkTheme.tickColor }
          },
          y: {
            grid: { color: darkTheme.gridColor },
            ticks: { color: darkTheme.tickColor },
            beginAtZero: true
          }
        },
        plugins: {
          legend: {
            labels: { color: darkTheme.legendColor }
          }
        }
      }
    });
  }

  function refreshCharts() {
    fetch('/api/usage/5h')
      .then(function(res) { return res.json(); })
      .then(function(rows) {
        var labels = [];
        var sessionData = [];
        var agentData = [];
        for (var i = 0; i < rows.length; i++) {
          var d = new Date(rows[i].hour_start * 1000);
          labels.push(d.getHours() + ':00');
          sessionData.push(rows[i].session_count || 0);
          agentData.push(rows[i].agent_count || 0);
        }
        chart5h.data.labels = labels;
        chart5h.data.datasets[0].data = sessionData;
        chart5h.data.datasets[1].data = agentData;
        chart5h.update();
      })
      .catch(function(err) {
        console.error('Failed to fetch 5h usage:', err);
      });

    fetch('/api/usage/weekly')
      .then(function(res) { return res.json(); })
      .then(function(rows) {
        var labels = [];
        var sessionData = [];
        var tokenData = [];
        for (var i = 0; i < rows.length; i++) {
          var d = new Date(rows[i].day_start * 1000);
          labels.push((d.getMonth() + 1) + '/' + d.getDate());
          sessionData.push(rows[i].session_count || 0);
          tokenData.push(Math.round((rows[i].est_tokens || 0) / 1000));
        }
        chartWeekly.data.labels = labels;
        chartWeekly.data.datasets[0].data = sessionData;
        chartWeekly.data.datasets[1].data = tokenData;
        chartWeekly.update();
      })
      .catch(function(err) {
        console.error('Failed to fetch weekly usage:', err);
      });
  }

  // ── Stats ──────────────────────────────────────────────────────────
  function fetchStats() {
    fetch('/api/stats')
      .then(function(res) { return res.json(); })
      .then(function(s) { updateStats(s); })
      .catch(function(err) {
        console.error('Failed to fetch stats:', err);
      });
  }

  function updateStats(s) {
    document.getElementById('stat-sessions').textContent = s.sessions_today || 0;
    document.getElementById('stat-duration').textContent = formatDuration(s.avg_duration_seconds || 0);
    document.getElementById('stat-tokens').textContent = formatNumber(s.tokens_24h || 0);
    document.getElementById('stat-agents').textContent = s.agents_today || 0;
  }

  // ── Auto-refresh ──────────────────────────────────────────────────
  function hasRunningAgents() {
    var sids = Object.keys(sessions);
    for (var i = 0; i < sids.length; i++) {
      if (!sessions[sids[i]].ended) return true;
    }
    return false;
  }

  treeRefreshTimer = setInterval(function() {
    if (hasRunningAgents()) {
      renderTree();
    }
  }, 2000);

  chartRefreshTimer = setInterval(function() {
    refreshCharts();
  }, 60000);

  // ── Init ───────────────────────────────────────────────────────────
  initCharts();
  connect();
  refreshCharts();
  fetchStats();

})();
