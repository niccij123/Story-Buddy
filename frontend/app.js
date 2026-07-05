// ── Config ────────────────────────────────────────────────────────────────
const API_BASE      = '';
const STORIES_KEY   = 'storybuddy_stories';
const CURRENT_KEY   = 'storybuddy_current';

// ── State ─────────────────────────────────────────────────────────────────
let currentMode = 'brainstorm';
let chatHistory = [];
let storyBible  = { character: null, setting: null, problem: null, plot_beats: [], writer_tip: null };
let currentStoryId = null;

// ── DOM refs ──────────────────────────────────────────────────────────────
const chatForm          = document.getElementById('chat-form');
const chatInput         = document.getElementById('chat-input');
const chatMessages      = document.getElementById('chat-messages');
const suggestionCard    = document.getElementById('suggestion-card');
const suggestionText    = document.getElementById('suggestion-text');
const suggestionAdd     = document.getElementById('suggestion-add');
const suggestionDismiss = document.getElementById('suggestion-dismiss');
const storyBody         = document.getElementById('story-body');
const storyTitle        = document.getElementById('story-title');
const saveIndicator     = document.getElementById('save-indicator');
const storiesBtn        = document.getElementById('stories-btn');
const storiesDrawer     = document.getElementById('stories-drawer');
const storiesList       = document.getElementById('stories-list');
const newStoryBtn       = document.getElementById('new-story-btn');

// ── Multi-story storage ───────────────────────────────────────────────────
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function loadAllStories() {
  try { return JSON.parse(localStorage.getItem(STORIES_KEY)) || {}; }
  catch { return {}; }
}

function saveAllStories(stories) {
  try { localStorage.setItem(STORIES_KEY, JSON.stringify(stories)); } catch {}
}

function buildBlankStory() {
  return {
    id: genId(),
    title: '',
    body: '',
    mode: 'brainstorm',
    chatHistory: [],
    storyBible: { character: null, setting: null, problem: null, plot_beats: [], writer_tip: null },
    updatedAt: Date.now(),
  };
}

function saveCurrentStory() {
  if (!currentStoryId) return;
  const stories = loadAllStories();
  stories[currentStoryId] = {
    id: currentStoryId,
    title: storyTitle.value,
    body: storyBody.value,
    mode: currentMode,
    chatHistory,
    storyBible,
    updatedAt: Date.now(),
  };
  saveAllStories(stories);
  try { localStorage.setItem(CURRENT_KEY, currentStoryId); } catch {}
}

function loadStory(story) {
  currentStoryId = story.id;
  storyTitle.value = story.title || '';
  storyBody.value  = story.body  || '';
  currentMode      = story.mode  || 'brainstorm';
  storyBible       = { character: null, setting: null, problem: null, plot_beats: [], writer_tip: null,
                       ...(story.storyBible || {}) };
  chatHistory      = story.chatHistory || [];

  // Reset UI
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === currentMode);
  });
  suggestionCard.hidden = true;

  // Bible
  ['character','setting','problem'].forEach(f => {
    const el = document.getElementById(`val-${f}`);
    if (storyBible[f]) { el.textContent = storyBible[f]; el.classList.remove('empty'); }
    else               { el.textContent = 'Not started yet'; el.classList.add('empty'); }
  });
  if (storyBible.writer_tip) {
    const el = document.getElementById('val-tip');
    el.textContent = storyBible.writer_tip; el.classList.remove('empty');
  } else {
    const el = document.getElementById('val-tip');
    el.textContent = 'Tips will appear as you write.'; el.classList.add('empty');
  }
  if (storyBible.plot_beats?.length && storyBible.problem) {
    renderPlotBeats();
    document.getElementById('plot-beats-section').hidden = false;
  } else {
    document.getElementById('plot-beats-section').hidden = true;
    document.getElementById('plot-beats-list').innerHTML = '';
  }

  // Chat
  chatMessages.innerHTML = '';
  if (chatHistory.length) {
    chatHistory.forEach(({ role, content }) =>
      appendMessage(role === 'user' ? 'child' : 'buddy', content));
  } else {
    appendMessage('buddy', 'Hi! I\'m your story buddy. What kind of story do you want to make today?');
  }

  try { localStorage.setItem(CURRENT_KEY, currentStoryId); } catch {}
}

