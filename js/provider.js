// Calls Gemini, OpenAI and Anthropic straight from the browser with the user's own key, and
// turns anything that goes wrong into a plain message plus a next step.
//
// Every request asks the model for its lowest reasoning setting (OpenAI reasoning off, Claude
// thinking off, Gemini thinking "low"), so Max output tokens goes to the answer instead of to
// hidden reasoning. If a model rejects that setting, the request is sent once more with the
// model's own default, and later runs on that model go straight to the default.

import { ANTHROPIC_VERSION, PROVIDERS, RATE_LIMIT_RETRY_DELAYS_MS } from './constants.js';

// kind is one of: missing-key, invalid-key, no-credit, unknown-model, rate-limit, network,
// blocked, empty, out-of-tokens, too-long, bad-request, server, unknown, cancelled.
// `summary` says what happened, `action` what to do next; `message` is both together.
export class ProviderError extends Error {
  constructor(kind, summary, action = '', status = undefined) {
    super(action ? `${summary} ${action}` : summary);
    this.name = 'ProviderError';
    this.kind = kind;
    this.summary = summary;
    this.action = action;
    this.status = status;
  }
}

// "provider/model" pairs that rejected the low-reasoning setting during this session.
const usesDefaultReasoning = new Set();

// The one entry point. Resolves to { text, truncated, reasoning, durationMs }:
//   truncated   the answer stopped at Max output tokens
//   reasoning   'low', or 'default' when the model wouldn't take the low setting
//   durationMs  how long the successful request took (rate-limit waits not included)
// Rejects with a ProviderError. On a 429 it waits and retries, calling
// onRetryWait({ secondsLeft, retry, retries }) as the countdown runs.
export async function runPrompt({
  provider,
  model,
  apiKey,
  prompt,
  maxTokens,
  signal,
  retryDelaysMs = RATE_LIMIT_RETRY_DELAYS_MS,
  onRetryWait,
}) {
  const adapter = ADAPTERS[provider];
  if (!adapter) {
    throw new ProviderError('bad-request', `Unknown provider "${provider}".`, 'Pick a provider in Settings.');
  }
  const call = {
    provider,
    adapter,
    model,
    prompt,
    maxTokens,
    signal,
    name: PROVIDERS[provider].label,
    key: String(apiKey ?? '').trim(),
  };
  if (!call.key) throw new ProviderError('missing-key', `No API key for ${call.name}.`, 'Add one in Settings.');

  for (let retry = 0; ; retry += 1) {
    try {
      return await sendWithFallback(call);
    } catch (error) {
      if (error.kind !== 'rate-limit' || retryDelaysMs.length === 0) throw error;
      if (retry === retryDelaysMs.length) {
        throw new ProviderError(
          'rate-limit',
          `${call.name} is still rate-limiting requests after ${retry} ${retry === 1 ? 'retry' : 'retries'}.`,
          'Wait a minute, then run again.',
          429,
        );
      }
      await wait(retryDelaysMs[retry], signal, (secondsLeft) =>
        onRetryWait?.({ secondsLeft, retry: retry + 1, retries: retryDelaysMs.length }),
      );
    }
  }
}

async function sendWithFallback(call) {
  const id = `${call.provider}/${call.model}`;
  if (!usesDefaultReasoning.has(id)) {
    try {
      return await send(call, true);
    } catch (error) {
      if (!error.rejectedReasoning) throw error;
      usesDefaultReasoning.add(id);
    }
  }
  return send(call, false);
}

async function send(call, lowReasoning) {
  const { url, headers, body } = call.adapter.request({ ...call, lowReasoning });
  const started = performance.now();
  let response;
  let raw;
  try {
    response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: call.signal });
    raw = await response.text();
  } catch {
    if (call.signal?.aborted) throw cancelled();
    throw await unreachable(call);
  }

  const data = parseJson(raw);
  if (!response.ok) {
    const info = call.adapter.errorInfo(data);
    const error = httpError(call, response.status, info);
    error.rejectedReasoning =
      lowReasoning && response.status === 400 && call.adapter.mentionsReasoning(info.message ?? '', info);
    throw error;
  }
  if (!data || typeof data !== 'object') {
    throw new ProviderError('server', `${call.name} sent a reply the app couldn't read.`, 'Try again in a minute.');
  }

  const { text, stop } = call.adapter.parse(data);
  return finish(call, text, stop, {
    reasoning: lowReasoning ? 'low' : 'default',
    durationMs: Math.round(performance.now() - started),
  });
}

// stop is the provider's stop reason in common terms: complete, max-tokens, blocked, error, other.
function finish(call, text, stop, extra) {
  if (stop === 'error') {
    throw new ProviderError('server', `${call.name} couldn't finish the answer.`, 'Try again in a minute.');
  }
  if (text.trim()) return { text, truncated: stop === 'max-tokens', ...extra };
  if (stop === 'blocked') {
    throw new ProviderError('blocked', "Blocked by the provider's safety filter.", 'Rephrase the prompt and run it again.');
  }
  if (stop === 'max-tokens') {
    throw new ProviderError(
      'out-of-tokens',
      `${call.name} used up Max output tokens before writing an answer.`,
      'Raise Max output tokens in Settings.',
    );
  }
  throw new ProviderError(
    'empty',
    `${call.name} sent back an empty response.`,
    'Run it again, or try a different model in Settings.',
  );
}

