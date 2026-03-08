(function() {
  'use strict';

  // State
  var currentSessionId = null;
  var timelineEvents = [];
  var autoScroll = true;
  var ws = null;
  var reconnectTimer = null;
  var sessionHistory = [];

  // Session tabs state: { [sessionId]: { id, eventCount, ended } }
  var sessionTabs = {};
  var tabOrder = [];

  // Usage plan data
  var usagePlanData = {};

  // Elements
  var elTimeline = document.getElementById('timeline-entries');
  var elSessionLabel = document.getElementById('timeline-session-label');
  var elAutoScroll = document.getElementById('auto-scroll-check');
  var elConnectionDot = document.getElementById('connection-status');
  var elConnectionLabel = document.getElementById('connection-label');
  var elHistoryCards = document.getElementById('history-cards');
  var elSessionTabs = document.getElementById('session-tabs');
  var elUsageModal = document.getElementById('usage-modal');
  var elModalBody = document.getElementById('modal-body');
  var elModalSave = document.getElementById('modal-save-btn');
  var elGearBtn = document.getElementById('plan-gear-btn');
  var elModalClose = document.getElementById('modal-close-btn');

  // Auto-scroll checkbox
  elAutoScroll.addEventListener('change', function() { autoScroll = elAutoScroll.checked; });

  // Detect manual scroll-up to disable auto-scroll
  elTimeline.addEventListener('scroll', function() {
    var atBottom = elTimeline.scrollHeight - elTimeline.scrollTop - elTimeline.clientHeight < 40;
    if (!atBottom && autoScroll) {
      autoScroll = false;
      elAutoScroll.checked = false;
    } else if (atBottom && !autoScroll) {
      autoScroll = true;
      elAutoScroll.checked = true;
    }
  });

  // Utilities
  function formatTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var h = d.getHours().toString().padStart(2, '0');
    var m = d.getMinutes().toString().padStart(2, '0');
    return h + ':' + m;
  }

  function formatTimeCard(ts) {
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

  function formatDuration(seconds) {
    if (seconds == null || isNaN(seconds)) return '';
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
        for (var j = 0; j < children.length; j++) {
          if (children[j]) {
            if (typeof children[j] === 'string') node.appendChild(document.createTextNode(children[j]));
            else node.appendChild(children[j]);
          }
        }
      } else { node.appendChild(children); }
    }
    return node;
  }

  // Event formatting
  function formatEvent(event) {
    var type = event.event_type;
    var icon = '';
    var tag = '';
    var content = '';

    if (type === 'user_prompt') {
      icon = '\u{1F4AC}';
      tag = 'USER';
      content = event.payload || '';
    } else if (type === 'tool_call') {
      icon = '\u2192';
      var parsed = tryParsePayload(event.payload);
      tag = parsed.tool || 'TOOL';
      content = parsed.input || '';
    } else if (type === 'tool_result') {
      icon = '\u2190';
      var parsed2 = tryParsePayload(event.payload);
      tag = parsed2.tool || 'RESULT';
      content = parsed2.result || '';
    } else if (type === 'agent_spawn') {
      icon = '\u{1F680}';
      tag = event.agent_type || 'AGENT';
      content = event.prompt || event.payload || '';
    } else if (type === 'agent_complete') {
      icon = '\u2713';
      tag = 'DONE';
      var dur = event.duration_seconds ? ' (' + formatDuration(event.duration_seconds) + ')' : '';
      content = (event.agent_id || '') + dur;
      if (event.result) content += '\n' + event.result.substring(0, 200);
    } else if (type === 'task_update') {
      icon = '\u{1F4CB}';
      tag = event.status || 'TASK';
      content = event.subject || event.payload || '';
    } else if (type === 'session_start') {
      icon = '\u25CF';
      tag = 'START';
      content = 'Session started' + (event.working_dir ? ' \u2014 ' + event.working_dir : '');
    } else if (type === 'session_end') {
      icon = '\u25CB';
      tag = 'END';
      content = 'Session ended';
    } else {
      icon = '\u2022';
      tag = type || '?';
      content = event.payload || JSON.stringify(event);
    }

    return { icon: icon, tag: tag, content: content };
  }

  // Normalize a DB row into a full event object by merging payload JSON
  function normalizeEvent(evt) {
    if (!evt.payload) return evt;
    try {
      var parsed = JSON.parse(evt.payload);
      if (parsed.event_type) {
        var keys = Object.keys(parsed);
        for (var i = 0; i < keys.length; i++) {
          if (evt[keys[i]] === undefined || evt[keys[i]] === null) {
            evt[keys[i]] = parsed[keys[i]];
          }
        }
      }
    } catch (e) { }
    return evt;
  }

  function tryParsePayload(payload) {
    if (!payload) return {};
    try { return JSON.parse(payload); } catch (e) { return { tool: '', input: payload, result: payload }; }
  }

  // Build nesting structure from flat events
  // Returns array of top-level nodes, each with optional .children array
  function buildNestedTimeline(events) {
    var nodes = [];
    // Stack of open agent_spawn events
    var agentStack = [];

    for (var i = 0; i < events.length; i++) {
      var evt = events[i];
      var type = evt.event_type;

      if (type === 'agent_spawn') {
        var node = { event: evt, children: [], depth: agentStack.length };
        agentStack.push(node);
        // Attach to parent or top level
        if (agentStack.length > 1) {
          agentStack[agentStack.length - 2].children.push(node);
        } else {
          nodes.push(node);
        }
      } else if (type === 'agent_complete') {
        // Find matching agent on stack
        var matched = false;
        for (var j = agentStack.length - 1; j >= 0; j--) {
          if (!evt.agent_id || agentStack[j].event.agent_id === evt.agent_id) {
            var completedNode = { event: evt, children: null, depth: agentStack[j].depth };
            agentStack[j].children.push(completedNode);
            agentStack.splice(j, 1);
            matched = true;
            break;
          }
        }
        if (!matched) {
          nodes.push({ event: evt, children: null, depth: 0 });
        }
      } else {
        var leafNode = { event: evt, children: null, depth: agentStack.length };
        if (agentStack.length > 0) {
          agentStack[agentStack.length - 1].children.push(leafNode);
        } else {
          nodes.push(leafNode);
        }
      }
    }

    // Flush any unclosed agents
    for (var k = agentStack.length - 1; k >= 0; k--) {
      if (agentStack.length > 1) {
        // already attached to parent — no action needed
      } else {
        // already at top level
      }
    }

    return nodes;
  }

  // Render a single flat entry (non-agent-spawn or leaf)
  function createLeafEl(node, flash) {
    var event = node.event;
    var fmt = formatEvent(event);
    var depth = node.depth || 0;
    var cls = 'tl-entry type-' + (event.event_type || 'unknown');
    if (depth > 0) cls += ' depth-' + Math.min(depth, 2);
    if (flash) cls += ' tl-new';

    var row = el('div', { className: cls }, [
      el('span', { className: 'tl-time' }, formatTime(event.timestamp)),
      el('span', { className: 'tl-icon' }, fmt.icon),
      el('span', { className: 'tl-tag' }, fmt.tag),
      el('span', { className: 'tl-content' }, fmt.content)
    ]);
    return row;
  }

  // Render an agent_spawn node as a collapsible group
  function createAgentGroupEl(node, flash) {
    var event = node.event;
    var fmt = formatEvent(event);
    var depth = node.depth || 0;
    var headerCls = 'tl-entry type-agent_spawn tl-agent-header';
    if (depth > 0) headerCls += ' depth-' + Math.min(depth, 2);
    if (flash) headerCls += ' tl-new';

    var collapseIcon = el('span', { className: 'tl-collapse-icon' }, '\u25BC');
    var header = el('div', { className: headerCls }, [
      el('span', { className: 'tl-time' }, formatTime(event.timestamp)),
      el('span', { className: 'tl-icon' }, fmt.icon),
      collapseIcon,
      el('span', { className: 'tl-tag' }, fmt.tag),
      el('span', { className: 'tl-content' }, fmt.content)
    ]);

    var childrenContainer = el('div', { className: 'tl-agent-children tl-nest-line' });
    if (node.children && node.children.length > 0) {
      for (var i = 0; i < node.children.length; i++) {
        childrenContainer.appendChild(renderNode(node.children[i], false));
      }
    }

    var group = el('div', { className: 'tl-agent-group' });
    group.appendChild(header);
    group.appendChild(childrenContainer);

    header.addEventListener('click', function() {
      group.classList.toggle('collapsed');
    });

    return group;
  }

  function renderNode(node, flash) {
    if (node.children !== null) {
      return createAgentGroupEl(node, flash);
    }
    return createLeafEl(node, flash);
  }

  // Render full timeline from timelineEvents array
  function renderTimeline() {
    elTimeline.textContent = '';
    if (timelineEvents.length === 0) {
      elTimeline.appendChild(el('div', { className: 'empty-state' }, 'No events yet'));
      return;
    }
    var nodes = buildNestedTimeline(timelineEvents);
    for (var i = 0; i < nodes.length; i++) {
      elTimeline.appendChild(renderNode(nodes[i], false));
    }
    if (autoScroll) scrollToBottom();
  }

  // Append a single event (real-time) — full re-render to maintain nesting integrity
  function appendEvent(event) {
    renderTimeline();
    if (autoScroll) scrollToBottom();
  }

  function scrollToBottom() {
    elTimeline.scrollTop = elTimeline.scrollHeight;
  }

  // Load a session's events
  function loadSession(sessionId) {
    currentSessionId = sessionId;
    elSessionLabel.textContent = 'Session ' + sessionId.substring(0, 16);
    timelineEvents = [];
    renderTimeline();
    highlightSelectedCard();
    renderSessionTabs();

    fetch('/api/sessions/' + sessionId + '/events')
      .then(function(r) { return r.json(); })
      .then(function(events) {
        timelineEvents = events.map(normalizeEvent);
        timelineEvents.sort(function(a, b) { return (a.timestamp || 0) - (b.timestamp || 0); });
        renderTimeline();
      })
      .catch(function() {});
  }

  // Session Tabs
  function ensureTab(sessionId) {
    if (!sessionTabs[sessionId]) {
      sessionTabs[sessionId] = { id: sessionId, eventCount: 0, ended: false };
      tabOrder.push(sessionId);
    }
  }

  function incrementTabCount(sessionId) {
    ensureTab(sessionId);
    sessionTabs[sessionId].eventCount++;
  }

  function markTabEnded(sessionId) {
    if (sessionTabs[sessionId]) {
      sessionTabs[sessionId].ended = true;
    }
  }

  function renderSessionTabs() {
    elSessionTabs.textContent = '';
    if (tabOrder.length === 0) return;
    for (var i = 0; i < tabOrder.length; i++) {
      (function(sid) {
        var tab = sessionTabs[sid];
        var cls = 'session-tab';
        if (sid === currentSessionId) cls += ' active';
        if (tab.ended) cls += ' ended';
        var badge = el('span', { className: 'session-tab-badge' }, String(tab.eventCount));
        var btn = el('button', {
          className: cls,
          type: 'button',
          onClick: function() { loadSession(sid); }
        }, [
          document.createTextNode(sid.substring(0, 12)),
          badge
        ]);
        elSessionTabs.appendChild(btn);
      })(tabOrder[i]);
    }
  }

  function initTabsFromSessions(sessionsObj) {
    if (!sessionsObj) return;
    var sids = Object.keys(sessionsObj);
    for (var i = 0; i < sids.length; i++) {
      var s = sessionsObj[sids[i]];
      ensureTab(sids[i]);
      if (s.ended) markTabEnded(sids[i]);
    }
    renderSessionTabs();
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
      } catch (e) { }
    };
  }

  function handleSnapshot(data) {
    if (data.stats) updateStats(data.stats);
    if (data.sessions) {
      initTabsFromSessions(data.sessions);
      var sids = Object.keys(data.sessions);
      var latest = null;
      var latestTime = 0;
      for (var i = 0; i < sids.length; i++) {
        var s = data.sessions[sids[i]];
        var t = s.startTime || s.start_time || 0;
        if (!s.ended && t > latestTime) { latest = sids[i]; latestTime = t; }
      }
      if (latest && !currentSessionId) {
        loadSession(latest);
      }
    }
    refreshUsageBars();
    refreshSessionHistory();
  }

  function handleEvent(event) {
    var sid = event.session_id;
    var type = event.event_type;

    // Manage tabs
    if (type === 'session_start') {
      ensureTab(sid);
      renderSessionTabs();
      refreshSessionHistory();
      if (!currentSessionId) {
        loadSession(sid);
        return;
      }
    } else if (type === 'session_end') {
      markTabEnded(sid);
      renderSessionTabs();
      refreshSessionHistory();
    } else {
      incrementTabCount(sid);
      renderSessionTabs();
    }

    // Auto-switch to new sessions if none selected
    if (type === 'session_start' && !currentSessionId) {
      loadSession(sid);
      return;
    }

    // If this event belongs to the currently viewed session, append it
    if (sid === currentSessionId) {
      timelineEvents.push(event);
      appendEvent(event);
    }

    fetchStats();
  }

  // Session history cards
  function refreshSessionHistory() {
    fetch('/api/sessions/history?limit=50')
      .then(function(r) { return r.json(); })
      .then(function(rows) {
        sessionHistory = rows;
        renderHistoryCards();
      })
      .catch(function() {});
  }

  function renderHistoryCards() {
    elHistoryCards.textContent = '';
    if (sessionHistory.length === 0) {
      elHistoryCards.appendChild(el('div', { className: 'empty-state', style: 'height:80px;font-size:11px;' }, 'No sessions yet'));
      return;
    }
    for (var i = 0; i < sessionHistory.length; i++) {
      (function(s) {
        var isActive = !s.end_time;
        var isSelected = currentSessionId === s.id;
        var cls = 'history-card ' + (isActive ? 'active-session' : 'ended-session') + (isSelected ? ' selected' : '');
        var card = el('div', {
          className: cls,
          onClick: function() { loadSession(s.id); }
        }, [
          el('div', { className: 'history-card-name' }, s.id.substring(0, 20)),
          el('div', { className: 'history-card-meta' }, [
            el('span', { className: 'history-card-time' }, formatTimeCard(s.start_time)),
            el('span', { className: 'history-card-count' }, (s.event_count || 0) + ' events')
          ])
        ]);
        elHistoryCards.appendChild(card);
      })(sessionHistory[i]);
    }
  }

  function highlightSelectedCard() {
    renderHistoryCards();
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

  // Usage bars (plan-based)
  function refreshUsageBars() {
    fetch('/api/usage/plan')
      .then(function(r) { return r.json(); })
      .then(function(rows) {
        usagePlanData = {};
        for (var i = 0; i < rows.length; i++) {
          usagePlanData[rows[i].key] = rows[i];
        }
        renderUsageBars();
      })
      .catch(function() {});
  }

  function renderUsageBars() {
    var get = function(key) { return usagePlanData[key] || { value: 0, label: '' }; };

    var sessionPct = Math.min(100, get('session_pct').value || 0);
    document.getElementById('plan-session-fill').style.width = sessionPct + '%';
    document.getElementById('plan-session-pct').textContent = sessionPct + '%';
    document.getElementById('plan-session-reset').textContent = get('session_reset_label').label || 'Resets in --';

    var weeklyAllPct = Math.min(100, get('weekly_all_pct').value || 0);
    document.getElementById('plan-weekly-all-fill').style.width = weeklyAllPct + '%';
    document.getElementById('plan-weekly-all-pct').textContent = weeklyAllPct + '%';
    document.getElementById('plan-weekly-all-reset').textContent = get('weekly_all_reset_label').label || 'Resets Fri 7:00 AM';

    var sonnetPct = Math.min(100, get('weekly_sonnet_pct').value || 0);
    document.getElementById('plan-sonnet-fill').style.width = sonnetPct + '%';
    document.getElementById('plan-sonnet-pct').textContent = sonnetPct + '%';
    document.getElementById('plan-sonnet-reset').textContent = get('weekly_sonnet_reset_label').label || 'Resets Sat 5:00 PM';

    var extraSpent = get('extra_spent').value || 0;
    var extraLimit = get('extra_limit').value || 80;
    var extraPct = extraLimit > 0 ? Math.min(100, Math.round((extraSpent / extraLimit) * 100)) : 0;
    document.getElementById('plan-extra-fill').style.width = extraPct + '%';
    document.getElementById('plan-extra-label').textContent = '$' + extraSpent.toFixed(2) + ' / $' + extraLimit;
    document.getElementById('plan-extra-reset').textContent = get('extra_reset_label').label || 'Resets Apr 1';
  }

  // Usage modal
  var modalFields = [
    { key: 'session_pct', label: 'Current session %', isValue: true },
    { key: 'session_reset_label', label: 'Session reset label', isLabel: true },
    { key: 'weekly_all_pct', label: 'All models %', isValue: true },
    { key: 'weekly_all_reset_label', label: 'All models reset label', isLabel: true },
    { key: 'weekly_sonnet_pct', label: 'Sonnet only %', isValue: true },
    { key: 'weekly_sonnet_reset_label', label: 'Sonnet reset label', isLabel: true },
    { key: 'extra_spent', label: 'Extra spent ($)', isValue: true },
    { key: 'extra_limit', label: 'Extra limit ($)', isValue: true },
    { key: 'extra_reset_label', label: 'Extra reset label', isLabel: true }
  ];

  function openModal() {
    elModalBody.textContent = '';
    for (var i = 0; i < modalFields.length; i++) {
      (function(field) {
        var row = usagePlanData[field.key] || { value: 0, label: '' };
        var inputVal = field.isLabel ? row.label : String(row.value);
        var inputEl = el('input', {
          type: field.isLabel ? 'text' : 'number',
          value: inputVal,
          'data-key': field.key,
          'data-type': field.isLabel ? 'label' : 'value',
          step: '0.01'
        });
        var fieldEl = el('div', { className: 'modal-field' }, [
          el('label', {}, field.label),
          inputEl
        ]);
        elModalBody.appendChild(fieldEl);
      })(modalFields[i]);
    }
    elUsageModal.hidden = false;
  }

  function closeModal() {
    elUsageModal.hidden = true;
  }

  function saveModal() {
    var inputs = elModalBody.querySelectorAll('input');
    var promises = [];
    for (var i = 0; i < inputs.length; i++) {
      var inp = inputs[i];
      var key = inp.getAttribute('data-key');
      var type = inp.getAttribute('data-type');
      var currentRow = usagePlanData[key] || { value: 0, label: '' };
      var body;
      if (type === 'label') {
        body = { key: key, value: currentRow.value, label: inp.value };
      } else {
        body = { key: key, value: parseFloat(inp.value) || 0, label: currentRow.label };
      }
      promises.push(
        fetch('/api/usage/plan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        })
      );
    }
    Promise.all(promises).then(function() {
      closeModal();
      refreshUsageBars();
    }).catch(function() {
      closeModal();
    });
  }

  elGearBtn.addEventListener('click', openModal);
  elModalClose.addEventListener('click', closeModal);
  elModalSave.addEventListener('click', saveModal);
  elUsageModal.addEventListener('click', function(e) {
    if (e.target === elUsageModal) closeModal();
  });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && !elUsageModal.hidden) closeModal();
  });

  // Intervals
  setInterval(refreshUsageBars, 60000);
  setInterval(refreshSessionHistory, 30000);

  // Init
  connect();
  refreshUsageBars();
  fetchStats();
  refreshSessionHistory();
})();
