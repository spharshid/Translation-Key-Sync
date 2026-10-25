# Change Log

All notable changes to "i18n AI Translate & Sync" are documented in this file.

## [0.1.0]

Renamed from "Translation Key Sync" (new extension id `i18n-ai-translate-sync`). Commands and settings now start with `i18nSync.` instead of `localeSync.`, so the old extension can stay installed next to this one without clashing; settings have to be entered again once.

- **AI translation.** Strings are translated by an AI model (GitHub Copilot through VS Code, or any OpenAI-compatible
  endpoint) in batched requests that include the key path, nearby approved translations from the same file, the glossary
  and style rules. Answers are validated (placeholders, script, untranslated English, approved terms), corrected with
  targeted feedback, and optionally proofread in a second pass. Google and the Hugging Face Space are now only a fallback.
- **Machine-translated strings are redone by the AI** automatically once a model is available.
- **Context file.** Product description, tone per language, a glossary and names to keep. A glossary term carries its **meaning** in
  plain words (so "Board" is not translated as a wooden board) and, optionally, an approved word per language, inflected correctly in the
  sentence; a language without an approved word still gets the meaning, and an optional per-language `avoid` list names wrong-sense
  words that must not be used (checked on the result). Every field except `term` is optional. Template command, JSON schema and a field on the settings screen.
- **Sync Locales.** A button and command that sync the source folder to the ticked destinations: new and edited strings are
  translated into *translate* destinations and copied into *copy* destinations. With several ticked destinations it asks which to
  use for the batch. Already-translated keys are never translated twice.
- **Tools.** Test AI Translation, Check Translation Quality (chrF against your approved translations), Set API Key.
- **Improve with My AI Chat** (copy prompt / apply answer): free, no key, works in every editor (Cursor, Trae, Antigravity, ...). One
  prompt for the strings still waiting for a good translation; the pasted reply goes through the same checks.
- **Translation memory:** exact reuse of translations that already exist for the same text (unambiguous only).
- **Free AI service, no key, any editor.** Uses OVHcloud AI Endpoints' anonymous tier (2 requests/min per model per IP; paced and
  rotated across models; on by default, switch off with `i18nSync.ai.allowFreeFallbacks`). Measured on es / sl / ta / ar UI strings against the
  machine translators and found far more accurate; glossary terms come out inflected correctly.
- **Google is now the machine-translation fallback of choice**, via the Chrome-extension endpoint (kept answering where the old `gtx`
  endpoint is blocked), with the old one as second choice. Strings are packed ~20 per request, requests are paced, a blocked endpoint
  is skipped for a while, and the glossary / kept names from the context file are applied. The Hugging Face Space is now only the last
  resort and is no longer woken unless needed.
- Adjacent placeholders (`<b>{{name}}</b>`) are masked as one token (stops stray underscores in machine translation).
- **Teams on one network.** Free, no-card setup that scales: one free Gemini key per developer (quotas follow the project, not the wifi),
  with several models rotated behind one key (comma-separated model list; a model out of its daily quota is left alone). Provider
  presets (Gemini, OVHcloud with a key, Groq, Cerebras, OpenRouter, Ollama) and key-page buttons in the settings screen, and an optional `ai` section (endpoint + model, never the key) in the shared context file. The built-in
  free service no longer spends requests on the proofreading pass, and its model pool is one model larger.
- **Translation Status page.** Lists what is not translated yet (missing and out-of-date keys per language and file), what is
  waiting for a translator, and what is broken, with buttons to run Sync Locales or retry only the waiting strings.
- **Broken files are never written to.** A locale file that is not valid JSON, or a key whose structure clashes with the base
  language, is skipped and reported instead of aborting the sync or being overwritten; an empty locale file counts as `{}`.
- Optional local model (Ollama) auto-detection.
- Glossary check accepts inflected forms word by word (plurals, case endings).
- **One fixed order and a simple provider choice.** GitHub Copilot first, then the provider picked on the settings page (Gemini,
  Groq, Ollama or a custom OpenAI-compatible server; the key is typed there and kept in secret storage, one slot per provider),
  then the build's default, then the free fallbacks. The settings page shows what is in use and has a Test button; the old "try
  first", local-model and free-service options, the preset list and the consent dialog are gone, replaced by an *Allow free online
  fallbacks* checkbox. "Improve with my AI chat" and "Check quality" moved to the status page.
- **Faster, steadier Gemini.** Requests to Gemini ask for low reasoning: on a reference set (Spanish, Tamil) it gave the same results
  several times faster and uses less of the free allowance. When one model of a key is overloaded or times out, the next model is tried
  right away (and the log says so), and the built-in model list puts the fast, dependable models first.
- **Settings reorganised as one source and a list of destinations** (`i18nSync.source`, `i18nSync.destinations`: a folder, a type
  and a tick each, plus `i18nSync.askDestinations`). Each destination keeps its own record of what it was synced from, the
  on-commit sync and Sync Locales both use the destination list, and advanced AI options are folded away. `~/` works in folders on
  macOS/Linux.
- CI workflow for macOS, Linux and Windows.
- Tests now live in the repository (`npm test`, `npm run test:vscode`).

## [0.0.2]

- Generic examples (SourceRepo / DestinationRepo) in the settings screen and README; the locale list starts empty.

## [0.0.1]

- Initial release.
