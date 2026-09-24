// State and wiring: builds the editor from the element definitions, keeps the assembled
// prompt live, and autosaves the editor. The logic lives in the pure modules; this is the
// only file that touches the DOM or sessionStorage.

import {
  ELEMENTS,
  assemble,
  createEmptyElements,
  estimateTokens,
  normalizeElements,
  textKeys,
} from './elements.js';

const EDITOR_KEY = 'pp.editor.v1';
const FEEDBACK_MS = 1600;

// sessionStorage throws when storage is disabled or full. The app keeps working without
// autosave rather than failing.
const session = {
  read(key) {
    try {
      const raw = sessionStorage.getItem(key);
      return raw === null ? null : JSON.parse(raw);
    } catch {
      return null;
    }
  },
  write(key, value) {
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Autosave is a convenience; carry on without it.
    }
  },
};

const state = {
  elements: normalizeElements(session.read(EDITOR_KEY)?.elements),
};

const ui = {
  bootNote: document.getElementById('boot-note'),
  elementList: document.getElementById('element-list'),
  clearAll: document.getElementById('clear-all'),
  confirmClear: document.getElementById('confirm-clear'),
  assembled: document.getElementById('assembled'),
  assembledEmpty: document.getElementById('assembled-empty'),
  promptStats: document.getElementById('prompt-stats'),
  copyPrompt: document.getElementById('copy-prompt'),
  announcer: document.getElementById('announcer'),
};

// ---------------------------------------------------------------------------
// DOM helpers

// h('button', { class: 'btn', type: 'button' }, 'Label', childNode, …). Strings become text
// nodes, so text typed by the user is never parsed as HTML.
function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    if (name === 'class') node.className = value;
    else node.setAttribute(name, value === true ? '' : String(value));
  }
  node.append(...children.flat().filter((child) => child != null && child !== false));
  return node;
}

// Screen-reader announcements for changes that don't move focus.
let announceTimer;
function announce(message) {
  ui.announcer.textContent = '';
  clearTimeout(announceTimer);
  // Clearing first and setting the text a moment later makes a repeated message get read again.
  announceTimer = setTimeout(() => {
    ui.announcer.textContent = message;
  }, 60);
}

// Swaps a button's label briefly ("Copied"), then puts it back.
const labelTimers = new WeakMap();
function flashLabel(button, text) {
  button.dataset.label ??= button.textContent;
  button.textContent = text;
  clearTimeout(labelTimers.get(button));
  labelTimers.set(
    button,
    setTimeout(() => {
      button.textContent = button.dataset.label;
    }, FEEDBACK_MS),
  );
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // The async clipboard needs a secure context (https or localhost); fall back to the
    // older select-and-copy route.
    const scratch = h('textarea', { class: 'offscreen', readonly: true, tabindex: '-1', 'aria-hidden': 'true' });
    scratch.value = text;
    const focused = document.activeElement;
    document.body.append(scratch);
    scratch.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    scratch.remove();
    focused?.focus();
    return copied;
  }
}

async function copyWithFeedback(button, text) {
  const copied = await copyText(text);
  flashLabel(button, copied ? 'Copied' : "Couldn't copy");
  announce(copied ? 'Copied to the clipboard.' : "Couldn't copy. Select the text and copy it by hand.");
}

// ---------------------------------------------------------------------------
// Editor

function buildEditor() {
  ui.elementList.replaceChildren(...ELEMENTS.map(buildElement));
}

function buildElement(def) {
  const plugId = `plug-${def.id}`;
  const plug = h(
    'button',
    { type: 'button', class: 'plug', id: plugId, role: 'switch', 'data-plug': def.id },
    h('span', { class: 'plug-track', 'aria-hidden': 'true' }, h('span', { class: 'plug-knob' })),
    h('span', { class: 'plug-text', 'aria-hidden': 'true' }),
  );

  if (!def.parts) {
    const fieldId = `field-${def.id}`;
    return h(
      'div',
      { class: 'element', 'data-id': def.id },
      h(
        'div',
        { class: 'element-head' },
        h('h3', { class: 'element-title' }, h('label', { for: fieldId }, def.label)),
        plug,
      ),
      field({ id: fieldId, element: def.id, key: 'text', describedBy: plugId }),
    );
  }

  // Rules: one heading and one plug for the group, a labelled field per sub-part.
  const titleId = `title-${def.id}`;
  return h(
    'div',
    { class: 'element', 'data-id': def.id, role: 'group', 'aria-labelledby': titleId },
    h('div', { class: 'element-head' }, h('h3', { class: 'element-title', id: titleId }, def.label), plug),
    h(
      'div',
      { class: 'parts' },
      def.parts.map((part) => {
        const fieldId = `field-${def.id}-${part.id}`;
        return h(
          'div',
          { class: 'part' },
          h('label', { class: 'part-label', for: fieldId }, part.label),
          field({ id: fieldId, element: def.id, key: part.id, describedBy: plugId, isPart: true }),
        );
      }),
    ),
  );
}