function httpError(call, status, info) {
  const special = call.adapter.classify?.(status, info, call);
  if (special) return special;

  if (status === 401 || status === 403) return invalidKey(call, status);
  if (status === 402) return noCredit(call, status);
  if (status === 404) {
    return new ProviderError(
      'unknown-model',
      `${call.name} doesn't recognise the model "${call.model}".`,
      'This model name may be retired. Change it in Settings.',
      status,
    );
  }
  if (status === 413) return tooLong(status);
  if (status === 429) {
    return new ProviderError('rate-limit', `${call.name} is rate-limiting requests right now.`, 'Wait a moment, then try again.', status);
  }
  if (status === 400 || status === 422) {
    const detail = tidyDetail(info.message, call.key);
    if (/max[_ ]?(output[_ ]?|completion[_ ]?)?tokens|maxOutputTokens/i.test(detail)) {
      return new ProviderError('bad-request', 'Max output tokens is outside the range this model allows.', 'Change it in Settings.', status);
    }
    if (/context (window|length)|too long|too many (input )?tokens/i.test(detail)) return tooLong(status);
    return new ProviderError(
      'bad-request',
      detail ? `${call.name} couldn't process the request: ${detail}` : `${call.name} couldn't process the request.`,
      'Check Settings, then try again.',
      status,
    );
  }
  if (status >= 500) {
    return new ProviderError('server', `${call.name} is having trouble right now.`, 'Try again in a minute.', status);
  }
  return new ProviderError('unknown', `${call.name} returned an unexpected error (${status}).`, 'Try again in a minute.', status);
}

function invalidKey(call, status) {
  const page = PROVIDERS[call.provider].keyPage.name;
  return new ProviderError(
    'invalid-key',
    `${call.name} didn't accept the API key.`,
    `Check you copied the whole key from ${page}, or create a new one there, then paste it into Settings.`,
    status,
  );
}

function noCredit(call, status) {
  return new ProviderError(
    'no-credit',
    `Your ${call.name} account has no API credit left.`,
    `Add credit or a payment method in your ${call.name} account's billing settings, then try again.`,
    status,
  );
}

function spendLimit(call, status) {
  return new ProviderError(
    'no-credit',
    `Your ${call.name} spending limit has been reached.`,
    "Raise it in your account's billing settings, or wait for it to reset.",
    status,
  );
}

function tooLong(status) {
  return new ProviderError('too-long', 'The prompt is too long for this model.', 'Shorten it or unplug an element, then try again.', status);
}

function cancelled() {
  return new ProviderError('cancelled', 'Cancelled.');
}

async function unreachable(call) {
  // OpenAI leaves the CORS header off some error replies, so the browser reports a wrong key
  // as a failed request. Its model list does reply readably, so ask it whether the key is the
  // problem before blaming the network.
  if (call.adapter.keyIsRejected && (await call.adapter.keyIsRejected(call.key, call.signal))) {
    return invalidKey(call, 401);
  }
  if (call.signal?.aborted) return cancelled();
  return new ProviderError(
    'network',
    `Couldn't reach ${call.name}.`,
    'Check your internet connection, then try again. A browser extension that blocks requests can also cause this.',
  );
}

// One line of the provider's own wording, for errors the app has no better message for.
// The key is removed in case the provider quotes it back.
function tidyDetail(message, key) {
  let text = String(message ?? '').replace(/\s+/g, ' ').trim();
  if (key) text = text.split(key).join('[your key]');
  if (text.length > 180) text = `${text.slice(0, 177).trimEnd()}…`;
  if (text && !/[.!?…]$/.test(text)) text += '.';
  return text;
}

function parseJson(raw) {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// Resolves after ms, calling onTick(secondsLeft) each time the whole-second count changes and
// onTick(0) at the end. Rejects with "cancelled" if the signal aborts first.
function wait(ms, signal, onTick) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelled());
      return;
    }
    const end = Date.now() + ms;
    let shown;
    const tick = () => {
      const secondsLeft = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      if (secondsLeft !== shown) {
        shown = secondsLeft;
        onTick?.(secondsLeft);
      }
    };
    const onAbort = () => {
      cleanup();
      reject(cancelled());
    };
    const ticker = setInterval(tick, 200);
    const timer = setTimeout(() => {
      cleanup();
      if (shown !== 0) onTick?.(0);
      resolve();
    }, ms);
    function cleanup() {
      clearInterval(ticker);
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    tick();
  });
}

// ---------------------------------------------------------------------------
// Request and response shapes, one adapter per provider.

const GEMINI_STOP = {
  STOP: 'complete',
  MAX_TOKENS: 'max-tokens',
  SAFETY: 'blocked',
  RECITATION: 'blocked',
  BLOCKLIST: 'blocked',
  PROHIBITED_CONTENT: 'blocked',
  SPII: 'blocked',
  IMAGE_SAFETY: 'blocked',
};

