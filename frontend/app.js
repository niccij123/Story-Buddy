// ── Config ────────────────────────────────────────────────────────────────
const PIN        = window.__APP_PIN__ ?? 'story';
const API_BASE   = window.__API_BASE__ ?? 'http://localhost:8000';
const STORAGE_KEY = 'storybuddy_session';

// ── State ─────────────────────────────────────────────────────────────────
let currentMode = 'brainstorm';
let chatHistory = [];   // { role: 'user'|'assistant', content: string }[]
let storyBible  = {
  character:  null,
  setting:    null,
  problem:    null,
  plot_beats: [],
  writer_tip: null,
};

// ── DOM refs ──────────────────────────────────────────────────────────────
const pinGate           = document.getElementById('pin-gate');
const appEl             = document.getElementById('app');
const pinInput          = document.getElementById('pin-input');
const pinSubmit         = document.getElementById('pin-submit');
const pinError          = document.getElementById('pin-error');
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

// ── Persistence ───────────────────────────────────────────────────────────
function saveSession() {
  const session = {
    version:     1,
    title:       storyTitle.value,
    body:        storyBody.value,
    mode:        currentMode,
    chatHistory,
    storyBible,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // localStorage full or unavailable — fail silently
  }
}

function restoreSession() {
  let session;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    session = JSON.parse(raw);
  } catch {
    return;
  }

  // Title + body
  if (session.title) storyTitle.value = session.title;
  if (session.body)  storyBody.value  = session.body;

  // Mode
  if (session.mode) {
    currentMode = session.mode;
    document.querySelectorAll('.mode-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === currentMode);
    });
  }

  // Story bible
  if (session.storyBible) {
    storyBible = { ...storyBible, ...session.storyBible };
    if (storyBible.character) setBibleField('character', storyBible.character);
    if (storyBible.setting)   setBibleField('setting',   storyBible.setting);
    if (storyBible.problem)   setBibleField('problem',   storyBible.problem);
    if (storyBible.writer_tip) setBibleField('tip',      storyBible.writer_tip);
    if (storyBible.plot_beats?.length) renderPlotBeats();
  }

  // Chat history — reconstruct bubbles, skip welcome message
  if (session.chatHistory?.length) {
    chatHistory = session.chatHistory;
    chatMessages.innerHTML = '';  // clear the static welcome bubble
    chatHistory.forEach(({ role, content }) => {
      appendMessage(role === 'user' ? 'child' : 'buddy', content);
    });
  }

  saveIndicator.textContent = 'Restored';
  setTimeout(() => { saveIndicator.textContent = ''; }, 1500);
}

// Debounced autosave — fires 800 ms after the last change
let saveTimer;
function triggerSave() {
  saveIndicator.textContent = 'Saving…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveSession();
    saveIndicator.textContent = 'Saved';
    setTimeout(() => { saveIndicator.textContent = ''; }, 2000);
  }, 800);
}

// ── PIN gate ──────────────────────────────────────────────────────────────
function unlockApp() {
  pinGate.hidden = true;
  appEl.hidden   = false;
  pinInput.value = '';
  restoreSession();
}

pinSubmit.addEventListener('click', () => checkPin());
async function checkPin() {
  const entered = pinInput.value.trim();
  if (!entered) return;
  pinSubmit.textContent = 'Checking…';
  pinSubmit.disabled = true;
  pinError.hidden = true;

  try {
    const res = await fetch('/api/verify-pin', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ pin: entered }),
    });
    if (res.ok) {
      pinSubmit.textContent = 'OK!';
      unlockApp();
    } else {
      pinError.textContent = `Wrong PIN (server said ${res.status}) — try again.`;
      pinError.hidden = false;
      pinInput.value  = '';
      pinInput.focus();
    }
  } catch (err) {
    pinError.textContent = `Server error: ${err.message} — try refreshing.`;
    pinError.hidden = false;
  } finally {
    pinSubmit.disabled = false;
    pinSubmit.textContent = "Let's go";
  }
}

pinInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') pinSubmit.click();
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
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    chatForm.requestSubmit();
  }
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

    if (data.story_bible_update) {
      applyBibleUpdate(data.story_bible_update);
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

suggestionDismiss.addEventListener('click', () => {
  suggestionCard.hidden = true;
});

// ── Story bible ───────────────────────────────────────────────────────────
function applyBibleUpdate(update) {
  if (update.character  != null) setBibleField('character', update.character);
  if (update.setting    != null) setBibleField('setting',   update.setting);
  if (update.problem    != null) setBibleField('problem',   update.problem);
  if (update.writer_tip != null) setBibleField('tip',       update.writer_tip);

  if (update.plot_beat != null) {
    storyBible.plot_beats.push(update.plot_beat);
    renderPlotBeats();
  }

  triggerSave();
}

function setBibleField(field, value) {
  const stateKey = field === 'tip' ? 'writer_tip' : field;
  if (stateKey in storyBible) storyBible[stateKey] = value;

  const el = document.getElementById(`val-${field}`);
  if (!el) return;
  el.textContent = value;
  el.classList.remove('empty');

  if (field === 'problem') {
    document.getElementById('plot-beats-section').hidden = false;
  }
}

function renderPlotBeats() {
  const list = document.getElementById('plot-beats-list');
  list.innerHTML = '';
  storyBible.plot_beats.forEach(beat => {
    const li = document.createElement('li');
    li.textContent = beat;
    list.appendChild(li);
  });
  if (storyBible.problem) {
    document.getElementById('plot-beats-section').hidden = false;
  }
}

document.querySelectorAll('.bible-clear').forEach(btn => {
  btn.addEventListener('click', () => clearBibleField(btn.dataset.field));
});

function clearBibleField(field) {
  if (field in storyBible) storyBible[field] = null;
  const el = document.getElementById(`val-${field}`);
  if (el) {
    el.textContent = 'Not started yet';
    el.classList.add('empty');
  }
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