// The plug's name ("Persona: unplugged") doubles as each field's description, so a screen
// reader landing in a greyed-out field hears that it won't be sent.
function field({ id, element, key, describedBy, isPart = false }) {
  return h('textarea', {
    id,
    class: isPart ? 'field part-field' : 'field',
    rows: isPart ? 1 : 2,
    'data-element': element,
    'data-key': key,
    'aria-describedby': describedBy,
  });
}

function fieldFor(elementId, key) {
  return ui.elementList.querySelector(`textarea[data-element="${elementId}"][data-key="${key}"]`);
}

// Pushes state into the editor: field text, plug switches, greyed-out elements.
function syncEditor() {
  for (const def of ELEMENTS) {
    for (const key of textKeys(def)) {
      const textarea = fieldFor(def.id, key);
      const value = state.elements[def.id][key];
      if (textarea.value !== value) textarea.value = value;
    }
    syncPlug(def);
  }
  growAll();
}

function syncPlug(def) {
  const plugged = state.elements[def.id].plugged;
  const card = ui.elementList.querySelector(`.element[data-id="${def.id}"]`);
  const plug = card.querySelector('.plug');
  card.dataset.plugged = String(plugged);
  plug.setAttribute('aria-checked', String(plugged));
  plug.setAttribute('aria-label', `${def.label}: ${plugged ? 'plugged' : 'unplugged'}`);
  plug.querySelector('.plug-text').textContent = plugged ? 'Plugged' : 'Unplugged';
}

// Fields grow with their content. CSS `field-sizing: content` does this where it's
// supported; elsewhere the height is set from scrollHeight.
const growsNatively = globalThis.CSS?.supports?.('field-sizing', 'content') ?? false;

function grow(textarea) {
  if (growsNatively) return;
  const { scrollY } = window;
  textarea.style.height = 'auto';
  textarea.style.height = `${textarea.scrollHeight + textarea.offsetHeight - textarea.clientHeight}px`;
  // Collapsing to 'auto' for a moment can shorten the page and pull the scroll position up.
  if (window.scrollY < scrollY) window.scrollTo(window.scrollX, scrollY);
}

function growAll() {
  if (growsNatively) return;
  ui.elementList.querySelectorAll('textarea').forEach(grow);
}

// Everything that follows a change to the editor.
function editorChanged() {
  session.write(EDITOR_KEY, { elements: state.elements });
  renderAssembled();
}

ui.elementList.addEventListener('input', (event) => {
  const textarea = event.target.closest('textarea[data-key]');
  if (!textarea) return;
  state.elements[textarea.dataset.element][textarea.dataset.key] = textarea.value;
  grow(textarea);
  editorChanged();
});

ui.elementList.addEventListener('click', (event) => {
  const plug = event.target.closest('.plug');
  if (!plug) return;
  const def = ELEMENTS.find((candidate) => candidate.id === plug.dataset.plug);
  const element = state.elements[def.id];
  element.plugged = !element.plugged;
  syncPlug(def);
  editorChanged();
});

// ---------------------------------------------------------------------------
// Assembled prompt

function renderAssembled() {
  const prompt = assemble(state.elements);
  const empty = prompt === '';
  ui.assembled.textContent = prompt;
  ui.assembled.hidden = empty;
  ui.assembledEmpty.hidden = !empty;
  ui.copyPrompt.disabled = empty;
  ui.promptStats.textContent = `${plural(prompt.length, 'character')} · approx. ${plural(
    estimateTokens(prompt),
    'token',
  )}`;
}

function plural(count, noun) {
  return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
}

ui.copyPrompt.addEventListener('click', () => {
  copyWithFeedback(ui.copyPrompt, assemble(state.elements));
});

// ---------------------------------------------------------------------------
// Clear all

ui.clearAll.addEventListener('click', () => {
  if (typeof ui.confirmClear.showModal !== 'function') {
    if (window.confirm('Clear all seven elements and plug them all back in?')) clearAll();
    return;
  }
  ui.confirmClear.showModal();
});

// Both buttons submit the dialog's form, which closes it; Esc closes it without submitting.
ui.confirmClear.querySelector('form').addEventListener('submit', (event) => {
  if (event.submitter?.value === 'clear') clearAll();
});

function clearAll() {
  state.elements = createEmptyElements();
  syncEditor();
  editorChanged();
  announce('All elements cleared and plugged in.');
}

// ---------------------------------------------------------------------------
// Start

buildEditor();
syncEditor();
renderAssembled();
ui.bootNote.remove();

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(growAll, 150);
});
