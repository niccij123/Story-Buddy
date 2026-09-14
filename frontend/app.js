// ── Config ────────────────────────────────────────────────────────────────
const API_BASE       = '';
const LAST_OPEN_KEY  = 'storybuddy_last_open';   // which story to reopen — a local UI preference, not the data itself
const LEGACY_STORIES_KEY = 'storybuddy_stories'; // old localStorage story data, migrated to the server once

// ── State ─────────────────────────────────────────────────────────────────
let currentMode = 'brainstorm';
let chatHistory = [];
let storyBible  = { characters: [], settings: [], problems: [], plot_beats: [], writer_tip: null };
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
const wordCount         = document.getElementById('word-count');
const chapterBtn        = document.getElementById('chapter-btn');
const exportBtn         = document.getElementById('export-btn');
const exportMenu        = document.getElementById('export-menu');
const micBtn            = document.getElementById('mic-btn');

// ── Backend story API ────────────────────────────────────────────────────
async function apiListStories() {
  const res = await fetch(`${API_BASE}/api/stories`);
  if (!res.ok) throw new Error(`Failed to list stories (${res.status})`);
  return res.json();
}

async function apiGetStory(id) {
  const res = await fetch(`${API_BASE}/api/stories/${id}`);
  if (!res.ok) return null;
  return res.json();
}

async function apiCreateStory() {
  const res = await fetch(`${API_BASE}/api/stories`, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to create story (${res.status})`);
  return res.json();
}

async function apiSaveStory(id, data) {
  const res = await fetch(`${API_BASE}/api/stories/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return res.ok;
}

async function apiDeleteStory(id) {
  const res = await fetch(`${API_BASE}/api/stories/${id}`, { method: 'DELETE' });
  return res.ok;
}

// Old saves stored a single `character`/`setting`/`problem` string each.
// Convert to the list shape on load so nothing is lost.
function migrateStoryBible(bible) {
  const b = { characters: [], settings: [], problems: [], plot_beats: [], writer_tip: null, ...(bible || {}) };
  if (!Array.isArray(b.characters)) b.characters = [];
  if (!Array.isArray(b.settings))   b.settings   = [];
  if (!Array.isArray(b.problems))   b.problems   = [];
  if (bible && typeof bible.character === 'string' && bible.character.trim()) {
    const [name, ...rest] = bible.character.split('—');
    b.characters.push({ name: (name || bible.character).trim(), detail: rest.join('—').trim() });
  }
  if (bible && typeof bible.setting === 'string' && bible.setting.trim()) {
    b.settings.push(bible.setting.trim());
  }
  if (bible && typeof bible.problem === 'string' && bible.problem.trim()) {
    b.problems.push(bible.problem.trim());
  }
  delete b.character;
  delete b.setting;
  delete b.problem;
  return b;
}

// One-time migration: if this browser has old localStorage stories and the
// server has none yet, upload them so nothing from before the backend
// database existed gets lost.
async function migrateLocalStoriesIfNeeded() {
  let local;
  try { local = JSON.parse(localStorage.getItem(LEGACY_STORIES_KEY)); } catch { local = null; }
  if (!local || !Object.keys(local).length) return;

  const remoteSummaries = await apiListStories();
  if (remoteSummaries.length) return; // server already has data — don't duplicate

  for (const s of Object.values(local)) {
    const created = await apiCreateStory();
    await apiSaveStory(created.id, {
      title: s.title || '',
      body: s.body || '',
      mode: s.mode || 'brainstorm',
      chat_history: s.chatHistory || [],
      story_bible: migrateStoryBible(s.storyBible),
    });
  }
  try { localStorage.removeItem(LEGACY_STORIES_KEY); } catch {}
}

async function saveCurrentStory() {
  if (!currentStoryId) return false;
  return apiSaveStory(currentStoryId, {
    title: storyTitle.value,
    body: storyBody.value,
    mode: currentMode,
    chat_history: chatHistory,
    story_bible: storyBible,
  });
}

function loadStory(story) {
  currentStoryId = story.id;
  storyTitle.value = story.title || '';
  storyBody.value  = story.body  || '';
  currentMode      = story.mode  || 'brainstorm';
  storyBible       = migrateStoryBible(story.story_bible);
  chatHistory      = story.chat_history || [];

  // Reset UI
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === currentMode);
  });
  suggestionCard.hidden = true;

  // Bible
  renderCharacters();
  renderSettings();
  renderProblems();
  if (storyBible.writer_tip) {
    const el = document.getElementById('val-tip');
    el.textContent = storyBible.writer_tip; el.classList.remove('empty');
  } else {
    const el = document.getElementById('val-tip');
    el.textContent = 'Tips will appear as you write.'; el.classList.add('empty');
  }
  if (storyBible.plot_beats?.length && storyBible.problems.length) {
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

  try { localStorage.setItem(LAST_OPEN_KEY, currentStoryId); } catch {}
  updateWordCount();
}

