// State and wiring. The logic lives in the pure modules (elements.js, provider.js); this is the
// only file that touches the DOM or sessionStorage.

import {
  ELEMENTS,
  assemble,
  cloneElements,
  compareElements,
  createEmptyElements,
  estimateTokens,
  hasContent,
  normalizeElements,
  textKeys,
} from './elements.js';
import { DEFAULT_PROVIDER, MAX_OUTPUT_TOKENS, PROVIDERS, TEST_PROMPT } from './constants.js';
import { diffWords, textStats } from './diff.js';
import { ProviderError, runPrompt } from './provider.js';

const STORAGE = {
  editor: 'pp.editor.v1',
  settings: 'pp.settings.v1',
  keys: 'pp.keys.v1', // API keys: sessionStorage only, so they go when the tab closes
};
const FEEDBACK_MS = 1600;
const PROVIDER_IDS = Object.keys(PROVIDERS);
// Test connection errors that still prove the key and model work: the model did answer.
const ANSWERED = new Set(['empty', 'blocked', 'out-of-tokens']);

// sessionStorage throws when storage is disabled or full. The app keeps working without it.
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
      // Saving is a convenience; carry on without it.
    }
  },
};

function clampTokens(value, fallback) {
  const number = Number(value);
  if (value === '' || value == null || !Number.isFinite(number)) return fallback;
  return Math.min(MAX_OUTPUT_TOKENS.max, Math.max(MAX_OUTPUT_TOKENS.min, Math.round(number)));
}

function normalizeSettings(raw) {
  const settings = {
    provider: DEFAULT_PROVIDER,
    models: Object.fromEntries(PROVIDER_IDS.map((id) => [id, PROVIDERS[id].defaultModel])),
    maxTokens: MAX_OUTPUT_TOKENS.default,
  };
  if (!raw || typeof raw !== 'object') return settings;
  if (PROVIDER_IDS.includes(raw.provider)) settings.provider = raw.provider;
  for (const id of PROVIDER_IDS) {
    const model = raw.models?.[id];
    if (typeof model === 'string' && model.trim()) settings.models[id] = model.trim();
  }
  settings.maxTokens = clampTokens(raw.maxTokens, settings.maxTokens);
  return settings;
}

function normalizeKeys(raw) {
  return Object.fromEntries(PROVIDER_IDS.map((id) => [id, typeof raw?.[id] === 'string' ? raw[id] : '']));
}

const state = {
  elements: normalizeElements(session.read(STORAGE.editor)?.elements),
  settings: normalizeSettings(session.read(STORAGE.settings)),
  keys: normalizeKeys(session.read(STORAGE.keys)),
  runs: [], // newest first; kept in memory only, so a reload clears them
  runCount: 0,
  viewedRunId: null,
  compareIds: [], // ticked runs, in the order they were ticked (at most two)
  active: null, // the run in progress: { controller, startedAt, timer, retrying, edited }
  test: null, // AbortController for a Test connection in progress
};