function renderStoriesList() {
  const stories = loadAllStories();
  const sorted  = Object.values(stories).sort((a, b) => b.updatedAt - a.updatedAt);
  storiesList.innerHTML = '';
  if (!sorted.length) {
    storiesList.innerHTML = '<li class="stories-empty">No saved stories yet.</li>';
    return;
  }
  sorted.forEach(s => {
    const li   = document.createElement('li');
    li.className = 'story-item' + (s.id === currentStoryId ? ' current' : '');
    const date = new Date(s.updatedAt).toLocaleDateString(undefined, { month:'short', day:'numeric' });
    li.innerHTML = `
      <button class="story-item-load" data-id="${s.id}">
        <span class="story-item-title">${s.title || 'Untitled story'}</span>
        <span class="story-item-date">${date}</span>
      </button>
      <button class="story-item-delete" data-id="${s.id}" aria-label="Delete story">🗑</button>`;
    storiesList.appendChild(li);
  });
}

// ── Startup ───────────────────────────────────────────────────────────────
(function init() {
  const stories = loadAllStories();
  const savedId = localStorage.getItem(CURRENT_KEY);
  if (savedId && stories[savedId]) {
    loadStory(stories[savedId]);
  } else {
    const vals = Object.values(stories);
    if (vals.length) {
      const latest = vals.sort((a, b) => b.updatedAt - a.updatedAt)[0];
      loadStory(latest);
    } else {
      const blank = buildBlankStory();
      const all   = {}; all[blank.id] = blank;
      saveAllStories(all);
      loadStory(blank);
    }
  }
})();

// ── Persistence ───────────────────────────────────────────────────────────
let saveTimer;
function triggerSave() {
  saveIndicator.textContent = 'Saving…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveCurrentStory();
    saveIndicator.textContent = 'Saved';
    setTimeout(() => { saveIndicator.textContent = ''; }, 2000);
  }, 800);
}

// ── Stories drawer ────────────────────────────────────────────────────────
storiesBtn.addEventListener('click', () => {
  const isOpen = !storiesDrawer.hidden;
  if (isOpen) { storiesDrawer.hidden = true; return; }
  const rect = storiesBtn.getBoundingClientRect();
  storiesDrawer.style.top  = (rect.bottom + 8) + 'px';
  storiesDrawer.style.left = Math.max(8, rect.right - 300) + 'px';
  storiesDrawer.hidden = false;
  renderStoriesList();
});

newStoryBtn.addEventListener('click', () => {
  saveCurrentStory();
  const blank    = buildBlankStory();
  const stories  = loadAllStories();
  stories[blank.id] = blank;
  saveAllStories(stories);
  loadStory(blank);
  storiesDrawer.hidden = true;
});

storiesList.addEventListener('click', e => {
  const loadBtn = e.target.closest('.story-item-load');
  const delBtn  = e.target.closest('.story-item-delete');

  if (loadBtn) {
    const id = loadBtn.dataset.id;
    if (id === currentStoryId) { storiesDrawer.hidden = true; return; }
    saveCurrentStory();
    const stories = loadAllStories();
    if (stories[id]) loadStory(stories[id]);
    storiesDrawer.hidden = true;
  }

  if (delBtn) {
    const id = delBtn.dataset.id;
    const stories = loadAllStories();
    const title = stories[id]?.title || 'Untitled story';
    if (!confirm(`Delete "${title}"? This can't be undone.`)) return;
    delete stories[id];
    saveAllStories(stories);
    if (id === currentStoryId) {
      const vals = Object.values(stories);
      if (vals.length) {
        loadStory(vals.sort((a, b) => b.updatedAt - a.updatedAt)[0]);
      } else {
        const blank = buildBlankStory();
        stories[blank.id] = blank;
        saveAllStories(stories);
        loadStory(blank);
      }
    }
    renderStoriesList();
  }
});

// Close drawer when clicking outside
document.addEventListener('click', e => {
  if (!storiesDrawer.hidden &&
      !storiesDrawer.contains(e.target) &&
      e.target !== storiesBtn) {
    storiesDrawer.hidden = true;
  }
});

// ── Mode toggle ───────────────────────────────────────────────────────────
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    currentMode = btn.dataset.mode;
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (currentMode === 'brainstorm') suggestionCard.hidden = true;
    triggerSave();
  });
});

