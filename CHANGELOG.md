# Changelog

## Unreleased

- Obsidian Sync: a new setting, **Sync drafts with Obsidian Sync**, keeps new notes' drafts in a visible `_history` folder, because Sync skips the hidden `.history`. Turning it on offers to move existing drafts, and the command "Move all drafts to the folder chosen in settings" moves them either way. See the README for what changes when drafts aren't hidden.
- Saved drafts are never treated as notes, even where Obsidian lists them: no Save draft, no daily draft, and no drafts panel for a draft itself.
- Needs `pentimento` 0.13.

## 0.3.4

- Moving a note to another folder takes its drafts along. Before, the drafts stayed behind in the old folder and the panel showed none. Renaming a note in place and moving a whole folder already kept them.
- In the Changes tab, a heading that was added, removed, or renamed shows as a section label instead of raw `## Heading` text.

## 0.3.3

- Fixed: after saving a draft of an open note, the Properties box kept showing the previous revision until the note was reopened (since 0.3.1). The file itself was always right.
- The Changes tab follows the note as you type, so unsaved edits show up without saving a draft.
- A struck-out word and its replacement no longer run together.

## 0.3.2

- Release files come with signed build provenance, so anyone can check they were built from this repository: `gh attestation verify main.js -R lucastraba/pentimento-obsidian`.
- The manifest's author link points to the author's profile.
- The strikethrough on removed words uses the plain `text-decoration-line` property, which every supported Obsidian version handles fully.

## 0.3.1

- Saving, restoring, and removing drafts of an open note keep the cursor on the same text, and a restore can be undone with Cmd/Ctrl+Z.

## 0.3.0

The first public release.

- Save drafts from the ribbon, the command palette, or automatically once a day (off by default).
- The status bar shows the latest draft and whether the note changed since.
- The drafts panel shows changes against any earlier draft, every draft with restore, and cuttings: passages removed in earlier drafts, ready to copy back.
- Remove drafts from a note, after confirmation; the note's text stays as it is.
- Settings appear in Obsidian 1.13's settings search.