const $ = (id) => document.getElementById(id);
const ui = {
  topbar: $('topbar'),
  main: $('main'),
  bootNote: $('boot-note'),
  elementList: $('element-list'),
  clearAll: $('clear-all'),
  confirmClear: $('confirm-clear'),
  assembled: $('assembled'),
  assembledEmpty: $('assembled-empty'),
  promptStats: $('prompt-stats'),
  copyPrompt: $('copy-prompt'),
  run: $('run'),
  runShortcut: $('run-shortcut'),
  cancel: $('cancel'),
  editedBadge: $('edited-badge'),
  runStatus: $('run-status'),
  runSetup: $('run-setup'),
  outputSection: $('output-section'),
  outputMeta: $('output-meta'),
  outputActions: $('output-actions'),
  output: $('output'),
  outputNote: $('output-note'),
  outputEmpty: $('output-empty'),
  sentPrompt: $('sent-prompt'),
  sentPromptSummary: $('sent-prompt-summary'),
  sentPromptText: $('sent-prompt-text'),
  copyOutput: $('copy-output'),
  loadRun: $('load-run'),
  runs: $('runs'),
  runsTitle: $('runs-title'),
  runsToggle: $('runs-toggle'),
  runsCount: $('runs-count'),
  runsClose: $('runs-close'),
  runList: $('run-list'),
  runsEmpty: $('runs-empty'),
  compareOpen: $('compare-open'),
  compareHint: $('compare-hint'),
  compare: $('compare'),
  compareTitle: $('compare-title'),
  compareClose: $('compare-close'),
  setupChanges: $('setup-changes'),
  columns: {
    left: { title: $('left-title'), stats: $('left-stats'), output: $('left-output') },
    right: { title: $('right-title'), stats: $('right-stats'), output: $('right-output') },
  },
  diffLegend: $('diff-legend'),
  diffIdentical: $('diff-identical'),
  wordDiff: $('word-diff'),
  scrim: $('scrim'),
  openSettings: $('open-settings'),
  settings: $('settings'),
  settingsClose: $('settings-close'),
  providerOptions: $('provider-options'),
  apiKey: $('api-key'),
  apiKeyLabel: $('api-key-label'),
  apiKeyNote: $('api-key-note'),
  model: $('model'),
  modelNote: $('model-note'),
  maxTokens: $('max-tokens'),
  testConnection: $('test-connection'),
  testResult: $('test-result'),
  announcer: $('announcer'),
  alerter: $('alerter'),
};

// ---------------------------------------------------------------------------
// DOM helpers

// h('button', { class: 'btn', type: 'button' }, 'Label', childNode, …). Strings become text
// nodes, so text typed by the user (or sent back by a model) is never parsed as HTML.
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

// Screen-reader announcements for changes that don't move focus. Clearing first and setting
// the text a moment later makes a repeated message get read again.
function speak(region, message) {
  region.textContent = '';
  clearTimeout(region.timer);
  region.timer = setTimeout(() => {
    region.textContent = message;
  }, 60);
}
const announce = (message) => speak(ui.announcer, message);
const alertNow = (message) => speak(ui.alerter, message);

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
    // The async clipboard needs a secure context (https or localhost) and a focused page;
    // fall back to the older select-and-copy route.
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

