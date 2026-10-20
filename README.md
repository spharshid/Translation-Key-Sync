# Translation Key Sync

After every commit you make in the FE repo, copies the changed i18n keys into the translation repo
(same file, same key) for every configured locale, translating them on the way.

## Setup (per developer)

Click **Key Sync: set up** in the status bar (or run **Translation Key Sync: Configure**) and pick:

| Setting | Example |
|---|---|
| `localeSync.sourceDir` | `C:/FE/wh-react-web-frontend/public/translations/fallback/locales/en` |
| `localeSync.targetDir` | `C:/FE/wh-translation-docs/locales` |
| `localeSync.locales` | `["ar","en","es","sl","ta"]` |

The FE repo must be open in VS Code. The translation repo does not need to be.

## What it does

- Detects a new commit through VS Code's Git API (works for the Source Control UI and terminal commits).
- Diffs `parent..commit` for JSON files under `sourceDir`; adds, changes or removes only those keys.
- Edits target files in place, keeping their indentation and line endings.
- Skips merge commits, multi-commit fast-forwards, amends, rebases, branch switches and (by default) other people's commits.
- Translation: Hugging Face backend first, Google free endpoint as fallback.
  `{{placeholders}}`, `%s`, `$t(...)` and HTML tags are protected.
  Strings that cannot be translated keep the English text and are reported in the log.

## Behaviour details

- A **new** source file, or a changed file whose copy is missing in the translation repo, is created whole
  (all keys), with the source file's line endings and indentation. Sub-folders such as `dev_mode/` are mirrored.
- Source files deleted in a commit are ignored; target files are never deleted.
- Booleans, numbers and `null` are copied as-is. Multi-line strings are translated line by line.
- `localeSync.provider`: `auto` uses the Hugging Face backend and switches to Google first when a commit needs
  more than 30 strings (the Space handles roughly one string every 3-5 s).

## Never losing a string

- **Sleeping Space:** at the start of a sync the extension wakes the backend with a small request. A cold start
  (container plus model load) can take minutes, so Google translates in the meantime and the backend takes over once
  it answers. A late reply from the backend is simply ignored.
- **Retries:** a failing or rate-limited provider is retried with growing delays; the sync waits rather than skipping.
  Long strings are split at sentence ends so nothing is truncated.
- **Verification:** after writing, every file is re-read from disk and each key is checked.
- **If nothing works within `localeSync.maxWaitMinutes` (default 5):** the key is still written (in English, so the
  app never shows a missing key), the string goes into a persistent queue, and the status bar shows `Key Sync: N pending`.
  The queue is retried automatically every 5 minutes and at startup (or run **Retry Pending Translations**). A queued
  string is only replaced if the file still holds the English placeholder; if someone edited it meanwhile it is left alone.
- **Interrupted syncs:** if VS Code closes mid-sync, the commit is synced again at the next start.
- Nothing is committed or pushed in either repo. Review the translation repo's working tree yourself.
  To undo: `git checkout -- .` and `git clean -fd locales` in the translation repo.
- `backend-patch/README.md` (in the source repo) describes optional fixes to the Space: a source-language
  parameter and longer strings.

Commands: **Translation Key Sync: Configure**, **Sync Last Commit**, **Show Log**.

## Develop

`npm install`, then F5 (Run Extension). Package with `npx @vscode/vsce package`.
