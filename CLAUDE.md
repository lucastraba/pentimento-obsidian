# Pentimento for Obsidian: notes for agents

README.md is for users and has the build, test, and release steps. The rules shared by both Pentimento repos (where work is tracked, what to review before a release) are in the pentimento repo's `CLAUDE.md` (`~/repos/pentimento/CLAUDE.md`).

- The plugin has users. Review the release as that file describes, and never push a release tag without Lucas.
- Open work is GitHub issues here and in `lucastraba/pentimento`. Start with `gh issue list` in both.
- To check the plugin in real Obsidian on a machine without a display (nyx): extract the Obsidian AppImage (`--appimage-extract`), start it under `xvfb-run` with `--remote-debugging-port=<port>`, and drive it over CDP with playwright-core. On desktop, Settings opens in a separate window.