function plural(count, noun) {
  return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatDuration(ms) {
  return ms < 10000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}

const isMac = /Mac|iPhone|iPad/.test(navigator.userAgentData?.platform ?? navigator.platform ?? '');

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
  session.write(STORAGE.editor, { elements: state.elements });
  if (state.active) state.active.edited = true;
  renderAssembled();
  renderRunControls();
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
// Settings

function currentSetup() {
  const { provider, models, maxTokens } = state.settings;
  return { provider, model: models[provider].trim() || PROVIDERS[provider].defaultModel, maxTokens };
}

function settingsChanged() {
  session.write(STORAGE.settings, state.settings);
  renderRunControls();
}

function buildProviderOptions() {
  ui.providerOptions.replaceChildren(
    ...PROVIDER_IDS.map((id) =>
      h('label', {}, h('input', { type: 'radio', name: 'provider', value: id }), PROVIDERS[id].label),
    ),
  );
  ui.maxTokens.min = String(MAX_OUTPUT_TOKENS.min);
  ui.maxTokens.max = String(MAX_OUTPUT_TOKENS.max);
}

// Pushes state into the Settings form. The key and model fields show the chosen provider's.
function syncSettingsForm() {
  const { provider, models, maxTokens } = state.settings;
  const info = PROVIDERS[provider];
  for (const radio of ui.providerOptions.querySelectorAll('input')) radio.checked = radio.value === provider;
  ui.apiKeyLabel.textContent = `${info.label} API key`;
  ui.apiKey.value = state.keys[provider];
  ui.apiKeyNote.textContent = `Stays in this browser tab (cleared when you close it) and is sent only to ${info.company}.`;
  ui.model.value = models[provider];
  ui.model.placeholder = info.defaultModel;
  ui.modelNote.textContent = `Default: ${info.defaultModel}`;
  ui.maxTokens.value = String(maxTokens);
}

function showTestResult(kind, message) {
  ui.testResult.className = kind ? `test-result is-${kind}` : 'test-result';
  ui.testResult.textContent = message;
}

function stopTest() {
  state.test?.abort();
  state.test = null;
  ui.testConnection.disabled = false;
  showTestResult('', '');
}

ui.openSettings.addEventListener('click', openSettings);
ui.runSetup.addEventListener('click', openSettings);

function openSettings() {
  syncSettingsForm();
  ui.settings.showModal();
}

function closeSettings() {
  stopTest();
  ui.settings.close();
}

ui.settingsClose.addEventListener('click', closeSettings);
// A click on the dimmed backdrop lands on the dialog element itself.
ui.settings.addEventListener('click', (event) => {
  if (event.target === ui.settings) closeSettings();
});
ui.settings.addEventListener('cancel', () => stopTest());

ui.providerOptions.addEventListener('change', (event) => {
  if (!event.target.checked) return;
  state.settings.provider = event.target.value;
  stopTest();
  syncSettingsForm();
  settingsChanged();
});

ui.apiKey.addEventListener('input', () => {
  state.keys[state.settings.provider] = ui.apiKey.value;
  session.write(STORAGE.keys, state.keys);
  stopTest();
});

ui.model.addEventListener('input', () => {
  state.settings.models[state.settings.provider] = ui.model.value;
  stopTest();
  settingsChanged();
});

// An emptied model field goes back to the default rather than staying blank.
ui.model.addEventListener('change', () => {
  const { provider } = state.settings;
  const model = ui.model.value.trim() || PROVIDERS[provider].defaultModel;
  ui.model.value = model;
  state.settings.models[provider] = model;
  settingsChanged();
});

ui.maxTokens.addEventListener('input', () => {
  const value = Number(ui.maxTokens.value);
  if (Number.isInteger(value) && value >= MAX_OUTPUT_TOKENS.min && value <= MAX_OUTPUT_TOKENS.max) {
    state.settings.maxTokens = value;
    settingsChanged();
  }
});

ui.maxTokens.addEventListener('change', () => {
  state.settings.maxTokens = clampTokens(ui.maxTokens.value, state.settings.maxTokens);
  ui.maxTokens.value = String(state.settings.maxTokens);
  settingsChanged();
});

ui.testConnection.addEventListener('click', testConnection);

async function testConnection() {
  const setup = currentSetup();
  const { label } = PROVIDERS[setup.provider];
  if (!state.keys[setup.provider].trim()) {
    showTestResult('error', `Paste your ${label} API key into the field above first.`);
    return;
  }
  state.test?.abort();
  const controller = new AbortController();
  state.test = controller;
  ui.testConnection.disabled = true;
  showTestResult('', `Testing ${label}…`);
  try {
    await runPrompt({
      ...setup,
      apiKey: state.keys[setup.provider],
      prompt: TEST_PROMPT,
      signal: controller.signal,
      retryDelaysMs: [],
    });
    showTestResult('ok', `Connected. ${label} answered using ${setup.model}.`);
  } catch (error) {
    if (state.test !== controller) return; // superseded or closed
    if (error instanceof ProviderError && ANSWERED.has(error.kind)) {
      showTestResult('ok', `Connected. The key and ${setup.model} work.`);
    } else if (error instanceof ProviderError) {
      showTestResult('error', error.message);
    } else {
      console.error(error);
      showTestResult('error', 'Something went wrong. Try again.');
    }
  } finally {
    if (state.test === controller) {
      state.test = null;
      ui.testConnection.disabled = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Run

// True when running now would send a different prompt or settings from the most recent run.
function editedSinceLastRun() {
  const last = state.runs[0];
  if (!last) return false;
  const setup = currentSetup();
  return (
    assemble(state.elements) !== last.assembledPrompt ||
    setup.provider !== last.provider ||
    setup.model !== last.model ||
    setup.maxTokens !== last.maxTokens
  );
}

function canRun() {
  return !state.active && assemble(state.elements) !== '';
}

function renderRunControls() {
  const running = Boolean(state.active);
  // aria-disabled rather than disabled, so the button keeps focus while a run is in progress.
  ui.run.setAttribute('aria-disabled', String(!canRun()));
  ui.cancel.hidden = !running;
  ui.editedBadge.hidden = running || !editedSinceLastRun();
  const { provider, model } = currentSetup();
  const setup = `${PROVIDERS[provider].label} · ${model}`;
  ui.runSetup.textContent = setup;
  ui.runSetup.setAttribute('aria-label', `${setup}: open Settings`);
}

function setStatus(kind, message, action = '') {
  ui.runStatus.className = kind ? `run-status is-${kind}` : 'run-status';
  const parts = [h('span', {}, message)];
  if (kind === 'running') parts.unshift(h('span', { class: 'spinner', 'aria-hidden': 'true' }));
  if (action) parts.push(h('span', { class: 'status-action' }, action));
  ui.runStatus.replaceChildren(...parts);
}

function showWaiting(active, name) {
  const seconds = Math.floor((Date.now() - active.startedAt) / 1000);
  setStatus('running', seconds ? `Waiting for ${name}… ${seconds} s` : `Waiting for ${name}…`);
}

ui.run.addEventListener('click', startRun);

ui.cancel.addEventListener('click', () => {
  state.active?.controller.abort();
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.isComposing) return;
  if (document.querySelector('dialog[open]')) return;
  event.preventDefault();
  startRun();
});

async function startRun() {
  if (!canRun()) return;
  const prompt = assemble(state.elements);
  const setup = currentSetup();
  const elements = cloneElements(state.elements);
  const name = PROVIDERS[setup.provider].label;
  const active = {
    controller: new AbortController(),
    startedAt: Date.now(),
    timer: 0,
    retrying: 0,
    edited: false,
  };
  state.active = active;
  renderRunControls();
  showWaiting(active, name);
  active.timer = setInterval(() => {
    if (!active.retrying) showWaiting(active, name);
  }, 1000);
  announce(`Running on ${name}.`);

  try {
    const result = await runPrompt({
      ...setup,
      apiKey: state.keys[setup.provider],
      prompt,
      signal: active.controller.signal,
      onRetryWait: ({ secondsLeft, retry, retries }) => {
        if (secondsLeft === 0) {
          active.retrying = 0;
          showWaiting(active, name);
          return;
        }
        if (active.retrying !== retry) {
          active.retrying = retry;
          announce(`${name} is rate-limiting requests. Retrying in ${secondsLeft} seconds.`);
        }
        setStatus('running', `${name} is rate-limiting requests. Retrying in ${secondsLeft} s (retry ${retry} of ${retries}).`);
      },
    });
    const run = addRun({
      ...setup,
      elements,
      assembledPrompt: prompt,
      output: result.text,
      durationMs: result.durationMs,
      truncated: result.truncated,
      reasoning: result.reasoning,
    });
    setStatus('done', `Run #${run.number} finished in ${formatDuration(run.durationMs)}.`);
    announce(`Run ${run.number} finished.`);
    // Leave the page where it is if the user kept editing while waiting.
    if (!active.edited) revealOutput();
  } catch (error) {
    if (error instanceof ProviderError && error.kind === 'cancelled') {
      setStatus('', 'Cancelled.');
      announce('Cancelled.');
    } else {
      const problem = error instanceof ProviderError ? error : unexpected(error);
      setStatus('error', problem.summary, problem.action);
      alertNow(problem.message);
    }
  } finally {
    clearInterval(active.timer);
    const cancelHadFocus = document.activeElement === ui.cancel;
    state.active = null;
    renderRunControls();
    if (cancelHadFocus) ui.run.focus();
  }
}

function unexpected(error) {
  console.error(error);
  return new ProviderError('unknown', 'Something went wrong.', 'Try again, and reload the page if it keeps happening.');
}

function addRun(details) {
  state.runCount += 1;
  const run = { id: `run-${state.runCount}`, number: state.runCount, createdAt: Date.now(), ...details };
  state.runs.unshift(run);
  state.viewedRunId = run.id;
  renderRuns();
  renderOutput();
  return run;
}

function revealOutput() {
  if (ui.outputSection.getBoundingClientRect().top < window.innerHeight - 160) return;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  ui.outputSection.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
}

// ---------------------------------------------------------------------------
// Output panel

function viewedRun() {
  return state.runs.find((run) => run.id === state.viewedRunId) ?? null;
}

function renderOutput() {
  const run = viewedRun();
  ui.outputEmpty.hidden = Boolean(run);
  for (const node of [ui.output, ui.outputActions, ui.sentPrompt]) node.hidden = !run;
  if (!run) {
    ui.outputMeta.textContent = '';
    ui.outputNote.hidden = true;
    return;
  }
  const meta = [
    `Run #${run.number}`,
    formatTime(run.createdAt),
    `${PROVIDERS[run.provider].label} · ${run.model}`,
    formatDuration(run.durationMs),
  ];
  if (run.reasoning === 'default') meta.push("model's default reasoning");
  ui.outputMeta.textContent = meta.join(' · ');
  ui.output.textContent = run.output;
  ui.outputNote.hidden = !run.truncated;
  ui.outputNote.textContent = run.truncated
    ? `Stopped at the Max output tokens limit (${run.maxTokens.toLocaleString()}). Raise it in Settings for a longer answer.`
    : '';
  ui.sentPromptSummary.textContent = `Prompt sent in run #${run.number}`;
  ui.sentPromptText.textContent = run.assembledPrompt;
}

ui.copyOutput.addEventListener('click', () => {
  const run = viewedRun();
  if (run) copyWithFeedback(ui.copyOutput, run.output);
});

ui.loadRun.addEventListener('click', () => {
  const run = viewedRun();
  if (!run) return;
  state.elements = cloneElements(run.elements);
  state.settings.provider = run.provider;
  state.settings.models[run.provider] = run.model;
  state.settings.maxTokens = run.maxTokens;
  syncEditor();
  syncSettingsForm();
  session.write(STORAGE.settings, state.settings);
  editorChanged();
  flashLabel(ui.loadRun, 'Loaded');
  announce(`Run ${run.number} loaded into the editor.`);
});

// ---------------------------------------------------------------------------
// Run list

function renderRuns() {
  ui.runsCount.textContent = String(state.runs.length);
  ui.runsEmpty.hidden = state.runs.length > 0;
  ui.runList.replaceChildren(...state.runs.map(runItem));
  syncPicks();
}

function findRun(id) {
  return state.runs.find((run) => run.id === id);
}

function runItem(run) {
  const plugged = ELEMENTS.filter((def) => run.elements[def.id].plugged).map((def) => def.label);
  return h(
    'li',
    { class: 'run-item' },
    h(
      'button',
      {
        type: 'button',
        class: 'run-open',
        'data-run': run.id,
        'aria-current': run.id === state.viewedRunId ? 'true' : null,
      },
      h(
        'span',
        { class: 'run-line' },
        h('span', { class: 'run-number' }, `Run #${run.number}`),
        h('span', { class: 'run-meta' }, `${formatTime(run.createdAt)} · ${formatDuration(run.durationMs)}`),
      ),
      h('span', { class: 'run-model' }, `${PROVIDERS[run.provider].label} · ${run.model}`),
      h(
        'span',
        { class: 'chips' },
        h('span', { class: 'sr-only' }, plugged.length ? `Plugged: ${plugged.join(', ')}.` : 'Nothing plugged.'),
        ELEMENTS.map((def) => chip(def, run.elements[def.id])),
      ),
    ),
    // After the card in the page order, so Tab reaches the run before its checkbox.
    h(
      'label',
      { class: 'run-pick', title: 'Tick to compare' },
      h('input', { type: 'checkbox', 'data-pick': run.id, 'aria-label': `Compare run #${run.number}` }),
    ),
  );
}

// Two-letter chip, filled when the element was plugged in for the run, hollow when not.
function chip(def, element) {
  let title = `${def.label}: ${element.plugged ? 'plugged' : 'unplugged'}`;
  if (element.plugged && !hasContent(def, element)) title += ' (empty, so not sent)';
  return h('span', { class: element.plugged ? 'chip is-on' : 'chip', title, 'aria-hidden': 'true' }, def.chip);
}

ui.runList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-run]');
  if (!button) return;
  state.viewedRunId = button.dataset.run;
  for (const item of ui.runList.querySelectorAll('[data-run]')) {
    if (item.dataset.run === state.viewedRunId) item.setAttribute('aria-current', 'true');
    else item.removeAttribute('aria-current');
  }
  renderOutput();
  if (!wideScreen.matches) {
    closeRunsDrawer({ restoreFocus: false });
    ui.output.focus({ preventScroll: true });
  }
  revealOutput();
});