// ── Chat ──────────────────────────────────────────────────────────────────
chatForm.addEventListener('submit', async e => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  appendMessage('child', text);
  chatHistory.push({ role: 'user', content: text });
  chatInput.value = '';
  chatInput.style.height = '';
  await sendToBackend();
});

chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chatForm.requestSubmit(); }
});

chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = chatInput.scrollHeight + 'px';
});

async function sendToBackend() {
  const thinkingBubble = appendMessage('thinking', 'Thinking…');
  setInputLocked(true);
  try {
    const res = await fetch(`${API_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages:    chatHistory,
        mode:        currentMode,
        story_bible: storyBible,
        story_body:  storyBody.value,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail ?? `Server error ${res.status}`);
    }
    const data = await res.json();
    thinkingBubble.remove();
    if (data.reply) {
      appendMessage('buddy', data.reply);
      chatHistory.push({ role: 'assistant', content: data.reply });
    }
    if (data.story_bible_update) applyBibleUpdate(data.story_bible_update);
    if (data.suggestion && currentMode === 'cowrite') {
      suggestionText.textContent = data.suggestion;
      suggestionCard.hidden = false;
    }
    triggerSave();
  } catch (err) {
    thinkingBubble.remove();
    appendMessage('buddy', `Hmm, something went wrong. (${err.message}) Try again?`);
  } finally {
    setInputLocked(false);
    chatInput.focus();
  }
}

function appendMessage(role, text) {
  const div = document.createElement('div');
  div.className = `chat-bubble ${role}`;
  div.textContent = text;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return div;
}

function setInputLocked(locked) {
  chatInput.disabled = locked;
  chatForm.querySelector('.btn-send').disabled = locked;
}

// ── Suggestion card ───────────────────────────────────────────────────────
suggestionAdd.addEventListener('click', () => {
  const line = suggestionText.textContent.trim();
  if (!line) return;
  const current = storyBody.value;
  storyBody.value = current + (current.endsWith('\n') || !current ? '' : '\n') + line + '\n';
  suggestionCard.hidden = true;
  triggerSave();
});

suggestionDismiss.addEventListener('click', () => { suggestionCard.hidden = true; });

// ── Story bible ───────────────────────────────────────────────────────────
function applyBibleUpdate(update) {
  if (update.character  != null) setBibleField('character', update.character);
  if (update.setting    != null) setBibleField('setting',   update.setting);
  if (update.problem    != null) setBibleField('problem',   update.problem);
  if (update.writer_tip != null) setBibleField('tip',       update.writer_tip);
  if (update.plot_beat  != null) { storyBible.plot_beats.push(update.plot_beat); renderPlotBeats(); }
  triggerSave();
}

function setBibleField(field, value) {
  const stateKey = field === 'tip' ? 'writer_tip' : field;
  if (stateKey in storyBible) storyBible[stateKey] = value;
  const el = document.getElementById(`val-${field}`);
  if (!el) return;
  el.textContent = value;
  el.classList.remove('empty');
  if (field === 'problem') document.getElementById('plot-beats-section').hidden = false;
}

function renderPlotBeats() {
  const list = document.getElementById('plot-beats-list');
  list.innerHTML = '';
  storyBible.plot_beats.forEach(beat => {
    const li = document.createElement('li');
    li.textContent = beat;
    list.appendChild(li);
  });
  if (storyBible.problem) document.getElementById('plot-beats-section').hidden = false;
}

document.querySelectorAll('.bible-clear').forEach(btn => {
  btn.addEventListener('click', () => clearBibleField(btn.dataset.field));
});

function clearBibleField(field) {
  if (field in storyBible) storyBible[field] = null;
  const el = document.getElementById(`val-${field}`);
  if (el) { el.textContent = 'Not started yet'; el.classList.add('empty'); }
  if (field === 'problem') {
    storyBible.plot_beats = [];
    document.getElementById('plot-beats-section').hidden = true;
    document.getElementById('plot-beats-list').innerHTML = '';
  }
  triggerSave();
}

// ── Document autosave triggers ────────────────────────────────────────────
storyTitle.addEventListener('input', triggerSave);
storyBody.addEventListener('input',  triggerSave);
