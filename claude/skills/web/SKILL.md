---
name: web
description: Browse and scrape the web from the shell with the `web` CLI — converts pages to markdown, runs JavaScript, captures console logs, takes screenshots, fills and submits forms, and persists sessions with profiles. Has first-class Phoenix LiveView support. Use whenever a task needs to fetch/read a live web page, log into a site, submit a form, screenshot a page, or interact with a LiveView app from the command line.
---

# web CLI

`web` is a self-contained Go binary (a real headless Firefox under the hood) that
turns web pages into markdown for LLM consumption and can interact with them.

The binary is on the PATH at `/usr/local/bin/web`.

**First run downloads Firefox + geckodriver** to `~/.web-firefox/` (~102MB), so the
first invocation is slow. Later runs are fast.

## Usage

```
web <url> [options]
```

The URL is the first positional argument. A scheme may be omitted (`example.com`
works). Output (markdown by default) goes to stdout.

## Options

| Option | Purpose |
| --- | --- |
| `--help` | Show help. |
| `--raw` | Output the raw page (HTML) instead of converting to markdown. |
| `--truncate-after <n>` | Truncate output after `<n>` characters and append a notice (default `100000`). |
| `--screenshot <filepath>` | Save a full-page screenshot to `<filepath>`. |
| `--form <id>` | The `id` of the form to fill/submit. |
| `--input <name>` | The `name` attribute of a form field to fill (repeatable). |
| `--value <value>` | The value for the **preceding** `--input` field. |
| `--after-submit <url>` | After the form submits and navigates, load this URL before converting to markdown. |
| `--js <code>` | Execute JavaScript on the page after it loads. |
| `--profile <name>` | Use/create a named session profile for cookie + auth persistence (default `"default"`). |

## Core patterns

Scrape a page to markdown:
```bash
web https://example.com
```

Raw HTML to a file:
```bash
web https://example.com --raw > output.html
```

Screenshot + truncated markdown:
```bash
web example.com --screenshot screenshot.png --truncate-after 123
```

Run JS and capture its console output (returned alongside the markdown):
```bash
web https://example.com --js "console.log(document.title)"
web example.com --js "document.querySelector('button').click()"
```
`web` captures `console.log/warn/error/info/debug` plus browser errors (JS errors,
network errors, etc.), so `--js` is the way to read computed/dynamic state.

## Forms

Fields are filled by pairing each `--input <name>` with the `--value` that
**immediately follows it**. Order matters: `--input` then its `--value`, repeat.
`--form` takes the form's `id`.

```bash
web https://login.example.com \
    --form "login_form" \
    --input "username" --value "myuser" \
    --input "password" --value "mypass"
```

Phoenix-style nested field names work the same way, and `--after-submit` loads a
post-login page once navigation settles:

```bash
web http://localhost:4000/users/log-in \
    --form "login_form" \
    --input "user[email]" --value "foo@bar" \
    --input "user[password]" --value "secret" \
    --after-submit "http://localhost:4000/authd/page"
```

## Sessions / authentication

Use `--profile` to keep cookies and auth across runs. Log in once with a profile,
then reuse that profile to hit authenticated pages without re-authenticating:

```bash
# Log in under a named profile
web --profile "mysite" https://mysite.com/login \
    --form "login_form" --input "user" --value "me" --input "pass" --value "pw"

# Reuse the session later
web --profile "mysite" https://mysite.com/dashboard
```

Profiles are isolated dirs under `~/.web-firefox/profiles/`.

## Phoenix LiveView support

`web` auto-detects LiveView apps (via the `[data-phx-session]` attribute) and
handles their lifecycle automatically — no extra flags needed:

- Waits for the `.phx-connected` class before proceeding.
- Handles LiveView form submissions with their loading states.
- Waits for `.phx-change-loading` and `.phx-submit-loading` to clear before
  reading the page.

This makes the form and `--after-submit` patterns above work reliably against
Phoenix/LiveView apps (including `localhost:4000` dev servers).

## Notes

- Exit output is markdown on stdout; redirect with `>` to save.
- Large pages: use `--truncate-after` to cap output, or `--js` to extract just the
  part you need instead of dumping the whole page.
- Runs on Linux x64 and macOS. On Linux, Firefox may need system packages
  (`libgtk-3-0`, `libdbus-glib-1-2`, `libasound2`, etc.) — see the project README
  if Firefox fails to launch.