// Up to two runs can be ticked for comparison; ticking a third unticks the one ticked first.
ui.runList.addEventListener('change', (event) => {
  const box = event.target.closest('input[data-pick]');
  if (!box) return;
  const ids = state.compareIds.filter((id) => id !== box.dataset.pick);
  if (box.checked) ids.push(box.dataset.pick);
  const dropped = ids.length > 2 ? ids.shift() : null;
  state.compareIds = ids;
  syncPicks();
  if (dropped) announce(`Run ${findRun(dropped).number} unticked. You can compare two runs at a time.`);
});

function syncPicks() {
  for (const box of ui.runList.querySelectorAll('input[data-pick]')) {
    box.checked = state.compareIds.includes(box.dataset.pick);
  }
  const ticked = state.compareIds.map((id) => findRun(id).number).sort((a, b) => a - b);
  ui.compareOpen.setAttribute('aria-disabled', String(ticked.length !== 2));
  ui.compareHint.hidden = state.runs.length === 0;
  ui.compareHint.textContent =
    ticked.length === 2
      ? `Run #${ticked[0]} and run #${ticked[1]} are ticked.`
      : ticked.length === 1
        ? 'Tick one more run to compare.'
        : 'Tick two runs to compare them.';
}

// Below 1024px the run list is a drawer that slides over the page.
const wideScreen = window.matchMedia('(min-width: 1024px)');