const ANTHROPIC_STOP = {
  end_turn: 'complete',
  stop_sequence: 'complete',
  max_tokens: 'max-tokens',
  refusal: 'blocked',
};

const ADAPTERS = {
  gemini: {
    request({ model, key, prompt, maxTokens, lowReasoning }) {
      const generationConfig = { maxOutputTokens: maxTokens };
      if (lowReasoning) generationConfig.thinkingConfig = { thinkingLevel: 'low' };
      const id = encodeURIComponent(model.replace(/^models\//, ''));
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${id}:generateContent`,
        // The key goes in a header, never in the URL.
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig },
      };
    },
    parse(data) {
      const candidate = data.candidates?.[0];
      // An empty candidate list is how Gemini reports a prompt its safety filter blocked.
      if (!candidate) return { text: '', stop: 'blocked' };
      const text = (candidate.content?.parts ?? [])
        .filter((part) => typeof part?.text === 'string' && !part.thought)
        .map((part) => part.text)
        .join('');
      return { text, stop: GEMINI_STOP[candidate.finishReason] ?? 'other' };
    },
    errorInfo(data) {
      const error = data?.error ?? {};
      const reasons = (error.details ?? []).map((detail) => detail?.reason).filter(Boolean);
      return { message: error.message, status: error.status, reasons };
    },
    // Gemini answers a bad key with 400, not 401.
    classify(status, info, call) {
      if (status === 400 && (info.reasons.includes('API_KEY_INVALID') || /api key/i.test(info.message ?? ''))) {
        return invalidKey(call, status);
      }
      return null;
    },
    mentionsReasoning: (message) => /thinking/i.test(message),
  },

  openai: {
    request({ model, key, prompt, maxTokens, lowReasoning }) {
      // store: false stops OpenAI keeping the response for later retrieval (it defaults to true).
      const body = { model, input: prompt, max_output_tokens: maxTokens, store: false };
      if (lowReasoning) body.reasoning = { effort: 'none' };
      return {
        url: 'https://api.openai.com/v1/responses',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body,
      };
    },
    parse(data) {
      // The answer is in the "message" items of `output`, which can also hold reasoning items.
      const text = (data.output ?? [])
        .filter((item) => item?.type === 'message')
        .map((item) =>
          (item.content ?? [])
            .map((part) => (part?.type === 'output_text' ? part.text : part?.type === 'refusal' ? part.refusal : ''))
            .filter((piece) => typeof piece === 'string')
            .join(''),
        )
        .join('\n\n');
      let stop = 'complete';
      if (data.status === 'failed') stop = 'error';
      else if (data.status === 'incomplete') {
        const reason = data.incomplete_details?.reason;
        stop = reason === 'max_output_tokens' ? 'max-tokens' : reason === 'content_filter' ? 'blocked' : 'other';
      }
      return { text, stop };
    },
    errorInfo(data) {
      const error = data?.error ?? {};
      return { message: error.message, code: error.code, type: error.type, param: error.param };
    },
    // 429 covers running out of credit and hitting a spending limit as well as rate limits;
    // only rate limits are worth retrying.
    classify(status, info, call) {
      if (status !== 429) return null;
      if (/spend_limit|usage_limit/.test(info.code ?? '')) return spendLimit(call, status);
      if (
        info.code === 'credit_balance_exhausted' ||
        info.code === 'insufficient_quota' ||
        (info.type === 'insufficient_quota' && !info.code)
      ) {
        return noCredit(call, status);
      }
      return null;
    },
    mentionsReasoning: (message, info) => /reasoning|effort/i.test(message) || /^reasoning/.test(info?.param ?? ''),
    async keyIsRejected(key, signal) {
      try {
        const response = await fetch('https://api.openai.com/v1/models', {
          headers: { Authorization: `Bearer ${key}` },
          signal,
        });
        return response.status === 401;
      } catch {
        return false;
      }
    },
  },

  anthropic: {
    request({ model, key, prompt, maxTokens, lowReasoning }) {
      const body = { model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] };
      if (lowReasoning) body.thinking = { type: 'disabled' };
      return {
        url: 'https://api.anthropic.com/v1/messages',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': ANTHROPIC_VERSION,
          // Anthropic only accepts calls made straight from a browser with this header.
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body,
      };
    },
    parse(data) {
      const text = (data.content ?? [])
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('');
      return { text, stop: ANTHROPIC_STOP[data.stop_reason] ?? 'other' };
    },
    errorInfo(data) {
      const error = data?.error ?? {};
      return { message: error.message, type: error.type };
    },
    classify(status, info, call) {
      const message = info.message ?? '';
      if (info.type === 'billing_error' || (status === 400 && /credit balance/i.test(message))) {
        return noCredit(call, status);
      }
      if (status === 400 && /spend(ing)? limit/i.test(message)) return spendLimit(call, status);
      return null;
    },
    mentionsReasoning: (message) => /thinking/i.test(message),
  },
};
