# Optional backend patch for the Text_Translator Space

The extension works with the Space as it is today. These changes make it faster and more accurate.
Apply them to `app/main.py` in the Space (https://huggingface.co/spaces/spharshid/Text_Translator).

## What goes wrong today

| Problem | Cause in `app/main.py` | Effect |
|---|---|---|
| Short strings come back unchanged or duplicated (`Cancel` -> `Cancel`, `One` -> `Uno  Uno`) | `detect_lang(text)` (langdetect) guesses the source language; on one or two words it often guesses wrong, and when it guesses the target language the text is returned as-is | wrong/missing translations |
| Long strings are cut short | `max_length=128` tokens in `model.generate` | strings over roughly 400 characters are truncated |
| Slow: 2.5-8 s per short string, ~26 s for a long one | CPU-only 600M model with `num_beams=4`, one request at a time | a 13-key commit across 4 locales takes about 3 minutes |

The extension already compensates (cross-checks with Google, collapses repeats, translates line by line),
but fixing the cause is better.

## Patch 1 (most important): accept the source language

```python
class TranslateRequest(BaseModel):
    text: str
    lang: str                      # target language code
    source: str | None = None      # NEW: source language code, skips auto-detection
```

```python
    # Detect source language only when the caller did not say what it is
    src = (req.source or "").strip().lower() or detect_lang(text)
    if src not in SUPPORTED_LANGS:
        src = "en"
```

The extension already sends `"source": "en"` with every request; the current Space ignores the extra field,
so this is backwards compatible.

## Patch 2: do not truncate long strings

```python
tokens = model.generate(
    **inputs, max_length=512, num_beams=2, early_stopping=True,
    forced_bos_token_id=forced_bos_token_id
)
```

`num_beams=2` roughly halves latency with little quality loss for UI strings.

## Patch 3 (optional): keep line breaks

The tokenizer treats `\n` as whitespace, so multi-line strings come back on one line.
The extension splits on newlines itself, so this is only needed for other clients:

```python
    def do_translate(single_text: str) -> str:
        if "\n" in single_text:
            return "\n".join(do_translate(p) if p.strip() else p for p in single_text.split("\n"))
        ...
```

## Notes

- Free Spaces sleep after inactivity; the first request wakes the container and can take a minute.
  The extension waits 60 s (setting `localeSync.backendTimeoutSeconds`) before falling back to Google.
- A batch endpoint (`POST /translate_batch` taking `texts: list[str]`, running `tokenizer(..., padding=True)` once)
  would cut the per-string overhead the most. The extension does not use one yet.