function openRunsDrawer() {
  document.body.classList.add('runs-open');
  ui.runsToggle.setAttribute('aria-expanded', 'true');
  ui.scrim.hidden = false;
  ui.main.inert = true;
  ui.topbar.inert = true;
  ui.runsTitle.focus();
}

function closeRunsDrawer({ restoreFocus = true } = {}) {
  if (!document.body.classList.contains('runs-open')) return;
  document.body.classList.remove('runs-open');
  ui.runsToggle.setAttribute('aria-expanded', 'false');
  ui.scrim.hidden = true;
  ui.main.inert = false;
  ui.topbar.inert = false;
  if (restoreFocus) ui.runsToggle.focus();
}

ui.runsToggle.addEventListener('click', openRunsDrawer);
ui.runsClose.addEventListener('click', () => closeRunsDrawer());
ui.scrim.addEventListener('click', () => closeRunsDrawer());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.body.classList.contains('runs-open')) closeRunsDrawer();
});
wideScreen.addEventListener('change', () => {
  if (wideScreen.matches) closeRunsDrawer({ restoreFocus: false });
});

// ---------------------------------------------------------------------------
// Compare view

ui.compareOpen.addEventListener('click', () => {
  if (state.compareIds.length !== 2) return;
  const [older, newer] = state.compareIds.map(findRun).sort((a, b) => a.number - b.number);
  renderCompare(older, newer);
  ui.compare.showModal();
  ui.compare.scrollTop = 0;
});

