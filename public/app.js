(function() {
  'use strict';

  // State
  var currentSessionId = null;
  var timelineEvents = [];
  var autoScroll = true;
  var ws = null;
  var reconnectTimer = null;
  var sessionHistory = [];

  // Elements
  var elTimeline = document.getElementById('timeline-entries');
  var elSessionLabel = document.getElementById('timeline-session-label');
  var elAutoScroll = document.getElementById('auto-scroll-check');
  var elConnectionDot = document.getElementById('connection-status');
  var elConnectionLabel = document.getElementById('connection-label');
  var elHistoryCards = document.getElementById('history-cards');

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
      var parsed = tryParsePayload(event.payload);
      tag = parsed.tool || 'RESULT';
      content = parsed.result || '';
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
      // If payload is a full event JSON (has event_type), merge missing fields
      if (parsed.event_type) {
        var keys = Object.keys(parsed);
        for (var i = 0; i < keys.length; i++) {
          if (evt[keys[i]] === undefined || evt[keys[i]] === null) {
            evt[keys[i]] = parsed[keys[i]];
          }
        }
      }
    } catch (e) { /* payload is not JSON, leave as-is */ }
    return evt;
  }

  function tryParsePayload(payload) {
    if (!payload) return {};
    try { return JSON.parse(payload); } catch (e) { return { tool: '', input: payload, result: payload }; }
  }

  // Render a single timeline entry DOM element
  function createEntryEl(event, flash) {
    var fmt = formatEvent(event);
    var cls = 'tl-entry type-' + (event.event_type || 'unknown') + (flash ? ' tl-new' : '');

    var row = el('div', { className: cls }, [
      el('span', { className: 'tl-time' }, formatTime(event.timestamp)),
      el('span', { className: 'tl-icon' }, fmt.icon),
      el('span', { className: 'tl-tag' }, fmt.tag),
      el('span', { className: 'tl-content' }, fmt.content)
    ]);
    return row;
  }

  // Render full timeline from timelineEvents array
  function renderTimeline() {
    elTimeline.textContent = '';
    if (timelineEvents.length === 0) {
      elTimeline.appendChild(el('div', { className: 'empty-state' }, 'No events yet'));
      return;
    }
    for (var i = 0; i < timelineEvents.length; i++) {
      elTimeline.appendChild(createEntryEl(timelineEvents[i], false));
    }
    if (autoScroll) scrollToBottom();
  }

  // Append a single event (real-time)
  function appendEvent(event) {
    // Remove empty-state if present
    var empty = elTimeline.querySelector('.empty-state');
    if (empty) empty.remove();

    elTimeline.appendChild(createEntryEl(event, true));
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

    fetch('/api/sessions/' + sessionId + '/events')
      .then(function(r) { return r.json(); })
      .then(function(events) {
        timelineEvents = events.map(normalizeEvent);
        // Sort by timestamp
        timelineEvents.sort(function(a, b) { return (a.timestamp || 0) - (b.timestamp || 0); });
        renderTimeline();
      })
      .catch(function() {});
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
    if (data.stats) updateStats(data.stats);
    // Auto-select the most recent active session
    if (data.sessions) {
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

    // Update session history on session start/end
    if (type === 'session_start' || type === 'session_end') {
      refreshSessionHistory();
    }

    // Auto-switch to new sessions
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
    var cards = elHistoryCards.querySelectorAll('.history-card');
    for (var i = 0; i < cards.length; i++) {
      cards[i].classList.remove('selected');
    }
    // Re-render is simpler
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

  // Usage bars
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

  // Intervals
  setInterval(refreshUsageBars, 60000);
  setInterval(refreshSessionHistory, 30000);

  // Init
  connect();
  refreshUsageBars();
  fetchStats();
  refreshSessionHistory();
})();