async function renderStoriesList() {
  storiesList.innerHTML = '<li class="stories-empty">Loading…</li>';
  let summaries;
  try {
    summaries = await apiListStories();
  } catch (err) {
    storiesList.innerHTML = '<li class="stories-empty">Could not load stories. Check your connection.</li>';
    return;
  }
  storiesList.innerHTML = '';
  if (!summaries.length) {
    storiesList.innerHTML = '<li class="stories-empty">No saved stories yet.</li>';
    return;
  }
  summaries.sort((a, b) => b.updated_at - a.updated_at).forEach(s => {
    const li   = document.createElement('li');
    li.className = 'story-item' + (s.id === currentStoryId ? ' current' : '');
    const date = new Date(s.updated_at).toLocaleDateString(undefined, { month:'short', day:'numeric' });
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
(async function init() {
  try {
    await migrateLocalStoriesIfNeeded();

    const lastId = localStorage.getItem(LAST_OPEN_KEY);
    let story = lastId ? await apiGetStory(lastId) : null;

    if (!story) {
      const summaries = await apiListStories();
      if (summaries.length) {
        const latestId = summaries.sort((a, b) => b.updated_at - a.updated_at)[0].id;
        story = await apiGetStory(latestId);
      }
    }

    if (!story) {
      story = await apiCreateStory();
    }

    loadStory(story);
  } catch (err) {
    console.error('Startup failed:', err);
    chatMessages.innerHTML = '';
    appendMessage('buddy', "Hmm, I couldn't reach the server to load your stories. Check your connection and reload the page.");
  }
})();

// ── Persistence ───────────────────────────────────────────────────────────
let saveTimer;
function triggerSave() {
  saveIndicator.textContent = 'Saving…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const ok = await saveCurrentStory();
    if (ok) {
      saveIndicator.textContent = 'Saved';
      saveIndicator.style.color = '';
      setTimeout(() => { saveIndicator.textContent = ''; }, 2000);
    } else {
      saveIndicator.textContent = '⚠ Not saved!';
      saveIndicator.style.color = '#c0392b';
    }
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

newStoryBtn.addEventListener('click', async () => {
  await saveCurrentStory();
  const created = await apiCreateStory();
  loadStory(created);
  storiesDrawer.hidden = true;
});

storiesList.addEventListener('click', async e => {
  const loadBtn = e.target.closest('.story-item-load');
  const delBtn  = e.target.closest('.story-item-delete');

  if (loadBtn) {
    const id = loadBtn.dataset.id;
    if (id === currentStoryId) { storiesDrawer.hidden = true; return; }
    await saveCurrentStory();
    const story = await apiGetStory(id);
    if (story) loadStory(story);
    storiesDrawer.hidden = true;
  }

  if (delBtn) {
    const id = delBtn.dataset.id;
    const row = delBtn.closest('.story-item');
    const title = row?.querySelector('.story-item-title')?.textContent || 'Untitled story';
    if (!confirm(`Delete "${title}"? This can't be undone.`)) return;

    await apiDeleteStory(id);

    if (id === currentStoryId) {
      const summaries = await apiListStories();
      if (summaries.length) {
        const latestId = summaries.sort((a, b) => b.updated_at - a.updated_at)[0].id;
        loadStory(await apiGetStory(latestId));
      } else {
        loadStory(await apiCreateStory());
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
    if (data.story_bible_updates?.length) {
      data.story_bible_updates.forEach(applyBibleUpdate);
    }
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
  div.dataset.text = text;
  const p = document.createElement('p');
  p.textContent = text;
  div.appendChild(p);
  if (role === 'buddy') {
    const btn = document.createElement('button');
    btn.className = 'btn-add-to-story';
    btn.textContent = '+ Add to story';
    div.appendChild(btn);
  }
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
  if (update.character_name != null) upsertCharacter(update.character_name, update.character_detail || '');
  if (update.setting    != null) addUnique(storyBible.settings, update.setting, renderSettings);
  if (update.problem    != null) addUnique(storyBible.problems, update.problem, renderProblems);
  if (update.writer_tip != null) {
    storyBible.writer_tip = update.writer_tip;
    const el = document.getElementById('val-tip');
    el.textContent = update.writer_tip;
    el.classList.remove('empty');
  }
  if (update.plot_beat  != null) { storyBible.plot_beats.push(update.plot_beat); renderPlotBeats(); }
  triggerSave();
}

function addUnique(arr, value, rerender) {
  const trimmed = value.trim();
  if (!trimmed) return;
  if (arr.some(v => v.toLowerCase() === trimmed.toLowerCase())) return;
  arr.push(trimmed);
  rerender();
  if (arr === storyBible.problems) document.getElementById('plot-beats-section').hidden = false;
}

// ── Generic bible list rendering (settings, problems) ───────────────────────
function renderBibleList(items, listId, emptyId, onRemove) {
  const list  = document.getElementById(listId);
  const empty = document.getElementById(emptyId);
  list.querySelectorAll('.bible-row').forEach(el => el.remove());
  if (!items.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  items.forEach((text, idx) => {
    const li = document.createElement('li');
    li.className = 'bible-row';
    const label = document.createElement('span');
    label.className = 'bible-row-label';
    label.textContent = text;
    const btn = document.createElement('button');
    btn.className = 'bible-clear';
    btn.setAttribute('aria-label', 'Remove');
    btn.textContent = '×';
    btn.addEventListener('click', () => onRemove(idx));
    li.appendChild(label);
    li.appendChild(btn);
    list.appendChild(li);
  });
}

function renderSettings() {
  renderBibleList(storyBible.settings, 'setting-list', 'setting-empty', idx => {
    storyBible.settings.splice(idx, 1);
    renderSettings();
    triggerSave();
  });
}

function renderProblems() {
  renderBibleList(storyBible.problems, 'problem-list', 'problem-empty', idx => {
    storyBible.problems.splice(idx, 1);
    renderProblems();
    if (!storyBible.problems.length) {
      storyBible.plot_beats = [];
      document.getElementById('plot-beats-section').hidden = true;
      document.getElementById('plot-beats-list').innerHTML = '';
    }
    triggerSave();
  });
}

// ── Characters (multiple, each tracked separately) ──────────────────────────
function upsertCharacter(name, detail) {
  const trimmedName = name.trim();
  if (!trimmedName) return;
  const existing = storyBible.characters.find(
    c => c.name.toLowerCase() === trimmedName.toLowerCase()
  );
  if (existing) {
    existing.detail = detail;
  } else {
    storyBible.characters.push({ name: trimmedName, detail });
  }
  renderCharacters();
}

function removeCharacter(name) {
  storyBible.characters = storyBible.characters.filter(c => c.name !== name);
  renderCharacters();
  triggerSave();
}

function renderCharacters() {
  renderBibleList(
    storyBible.characters.map(c => c.detail ? `${c.name} — ${c.detail}` : c.name),
    'character-list', 'character-empty',
    idx => removeCharacter(storyBible.characters[idx].name)
  );
}

function renderPlotBeats() {
  const list = document.getElementById('plot-beats-list');
  list.innerHTML = '';
  storyBible.plot_beats.forEach(beat => {
    const li = document.createElement('li');
    li.textContent = beat;
    list.appendChild(li);
  });
  if (storyBible.problems.length) document.getElementById('plot-beats-section').hidden = false;
}

// ── Document autosave triggers ────────────────────────────────────────────
storyTitle.addEventListener('input', triggerSave);
storyBody.addEventListener('input',  () => { triggerSave(); updateWordCount(); });

// ── Word count ────────────────────────────────────────────────────────────
function updateWordCount() {
  const text  = storyBody.value.trim();
  const count = text ? text.split(/\s+/).length : 0;
  wordCount.textContent = count === 1 ? '1 word' : `${count} words`;
}

// ── New chapter ───────────────────────────────────────────────────────────
chapterBtn.addEventListener('click', () => {
  const chapters = (storyBody.value.match(/^Chapter \d+/gm) || []).length;
  const heading  = `\n\nChapter ${chapters + 1}\n\n`;
  const pos      = storyBody.selectionStart;
  const before   = storyBody.value.slice(0, pos);
  const after    = storyBody.value.slice(pos);
  storyBody.value = before + heading + after;
  const newPos = pos + heading.length;
  storyBody.setSelectionRange(newPos, newPos);
  storyBody.focus();
  triggerSave();
  updateWordCount();
});

// ── Export ────────────────────────────────────────────────────────────────
exportBtn.addEventListener('click', () => {
  const isOpen = !exportMenu.hidden;
  if (isOpen) { exportMenu.hidden = true; return; }
  const rect = exportBtn.getBoundingClientRect();
  exportMenu.style.top  = (rect.bottom + 8) + 'px';
  exportMenu.style.left = rect.left + 'px';
  exportMenu.hidden = false;
});

exportMenu.addEventListener('click', e => {
  const action = e.target.dataset.action;
  if (!action) return;
  exportMenu.hidden = true;
  const title = storyTitle.value.trim() || 'My Story';
  const text  = `${title}\n${'='.repeat(title.length)}\n\n${storyBody.value}`;
  if (action === 'txt') {
    const blob = new Blob([text], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `${title}.txt`; a.click();
    URL.revokeObjectURL(url);
  } else if (action === 'copy') {
    navigator.clipboard.writeText(text).then(() => {
      exportBtn.textContent = '✅ Copied!';
      setTimeout(() => { exportBtn.textContent = '⬇️ Export'; }, 2000);
    });
  }
});

document.addEventListener('click', e => {
  if (!exportMenu.hidden && !exportMenu.contains(e.target) && e.target !== exportBtn) {
    exportMenu.hidden = true;
  }
});

// ── Voice to text ─────────────────────────────────────────────────────────
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!SpeechRecognition) {
  micBtn.hidden = true;
} else {
  const recogniser = new SpeechRecognition();
  recogniser.continuous      = false;
  recogniser.interimResults  = false;
  recogniser.lang            = 'en-US';
  let listening = false;

  micBtn.addEventListener('click', () => {
    if (listening) { recogniser.stop(); return; }
    recogniser.start();
  });

  recogniser.onstart = () => {
    listening = true;
    micBtn.textContent = '🔴';
    micBtn.title = 'Listening… click to stop';
  };

  recogniser.onresult = e => {
    const transcript = e.results[0][0].transcript;
    const sep = chatInput.value && !chatInput.value.endsWith(' ') ? ' ' : '';
    chatInput.value += sep + transcript;
    chatInput.style.height = 'auto';
    chatInput.style.height = chatInput.scrollHeight + 'px';
    chatInput.focus();
  };

  recogniser.onend = () => {
    listening = false;
    micBtn.textContent = '🎤';
    micBtn.title = 'Speak your message';
  };

  recogniser.onerror = e => {
    listening = false;
    micBtn.textContent = '🎤';
    if (e.error !== 'no-speech') {
      appendMessage('buddy', `Microphone error: ${e.error}. Check your browser permissions.`);
    }
  };
}

// ── Add buddy message to story ────────────────────────────────────────────
chatMessages.addEventListener('click', e => {
  const btn = e.target.closest('.btn-add-to-story');
  if (!btn) return;
  const bubble = btn.closest('.chat-bubble');
  const text   = bubble.dataset.text;
  if (!text) return;
  const current = storyBody.value;
  storyBody.value = current + (current.endsWith('\n') || !current ? '' : '\n') + text + '\n';
  btn.textContent = '✅ Added';
  btn.disabled = true;
  triggerSave();
  updateWordCount();
});
