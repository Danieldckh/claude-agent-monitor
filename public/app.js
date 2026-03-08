(function() {
  'use strict';

  // State
  var currentSessionId = null;
  var transcriptEntries = [];
  var liveMode = true;
  var showNoise = false;
  var ws = null;
  var reconnectTimer = null;
  var sessionHistory = [];
  var knownAgents = {};
  var agentColorIndex = 0;
  var filterType = 'all';
  var filterAgent = 'all';

  // Elements
  var elTranscript = document.getElementById('transcript-entries');
  var elSessionLabel = document.getElementById('panel-session-label');
  var elLiveCheck = document.getElementById('auto-scroll-check');
  var elVerboseCheck = document.getElementById('verbose-check');
  var elConnectionDot = document.getElementById('connection-status');
  var elConnectionLabel = document.getElementById('connection-label');
  var elSessionCards = document.getElementById('session-cards');
  var elFilterType = document.getElementById('filter-type');
  var elFilterAgent = document.getElementById('filter-agent');

  elLiveCheck.addEventListener('change', function() { liveMode = elLiveCheck.checked; });
  elVerboseCheck.addEventListener('change', function() {
    showNoise = elVerboseCheck.checked;
    if (showNoise) {
      elTranscript.classList.add('show-noise');
    } else {
      elTranscript.classList.remove('show-noise');
    }
    renderTranscript();
  });

  elFilterType.addEventListener('change', function() {
    filterType = elFilterType.value;
    renderTranscript();
  });
  elFilterAgent.addEventListener('change', function() {
    filterAgent = elFilterAgent.value;
    renderTranscript();
  });

  function formatTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    return d.getHours().toString().padStart(2, '0') + ':' +
           d.getMinutes().toString().padStart(2, '0') + ':' +
           d.getSeconds().toString().padStart(2, '0');
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
      if (typeof children === 'string') node.textContent = children;
      else if (Array.isArray(children)) {
        for (var j = 0; j < children.length; j++) {
          if (children[j]) {
            if (typeof children[j] === 'string') node.appendChild(document.createTextNode(children[j]));
            else node.appendChild(children[j]);
          }
        }
      } else node.appendChild(children);
    }
    return node;
  }

  // Shorten long MCP tool names
  function shortToolName(name) {
    if (!name) return '';
    // mcp__plugin_playwright_playwright__browser_* → playwright
    if (name.indexOf('mcp__plugin_playwright') === 0) return 'playwright';
    // mcp__* → last segment after final __
    if (name.indexOf('mcp__') === 0) {
      var parts = name.split('__');
      return parts[parts.length - 1];
    }
    // Already short (Read, Write, Edit, Bash, Grep, Glob, Agent, etc.)
    return name;
  }

  var agentColors = ['agent-0','agent-1','agent-2','agent-3','agent-4','agent-5','agent-6','agent-7'];

  function getAgentClass(agent) {
    if (!agent || agent === 'main') return 'agent-main';
    if (knownAgents[agent] === undefined) {
      knownAgents[agent] = agentColorIndex % agentColors.length;
      agentColorIndex++;
      updateAgentFilter();
    }
    return agentColors[knownAgents[agent]];
  }

  function getAgentLabel(agent) {
    if (!agent || agent === 'main') return 'main';
    if (agent.length > 16) return agent.substring(0, 14) + '..';
    return agent;
  }

  function updateAgentFilter() {
    var current = elFilterAgent.value;
    elFilterAgent.textContent = '';
    elFilterAgent.appendChild(el('option', { value: 'all' }, 'All agents'));
    elFilterAgent.appendChild(el('option', { value: 'main' }, 'main'));
    var agents = Object.keys(knownAgents);
    for (var i = 0; i < agents.length; i++) {
      elFilterAgent.appendChild(el('option', { value: agents[i] }, getAgentLabel(agents[i])));
    }
    elFilterAgent.value = current;
  }

  var typeIcons = {
    thinking: '\u{1F9E0}',
    text: '\u{1F4AC}',
    tool_use: '\u{1F527}',
    tool_result: '\u{1F4CB}',
    user: '\u{1F464}',
    agent_prompt: '\u{1F680}'
  };

  // Build a map of tool_use_id → tool_result for merging
  function buildResultMap(entries) {
    var map = {};
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e.entry_type === 'tool_result' && e.tool_use_id) {
        map[e.tool_use_id] = e;
      }
    }
    return map;
  }

  function createEntryEl(entry, flash, resultMap) {
    var type = entry.entry_type;
    var agent = entry.agent || 'main';
    var content = entry.content || '';
    var icon = typeIcons[type] || '\u2022';

    var cls = 't-entry type-' + type;
    if (entry.is_error) cls += ' is-error';
    if (flash) cls += ' t-new';

    var displayContent = content;
    var toolBadge = null;
    var statusDot = null;
    var truncateLen = 200;

    if (type === 'tool_use' && entry.tool) {
      toolBadge = el('span', { className: 't-tool-badge' }, shortToolName(entry.tool));
      truncateLen = 100;

      // Merge tool_result status into this row
      if (resultMap && entry.tool_use_id && resultMap[entry.tool_use_id]) {
        var result = resultMap[entry.tool_use_id];
        if (result.is_error) {
          statusDot = el('span', { className: 't-status-dot error' }, '!');
        } else {
          statusDot = el('span', { className: 't-status-dot success' });
        }
      }
    } else if (type === 'thinking') {
      truncateLen = 80;
    } else if (type === 'tool_result') {
      if (entry.is_error) displayContent = 'Error: ' + content;
      else if (!content || !content.trim()) displayContent = 'Success';
      else if (content.length > 300) displayContent = 'Result (' + content.length + ' chars)';
    } else if (type === 'user') {
      truncateLen = 80;
    } else if (type === 'text') {
      truncateLen = 100;
    } else if (type === 'agent_prompt') {
      displayContent = 'Agent task: ' + content;
    }

    // Single-line truncation for compact view
    var oneLine = displayContent.replace(/\n/g, ' ').replace(/\s+/g, ' ');
    var truncated = oneLine.length > truncateLen ? oneLine.substring(0, truncateLen) + '...' : oneLine;
    var isExpandable = displayContent.length > truncateLen || displayContent.indexOf('\n') !== -1;

    var contentCls = 't-content';
    if (isExpandable) contentCls += ' truncated';

    var contentEl = el('span', { className: contentCls }, truncated);

    if (isExpandable) {
      contentEl.addEventListener('click', function() {
        if (contentEl.classList.contains('truncated')) {
          contentEl.classList.remove('truncated');
          contentEl.classList.add('expanded');
          contentEl.textContent = displayContent;
        } else {
          contentEl.classList.remove('expanded');
          contentEl.classList.add('truncated');
          contentEl.textContent = truncated;
        }
      });
    }

    var children = [
      el('span', { className: 't-time' }, formatTime(entry.timestamp)),
      el('span', { className: 't-agent ' + getAgentClass(agent) }, getAgentLabel(agent)),
      el('span', { className: 't-type' }, icon)
    ];
    if (toolBadge) children.push(toolBadge);
    children.push(contentEl);
    if (statusDot) children.push(statusDot);

    return el('div', { className: cls }, children);
  }

  // Client-side dedup: check for identical timestamp+type+agent+content
  var seenEntryKeys = {};

  function entryKey(e) {
    return (e.timestamp || 0) + '|' + (e.entry_type || '') + '|' + (e.agent || 'main') + '|' + (e.content || '').substring(0, 100);
  }

  function isDuplicate(e) {
    var k = entryKey(e);
    if (seenEntryKeys[k]) return true;
    seenEntryKeys[k] = true;
    return false;
  }

  function getFilteredEntries() {
    var filtered = transcriptEntries;
    if (filterType !== 'all') {
      filtered = filtered.filter(function(e) { return e.entry_type === filterType; });
    }
    if (filterAgent !== 'all') {
      filtered = filtered.filter(function(e) { return (e.agent || 'main') === filterAgent; });
    }
    // When noise hidden: only show text, user, agent_prompt (+ error tool_results)
    if (!showNoise) {
      filtered = filtered.filter(function(e) {
        if (e.entry_type === 'text') return true;
        if (e.entry_type === 'user') return true;
        if (e.entry_type === 'agent_prompt') return true;
        if (e.entry_type === 'tool_result' && e.is_error) return true;
        return false;
      });
    }
    return filtered;
  }

  function renderTranscript() {
    elTranscript.textContent = '';
    var entries = getFilteredEntries();
    if (entries.length === 0) {
      elTranscript.appendChild(el('div', { className: 'empty-state' }, 'No transcript entries'));
      return;
    }
    var resultMap = buildResultMap(transcriptEntries);
    for (var i = 0; i < entries.length; i++) {
      elTranscript.appendChild(createEntryEl(entries[i], false, resultMap));
    }
  }

  function prependEntries(newEntries) {
    newEntries.sort(function(a, b) { return (b.timestamp || 0) - (a.timestamp || 0); });

    // Client-side dedup
    var unique = [];
    for (var i = 0; i < newEntries.length; i++) {
      if (!isDuplicate(newEntries[i])) unique.push(newEntries[i]);
    }
    if (unique.length === 0) return;

    for (var j = unique.length - 1; j >= 0; j--) {
      transcriptEntries.unshift(unique[j]);
      getAgentClass(unique[j].agent);
    }

    var filtered = [];
    for (var k = 0; k < unique.length; k++) {
      var e = unique[k];
      if (filterType !== 'all' && e.entry_type !== filterType) continue;
      if (filterAgent !== 'all' && (e.agent || 'main') !== filterAgent) continue;
      if (!showNoise) {
        if (e.entry_type !== 'text' && e.entry_type !== 'user' && e.entry_type !== 'agent_prompt') {
          if (!(e.entry_type === 'tool_result' && e.is_error)) continue;
        }
      }
      filtered.push(e);
    }

    if (filtered.length === 0) return;

    var emptyState = elTranscript.querySelector('.empty-state');
    if (emptyState) emptyState.remove();

    var resultMap = buildResultMap(transcriptEntries);
    for (var m = filtered.length - 1; m >= 0; m--) {
      var entryEl = createEntryEl(filtered[m], true, resultMap);
      if (elTranscript.firstChild) {
        elTranscript.insertBefore(entryEl, elTranscript.firstChild);
      } else {
        elTranscript.appendChild(entryEl);
      }
    }

    while (elTranscript.children.length > 2000) {
      elTranscript.removeChild(elTranscript.lastChild);
    }
  }

  function loadSession(sessionId) {
    currentSessionId = sessionId;
    elSessionLabel.textContent = 'Session ' + sessionId.substring(0, 16);
    transcriptEntries = [];
    knownAgents = {};
    agentColorIndex = 0;
    seenEntryKeys = {};
    updateAgentFilter();
    renderTranscript();
    highlightSelectedCard();

    fetch('/api/sessions/' + sessionId + '/transcript?limit=500')
      .then(function(r) { return r.json(); })
      .then(function(entries) {
        transcriptEntries = entries;
        for (var i = 0; i < entries.length; i++) {
          getAgentClass(entries[i].agent);
          isDuplicate(entries[i]); // seed dedup cache
        }
        renderTranscript();
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
      elConnectionLabel.textContent = 'Polling';
      reconnectTimer = setTimeout(connect, 5000);
    };
    ws.onerror = function() {
      ws.close();
    };
    ws.onmessage = function(evt) {
      try {
        var data = JSON.parse(evt.data);
        if (data.type === 'snapshot') handleSnapshot(data);
        else if (data.type === 'session_start') handleSessionStart(data);
        else if (data.type === 'session_end') handleSessionEnd(data);
        else if (data.type === 'transcript_batch') handleTranscriptBatch(data);
      } catch (e) {}
    };
  }

  function handleSnapshot(data) {
    if (data.stats) updateStats(data.stats);
    if (data.sessions) {
      var sids = Object.keys(data.sessions);
      var latest = null;
      var latestTime = 0;
      for (var i = 0; i < sids.length; i++) {
        var s = data.sessions[sids[i]];
        var t = s.startTime || s.start_time || 0;
        if (t > latestTime) { latest = sids[i]; latestTime = t; }
      }
      if (latest && !currentSessionId) loadSession(latest);
    }
    refreshSessionCards();
  }

  function handleSessionStart(data) {
    refreshSessionCards();
    if (!currentSessionId && liveMode) loadSession(data.session_id);
  }

  function handleSessionEnd() { refreshSessionCards(); }

  function handleTranscriptBatch(data) {
    if (data.session_id !== currentSessionId) return;
    if (!liveMode) return;
    prependEntries(data.entries || []);
    fetchStats();
  }

  function refreshSessionCards() {
    fetch('/api/sessions/history?limit=50')
      .then(function(r) { return r.json(); })
      .then(function(rows) { sessionHistory = rows; renderSessionCards(); })
      .catch(function() {});
  }

  function renderSessionCards() {
    elSessionCards.textContent = '';
    if (sessionHistory.length === 0) {
      elSessionCards.appendChild(el('div', { className: 'empty-state' }, 'No sessions'));
      return;
    }
    for (var i = 0; i < sessionHistory.length; i++) {
      (function(s) {
        var isActive = !s.end_time;
        var isSelected = currentSessionId === s.id;
        var cls = 'session-card' + (isActive ? ' active' : ' ended') + (isSelected ? ' selected' : '');

        var tokenInfo = '';
        if (s.total_input_tokens || s.total_output_tokens) {
          tokenInfo = formatNumber(s.total_input_tokens || 0) + 'in / ' + formatNumber(s.total_output_tokens || 0) + 'out';
        } else {
          tokenInfo = (s.entry_count || 0) + ' entries';
        }

        elSessionCards.appendChild(el('div', {
          className: cls,
          onClick: function() { loadSession(s.id); }
        }, [
          el('div', { className: 'session-card-id' }, s.id.substring(0, 20)),
          el('div', { className: 'session-card-meta' }, [
            el('span', { className: 'session-card-time' }, formatTimeCard(s.start_time)),
            el('span', { className: 'session-card-tokens' }, tokenInfo)
          ])
        ]));
      })(sessionHistory[i]);
    }
  }

  function highlightSelectedCard() { renderSessionCards(); }

  function fetchStats() {
    fetch('/api/stats').then(function(r) { return r.json(); }).then(updateStats).catch(function() {});
  }

  function updateStats(s) {
    document.getElementById('stat-sessions').textContent = s.sessions_today || 0;
    document.getElementById('stat-agents').textContent = s.agents_today || 0;
    document.getElementById('stat-input-tokens').textContent = formatNumber(s.input_tokens_today || 0);
    document.getElementById('stat-output-tokens').textContent = formatNumber(s.output_tokens_today || 0);
  }

  // REST fallback: load sessions + auto-select latest on startup
  function initViaRest() {
    fetch('/api/sessions/history?limit=50')
      .then(function(r) { return r.json(); })
      .then(function(rows) {
        sessionHistory = rows;
        renderSessionCards();
        if (!currentSessionId && rows.length > 0) {
          loadSession(rows[0].id);
        }
      })
      .catch(function() {});
    fetchStats();
  }

  // Poll for new transcript entries when WS is down
  var pollTimer = null;
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(function() {
      if (currentSessionId && liveMode) {
        var newestTs = transcriptEntries.length > 0 ? transcriptEntries[0].timestamp : 0;
        fetch('/api/sessions/' + currentSessionId + '/transcript?limit=50')
          .then(function(r) { return r.json(); })
          .then(function(entries) {
            var fresh = [];
            for (var i = 0; i < entries.length; i++) {
              if (entries[i].timestamp > newestTs || entries[i].id > (transcriptEntries[0] && transcriptEntries[0].id || 0)) {
                fresh.push(entries[i]);
              }
            }
            if (fresh.length > 0) prependEntries(fresh);
          })
          .catch(function() {});
      }
      fetchStats();
      refreshSessionCards();
    }, 3000);
  }

  setInterval(refreshSessionCards, 30000);

  connect();
  initViaRest();
  startPolling();
})();
