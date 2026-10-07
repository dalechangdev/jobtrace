# Security

## Reporting a vulnerability

Please report security issues privately through GitHub's "Report a vulnerability"
feature on this repository rather than opening a public issue.

## What JobTrace stores, and what is sensitive

- **Auth profiles are secrets.** An auth profile is a saved browser session
  (cookies and local storage) written to `DATA_DIR/auth/<id>.json` with file mode
  `0600`. Anyone who can read that file can act as you on that site. The data
  directory is gitignored; never commit or share it. Auth state is never logged,
  never included in recording exports, and never sent to the optional AI plugin.
- **Passwords are never stored.** The recorder does not capture values typed into
  password, payment-card, or one-time-code fields. Log in through an auth profile.
- **The server is local by default.** It binds to `127.0.0.1`, answers only requests
  addressed to a localhost name (which stops DNS-rebinding attacks from web pages), and
  refuses requests that come from other sites' pages. Binding to any other host
  requires `API_TOKEN`. The Docker image listens on all interfaces inside the
  container but answers only to localhost names and is published on `127.0.0.1`; if
  you publish it more widely, set `API_TOKEN` and `ALLOWED_HOSTS`.
- **Saved sessions can be sent to a server, never read back.** `jobtrace auth push`
  uploads a session to a server without a screen; no API route returns one.
- **Captured pages are served as plain text.** Page snapshots kept for failed runs are
  other people's HTML; the server never renders them as a page.
- **Exports are spreadsheet-safe.** CSV cells that a spreadsheet would run as a
  formula are neutralized.
- **The AI fallback plugin is off by default.** When enabled (it needs
  `ANTHROPIC_API_KEY` and the switch), a step whose every locator failed sends the
  Claude API a trimmed copy of the part of the page it searches: markup without
  scripts, styles or anything typed into forms, plus the page address without its query
  string. Cookies, saved logins and form values are never sent. Page markup of a board
  behind a login can itself contain account details; leave the plugin off where that
  matters. The API key is read from the environment only: it is not stored in the
  database, not logged, and not returned by the API.
- **Page content is treated as untrusted by the plugin.** The model can only answer
  with a locator, which is checked against the live page before use; text on a page
  cannot make JobTrace do anything else.

## What JobTrace will not do

JobTrace does not solve CAPTCHAs, use stealth plugins, spoof browser fingerprints,
or otherwise try to evade bot detection. When it meets a bot wall it stops, marks
the run `blocked`, and saves a screenshot. It respects `robots.txt` by default.
Please keep request volumes low and respect each site's terms of use.