ui.compareClose.addEventListener('click', () => ui.compare.close());
// A click on the dimmed backdrop lands on the dialog element itself.
ui.compare.addEventListener('click', (event) => {
  if (event.target === ui.compare) ui.compare.close();
});

function renderCompare(older, newer) {
  ui.compareTitle.textContent = `Compare run #${older.number} and run #${newer.number}`;

  const changes = setupChanges(older, newer);
  ui.setupChanges.replaceChildren(
    changes.length
      ? h('ul', { class: 'setup-list' }, changes.map((change) => h('li', {}, change)))
      : h('p', { class: 'setup-same' }, 'Same prompt and settings — differences below are run-to-run variation.'),
  );

  fillColumn(ui.columns.left, older);
  fillColumn(ui.columns.right, newer);

  const segments = diffWords(older.output, newer.output);
  ui.diffIdentical.hidden = !segments.every((segment) => segment.type === 'same');
  ui.diffLegend.replaceChildren(
    h('span', { class: 'mark-remove' }, 'Struck through'),
    ` only in run #${older.number} · `,
    h('span', { class: 'mark-add' }, 'underlined'),
    ` only in run #${newer.number}`,
  );
  ui.wordDiff.replaceChildren(...diffNodes(segments));
}

// One entry per difference between the two runs' setups, oldest value first.
function setupChanges(older, newer) {
  const label = (id) => ELEMENTS.find((def) => def.id === id).label;
  const names = (ids, run) =>
    ids
      .map((id) => {
        const def = ELEMENTS.find((candidate) => candidate.id === id);
        return hasContent(def, run.elements[id]) ? def.label : `${def.label} (empty)`;
      })
      .join(', ');
  const change = (name, from, to) => [
    h('strong', {}, `${name}: `),
    from,
    h('span', { 'aria-hidden': 'true' }, ' → '),
    h('span', { class: 'sr-only' }, ' changed to '),
    to,
  ];

  const { onlyBefore, onlyAfter, textChanged } = compareElements(older.elements, newer.elements);
  const changes = [];
  if (onlyBefore.length) changes.push([h('strong', {}, `Plugged in run #${older.number} only: `), names(onlyBefore, older)]);
  if (onlyAfter.length) changes.push([h('strong', {}, `Plugged in run #${newer.number} only: `), names(onlyAfter, newer)]);
  if (textChanged.length) changes.push([h('strong', {}, 'Text changed: '), textChanged.map(label).join(', ')]);
  if (older.provider !== newer.provider) {
    changes.push(change('Provider', PROVIDERS[older.provider].label, PROVIDERS[newer.provider].label));
  }
  if (older.model !== newer.model) changes.push(change('Model', older.model, newer.model));
  if (older.maxTokens !== newer.maxTokens) {
    changes.push(change('Max output tokens', older.maxTokens.toLocaleString(), newer.maxTokens.toLocaleString()));
  }
  return changes;
}

