# Change Log

All notable changes to "i18n AI Translate & Sync" are documented in this file.

## [0.1.0]

First release under the new name and id (`i18n-ai-translate-sync`; it was "Translation Key Sync"). Commands and settings now start
with `i18nSync.` instead of `localeSync.`, so the old extension can stay installed next to this one; settings have to be entered
again once.

### Syncing
- **One source and a list of destinations** (a folder, a type and a tick each): *translate* destinations get every language, *copy*
  destinations get the base language as it is. The on-commit sync and the **Sync Locales** button both use the ticked destinations;
  with several ticked, Sync Locales asks which to use for the batch.
- Each destination keeps its own record of what it was synced from, so leaving one out of a batch never loses changes. A key already
  translated from the same text is never translated twice.
- **Never loses a string.** If no translator answers, the English text is written, queued and retried; interrupted syncs resume; files
  that are not valid JSON and keys whose structure clashes are skipped and reported instead of being overwritten.
- **Translation Status page:** what is not translated yet, what is waiting for a translator and what is broken, with buttons to run
  Sync Locales or retry only the waiting strings.

### Translation
- **AI first, in a fixed order:** GitHub Copilot, then the provider picked on the settings page (Gemini, Groq, Ollama or a custom
  OpenAI-compatible server; the key is kept in secret storage), then free fallbacks (a free AI service, Google, the Hugging Face
  Space) that can be switched off. The settings page shows what is in use and has a Test button.
- Requests carry the key path, nearby approved translations, glossary and style rules. Answers are validated (placeholders, script,
  untranslated English, approved and avoided words), corrected with targeted feedback and optionally proofread. Strings that only got
  machine translation are redone by an AI as soon as one is available.
- **Context file:** product description, tone per language, glossary terms with a meaning, optional approved words and words to avoid
  per language, names to keep, and an optional shared endpoint and model (never a key). Template command and JSON schema.
- Translation memory, adjacent placeholders masked as one token, inflected forms accepted by the glossary check. Gemini requests use
  low reasoning and move on to the next model when one is overloaded.
- **Improve with My AI Chat** (copy prompt / apply answer) for any editor, plus Test AI Translation, Check Translation Quality and
  Set API Key.

### Project
- Settings page built around the source, the destinations and one AI provider choice; `~/` works in folders on macOS/Linux.
- GitHub Actions workflow for Windows, macOS and Linux; unit, flow and real-VS-Code tests in the repository.

## [0.0.2]

- Generic examples (SourceRepo / DestinationRepo) in the settings screen and README; the locale list starts empty.

## [0.0.1]

- Initial release.
