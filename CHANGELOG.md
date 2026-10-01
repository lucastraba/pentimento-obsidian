# Changelog

## 0.3.2

- Release files come with signed build provenance, so anyone can check they were built from this repository: `gh attestation verify main.js -R lucastraba/pentimento-obsidian`.
- The manifest's author link points to the author's profile.
- The strikethrough on removed words uses the plain `text-decoration-line` property, which every supported Obsidian version handles fully.

## 0.3.1

- Saving, restoring, and removing drafts of an open note go through its editor and change only the lines that differ, so the cursor stays on the same text and a restore can be undone with Cmd/Ctrl+Z.

## 0.3.0

The first public release.

- Save drafts from the ribbon, the command palette, or automatically once a day (off by default).
- The status bar shows the latest draft and whether the note changed since.
- The drafts panel shows changes against any earlier draft, every draft with restore, and cuttings: passages removed in earlier drafts, ready to copy back.
- Remove drafts from a note, after confirmation; the note's text stays as it is.
- Settings appear in Obsidian 1.13's settings search.
