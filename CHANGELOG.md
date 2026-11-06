# Changelog

## 1.0.0

First public release.

- Capture from the phone's share sheet, a paste box, X bookmarks (official
  API), GitHub stars and YouTube (share or an Unlisted playlist).
- An editor that keeps or spikes each save against your profile, writes a
  TLDR and a "why you" line, and suggests at most one action.
- Two ways to run the editor: your Claude plan over a remote MCP connector,
  or the Worker itself with a Claude API, OpenRouter or OpenAI-compatible key.
- The Desk: one page of open actions with Done, Snooze and Drop, a ranked
  reading list, and the Morgue of spiked copy with Rescue.
- A morning email of your Desk, a warning email when no run happens, a
  Sunday circulation box, and a 30-day Morgue for untouched copy.
- Private by default: Cloudflare Access on every request, checked again by
  the Worker; no personal data in the repo.
