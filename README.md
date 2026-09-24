# Prompt Playground

A small web page for testing prompts. You fill in up to seven prompt elements (Persona, Task, Context, Examples, Rules, Criteria, Steps), plug or unplug each one, run the assembled prompt against Gemini, OpenAI or Anthropic with your own API key, and compare any two runs side by side with a word diff.

It is a static site: plain HTML, CSS and JavaScript modules. There is no framework, no build step, no backend and nothing to install. A how-to guide opens on the first visit; after that it is under **How to use** in the top bar.

## Run it on your computer

Browsers won't load JavaScript modules from a file opened by double-clicking, so serve the folder with a local web server. From this folder:

```bash
python -m http.server 8000
```

Then open <http://localhost:8000>.

If that command doesn't work:

- Windows without `python` on the PATH: `py -m http.server 8000`
- macOS or Linux: `python3 -m http.server 8000`
- With Node.js installed: `npx serve .` (fetches a small server the first time)

If the page says it didn't start, it was opened as a file, or the server sent the JavaScript files with the wrong type. Use one of the commands above; on Windows, `npx serve .` avoids a registry setting that can make Python serve `.js` files as plain text.

## Put it online

Copy these to any static web host (GitHub Pages, Netlify, Cloudflare Pages, a storage bucket, a school web server):

- `index.html`
- `css/`
- `js/`

Nothing else is needed at runtime. All paths are relative, so it also works from a subfolder, such as a GitHub Pages project site. For GitHub Pages: in the repository's **Settings → Pages**, deploy from the `main` branch, root folder.

Serve it over HTTPS. On plain HTTP (other than localhost) browsers restrict clipboard access, so the Copy buttons may not work.

## Run the tests

With Node.js 20 or later, and nothing to install:

```bash
node --test
```

The tests cover prompt assembly (`tests/elements.test.js`), the word diff and output stats (`tests/diff.test.js`), and the provider requests and error messages, using a stand-in for the network (`tests/provider.test.js`). `package.json` only tells Node that the `.js` files are modules; it has no dependencies.

## Where to change things

| To change | Edit |
| --- | --- |
| Default model names | `PROVIDERS` in `js/constants.js` |
| API key page names and links (shown in the guide and in error messages) | the `keyPage` entries in `PROVIDERS`, `js/constants.js` |
| Default provider | `DEFAULT_PROVIDER` in `js/constants.js` |
| Max output tokens: default and allowed range | `MAX_OUTPUT_TOKENS` in `js/constants.js` |
| Waits before retrying a rate-limited request | `RATE_LIMIT_RETRY_DELAYS_MS` in `js/constants.js` |
| The word Test connection sends | `TEST_PROMPT` in `js/constants.js` |
| The guide's wording | `GUIDE_STEPS` in `js/guide.js`; the small markup it understands is described at the top of that file |

Model names change often. The defaults were checked against each provider's documentation on 24 September 2026. If a run says "This model name may be retired", change the model in Settings to keep working, then update `js/constants.js` so the new name becomes everyone's default.

## API keys

API keys are held only in the browser's session storage for this tab, so they disappear when the tab closes and have to be pasted in again next time. Each key is sent only to its own provider, directly from the browser, in a request header and never in a URL. There is no server, and the app never logs keys.

Anyone who can use the browser while the tab is open could read the key, so close the tab when you finish on a shared computer. For a class, a key with a spending limit set in the provider's console is a good idea.

## How requests are made

- The assembled prompt is sent as a single user message, with no system prompt.
- There is no temperature setting. Current Anthropic models reject one, current OpenAI models accept one only with reasoning turned off, and Google advises leaving it alone for Gemini 3 models, so a shared setting wouldn't mean the same thing across providers.
- Each request asks the model for its lowest reasoning setting (OpenAI reasoning off, Claude thinking off, Gemini thinking "low"), so Max output tokens is spent on the answer rather than on hidden reasoning. If a model rejects that setting, the request is sent again with the model's own default, later runs on that model use the default straight away, and the output notes "model's default reasoning".
- OpenAI requests use the Responses API with `store: false`, so OpenAI doesn't keep the response for later retrieval.
- A rate-limited request (HTTP 429) is retried after 2, 5 and 10 seconds with a countdown. Other errors are shown straight away as one line saying what happened and what to do.

## Files

```text
index.html           the page
css/styles.css       all styles; colours are tokens at the top, with a dark set
js/app.js            state and wiring (the only file that touches the page or storage)
js/elements.js       the seven elements and prompt assembly (pure)
js/provider.js       Gemini, OpenAI and Anthropic requests, and error messages
js/diff.js           word diff and output stats (pure)
js/constants.js      default models, key pages, limits, retry timings
js/guide.js          the how-to guide: content and rendering
tests/               node:test tests
```