function fillColumn(column, run) {
  const { words, paragraphs, listItems } = textStats(run.output);
  const stats = [plural(words, 'word'), plural(paragraphs, 'paragraph'), plural(listItems, 'list item')];
  if (run.truncated) stats.push('stopped at the token limit');
  column.title.textContent = `Run #${run.number} · ${run.model}`;
  column.stats.textContent = stats.join(' · ');
  column.output.textContent = run.output;
}

// Removed words become <del>, added words <ins>. Leading whitespace stays outside the mark so
// the strike-through or underline doesn't run into the gap before a word.
function diffNodes(segments) {
  const nodes = [];
  for (const { type, text } of segments) {
    if (type === 'same') {
      nodes.push(text);
      continue;
    }
    const [, lead, body] = /^(\s*)([\s\S]*)$/.exec(text);
    if (lead) nodes.push(lead);
    if (body) nodes.push(h(type === 'remove' ? 'del' : 'ins', {}, body));
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// Start

buildEditor();
buildProviderOptions();
syncEditor();
syncSettingsForm();
renderAssembled();
renderRuns();
renderOutput();
renderRunControls();
ui.runShortcut.textContent = isMac ? '⌘ Enter' : 'Ctrl Enter';
ui.bootNote.remove();

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(growAll, 150);
});
