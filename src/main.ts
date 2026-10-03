import { MarkdownView, Modal, Notice, normalizePath, Plugin, Setting, TFile, type App } from 'obsidian'
import { draftStatus, holdsHistories, readHistory, removeHistory, restoreDraft, saveDraft, type DraftStore, type SaveDraftOptions } from 'pentimento/drafts'
import { isHistoryFolder, stampFrontmatter } from 'pentimento/model'
import { DEFAULT_SETTINGS, PentimentoSettingTab, type PentimentoSettings } from './settings'
import { isDraftCopy, vaultStore } from './store'
import { ConfirmModal, HistoryView, VIEW_TYPE } from './view'

const DAILY_CHECK_MS = 30 * 60 * 1000
/** a note edited this recently is still being worked on; the daily draft waits */
const QUIET_MS = 15 * 60 * 1000

export default class PentimentoPlugin extends Plugin {
  settings: PentimentoSettings = DEFAULT_SETTINGS
  store!: DraftStore
  private statusEl!: HTMLElement
  private statusTimer: number | null = null
  private viewTimer: number | null = null
  private saving = new Set<string>()
  private dailyNotes = new Map<string, TFile>()
  private dailyNotesInitialized = false

  async onload(): Promise<void> {
    await this.loadSettings()
    this.store = vaultStore(this.app)

    this.registerView(VIEW_TYPE, (leaf) => new HistoryView(leaf, this))
    this.addRibbonIcon('history', 'Save draft', () => {
      const file = this.activeNote()
      if (file) void this.saveFile(file)
      else new Notice('Open a note to save a draft of it.')
    })

    this.addCommand({
      id: 'save-draft',
      name: 'Save draft',
      checkCallback: (checking) => this.withActiveNote(checking, (file) => this.saveFile(file)),
    })
    this.addCommand({
      id: 'save-draft-with-note',
      name: 'Save draft with a note…',
      checkCallback: (checking) => this.withActiveNote(checking, (file) => {
        new NoteModal(this.app, (summary, why) => void this.saveFile(file, { summary, why })).open()
      }),
    })
    this.addCommand({
      id: 'toggle-drafts',
      name: 'Show or hide drafts',
      callback: () => void this.toggleHistory(),
    })
    this.addCommand({
      id: 'move-drafts',
      name: 'Move all drafts to the folder chosen in settings',
      callback: () => void this.moveHistories(),
    })
    this.addCommand({
      id: 'remove-drafts',
      name: 'Remove drafts from this note…',
      checkCallback: (checking) => {
        const file = this.activeNote()
        if (!file || this.app.metadataCache.getFileCache(file)?.frontmatter?.['Pentimento'] !== true) return false
        if (!checking) void this.confirmRemove(file)
        return true
      },
    })

    this.statusEl = this.addStatusBarItem()
    this.statusEl.addClass('pentimento-statusbar', 'mod-clickable')
    this.statusEl.setAttr('aria-label', 'Show or hide drafts')
    this.statusEl.addEventListener('click', () => void this.toggleHistory())

    this.registerEvent(this.app.workspace.on('file-open', () => this.scheduleStatus(0)))
    this.registerEvent(this.app.vault.on('modify', (file) => {
      if (file.path === this.app.workspace.getActiveFile()?.path) this.scheduleStatus(600)
      this.scheduleViewRefresh(file.path)
    }))
    this.registerEvent(this.app.metadataCache.on('changed', (file) => this.trackDailyNote(file)))
    this.registerEvent(this.app.vault.on('delete', (file) => {
      this.dailyNotes.delete(file.path)
    }))
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      this.dailyNotes.delete(oldPath)
      if (file instanceof TFile) this.trackDailyNote(file)
      if (file instanceof TFile && file.extension === 'md') void this.followMove(file, oldPath)
      this.scheduleStatus(0)
    }))

    this.addSettingTab(new PentimentoSettingTab(this.app, this))
    this.app.workspace.onLayoutReady(() => {
      this.scheduleStatus(0)
      void this.runDailyDrafts()
    })
    this.registerInterval(window.setInterval(() => void this.runDailyDrafts(), DAILY_CHECK_MS))
  }

  onunload(): void {
    if (this.statusTimer !== null) window.clearTimeout(this.statusTimer)
    if (this.viewTimer !== null) window.clearTimeout(this.viewTimer)
  }

  async loadSettings(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<PentimentoSettings> | null) }
    if (!isHistoryFolder(this.settings.historyFolder)) this.settings.historyFolder = DEFAULT_SETTINGS.historyFolder
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
  }

  private activeNote(): TFile | null {
    const file = this.app.workspace.getActiveFile()
    return file && file.extension === 'md' && !isDraftCopy(file.path) ? file : null
  }

  private withActiveNote(checking: boolean, run: (file: TFile) => unknown): boolean {
    const file = this.activeNote()
    if (!file) return false
    if (!checking) void run(file)
    return true
  }

  /** Save the note as its next draft. Unsaved typing in an open editor is written first. */
  async saveFile(file: TFile, opts: Pick<SaveDraftOptions, 'summary' | 'why' | 'source'> = {}, quiet = false): Promise<boolean> {
    if (this.saving.has(file.path)) return false
    this.saving.add(file.path)
    try {
      await this.flushEditor(file)
      const res = await saveDraft(this.store, file.path, {
        ...opts,
        author: this.settings.author || undefined,
        historyFolder: this.settings.historyFolder,
        updateCanonical: (stamp) => this.rewriteNote(file, stamp),
      })
      if (this.dailyNotesInitialized) this.dailyNotes.set(file.path, file)
      if (!quiet) new Notice(`Saved ${res.rev}: ${res.summary}`)
      return true
    } catch (e) {
      new Notice(`Pentimento: ${e instanceof Error ? e.message : String(e)}`, 8000)
      return false
    } finally {
      this.saving.delete(file.path)
      this.afterChange()
    }
  }

  /** Bring back an earlier draft, saving the note's current text first if it has changed. */
  async restore(file: TFile, rev: string): Promise<void> {
    try {
      await this.flushEditor(file)
      const status = await draftStatus(this.store, file.path)
      if (status?.dirty && status.latest) await saveDraft(this.store, file.path, {
        author: this.settings.author || undefined,
        historyFolder: this.settings.historyFolder,
        summary: `Saved before restoring ${rev}`,
        updateCanonical: (stamp) => this.rewriteNote(file, stamp),
      })
      const res = await restoreDraft(this.store, file.path, rev, {
        author: this.settings.author || undefined,
        updateCanonical: (stamp) => this.rewriteNote(file, stamp),
      })
      new Notice(`Restored ${rev} as ${res.rev}`)
    } catch (e) {
      new Notice(`Pentimento: ${e instanceof Error ? e.message : String(e)}`, 8000)
    } finally {
      this.afterChange()
    }
  }

  /**
   * Apply a whole-text rewrite to a note with Vault.process, after writing out anything
   * still unsaved in its editor. Obsidian merges the result into an open editor, so the
   * cursor stays on the same text, the change can be undone, and the Properties box
   * updates. (Editing through the editor directly left the Properties box showing the
   * old revision.)
   */
  private async rewriteNote(file: TFile, rewrite: (text: string) => string): Promise<void> {
    await this.flushEditor(file)
    await this.app.vault.process(file, rewrite)
  }

  private async flushEditor(file: TFile): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view
      if (view instanceof MarkdownView && view.file?.path === file.path) await view.save()
    }
  }

  /** The panel follows the note as it changes, so "Changes" shows edits before they're saved. */
  private scheduleViewRefresh(path: string): void {
    if (this.viewTimer !== null) window.clearTimeout(this.viewTimer)
    this.viewTimer = window.setTimeout(() => {
      this.viewTimer = null
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
        if (leaf.view instanceof HistoryView && leaf.view.notePath === path) void leaf.view.refresh()
      }
    }, 800)
  }

  private afterChange(): void {
    this.scheduleStatus(0)
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof HistoryView) void leaf.view.refresh()
    }
  }

  /**
   * A note's history lives beside it, at a path relative to the note. When a note with drafts
   * moves to another folder, its history folder moves with it. (Renaming in place needs nothing;
   * moving a whole folder carries its .history or _history along.)
   */
  private async followMove(file: TFile, oldPath: string): Promise<void> {
    if (isDraftCopy(file.path) || isDraftCopy(oldPath)) return
    const oldFolder = folderOf(oldPath)
    const newFolder = folderOf(file.path)
    if (oldFolder === newFolder) return
    const historyRel = await this.historyFolderOf(file)
    if (!historyRel) return
    const adapter = this.app.vault.adapter
    const from = join(oldFolder, historyRel)
    const to = join(newFolder, historyRel)
    if (!(await adapter.exists(from))) return
    if (await adapter.exists(to)) {
      new Notice(`Pentimento: ${file.basename} moved, but ${to} already exists, so its drafts stayed in ${from}.`, 10000)
      return
    }
    try {
      const parent = folderOf(to)
      if (parent && !(await adapter.exists(parent))) await adapter.mkdir(parent)
      await adapter.rename(from, to)
      // the old .history (or _history) folder goes once its last note has left; the
      // adapter's listing trails a rename slightly, so it's checked after a moment
      const oldParent = folderOf(from)
      if (holdsHistories(historyRel, file.basename)) {
        await new Promise((resolve) => window.setTimeout(resolve, 500))
        // confirmed empty just before; Obsidian's non-recursive rmdir leaves hidden folders in place
        if (await this.store.isEmptyFolder(oldParent)) await this.store.rmdir(oldParent)
      }
    } catch (e) {
      new Notice(`Pentimento: couldn't move the drafts of ${file.basename}: ${e instanceof Error ? e.message : String(e)}`, 10000)
    } finally {
      this.afterChange()
    }
  }

  /** A note's `History Folder` property, when it is a safe relative path. */
  private async historyFolderOf(file: TFile): Promise<string | null> {
    const cached: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.['History Folder']
    const historyRel = typeof cached === 'string'
      ? cached
      : /^History Folder:\s*(.+)$/m.exec(await this.app.vault.cachedRead(file))?.[1]?.trim()
    if (typeof historyRel !== 'string' || !historyRel || historyRel.startsWith('/') || historyRel.split('/').includes('..')) return null
    return historyRel
  }

  /** Notes whose history is in the other of the two history folders, with where it would go. */
  private async notesToMove(): Promise<{ file: TFile; from: string; to: string; toRel: string }[]> {
    const target = this.settings.historyFolder
    const out: { file: TFile; from: string; to: string; toRel: string }[] = []
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (isDraftCopy(file.path) || this.app.metadataCache.getFileCache(file)?.frontmatter?.['Pentimento'] !== true) continue
      const historyRel = await this.historyFolderOf(file)
      const segments = historyRel?.split('/') ?? []
      // only histories Pentimento placed itself: `.history/<note>` or `_history/<note>`
      if (segments.length !== 2 || !isHistoryFolder(segments[0]) || segments[0] === target) continue
      const folder = folderOf(file.path)
      const toRel = `${target}/${segments[1]}`
      out.push({ file, from: join(folder, historyRel!), to: join(folder, toRel), toRel })
    }
    return out
  }

  /** After the setting changes: offer to move the notes that already have drafts. */
  async offerMove(): Promise<void> {
    const notes = await this.notesToMove()
    if (!notes.length) return
    const n = `${notes.length} note${notes.length === 1 ? '' : 's'}`
    const where = this.settings.historyFolder
    new ConfirmModal(
      this.app,
      `Move the drafts of ${n} to ${where}?`,
      where === '_history'
        ? `Their drafts are in hidden .history folders, which Obsidian Sync skips. Moving them puts them where new drafts go, and updates each note's History Folder property. You can do this later with the command "Move all drafts to the folder chosen in settings".`
        : `Their drafts are in _history folders. Moving them back hides them from search and the graph again, and stops Obsidian Sync carrying them. Each note's History Folder property is updated.`,
      'Move',
      () => this.moveHistories(),
    ).open()
  }

  /** Move every note's history into the folder chosen in settings, updating its property. */
  async moveHistories(): Promise<void> {
    const adapter = this.app.vault.adapter
    const moved: string[] = []
    const skipped: string[] = []
    const left = new Set<string>()
    for (const { file, from, to, toRel } of await this.notesToMove()) {
      if (!(await adapter.exists(from))) continue
      if (await adapter.exists(`${from}/.lock`)) { skipped.push(`${file.basename} (a draft is being saved)`); continue }
      if (await adapter.exists(to)) { skipped.push(`${file.basename} (${to} already exists)`); continue }
      try {
        await this.flushEditor(file)
        const parent = folderOf(to)
        if (parent && !(await adapter.exists(parent))) await adapter.mkdir(parent)
        await adapter.rename(from, to)
        try {
          await this.rewriteNote(file, (text) => stampFrontmatter(text, { 'History Folder': toRel }))
        } catch (e) {
          // the note still points at the old place, so its drafts go back there
          const reason = e instanceof Error ? e.message : String(e)
          try {
            await adapter.rename(to, from)
          } catch {
            throw new Error(`${reason}; its drafts are in ${to} but the note still points at ${from}, so move them back by hand`)
          }
          throw e
        }
        moved.push(file.basename)
        left.add(folderOf(from))
      } catch (e) {
        skipped.push(`${file.basename} (${e instanceof Error ? e.message : String(e)})`)
      }
    }
    // the folders the drafts left go once they are empty; the adapter's listing trails a rename slightly
    await new Promise((resolve) => window.setTimeout(resolve, 500))
    for (const dir of left) {
      try { if (await this.store.isEmptyFolder(dir)) await this.store.rmdir(dir) } catch { /* left in place */ }
    }
    const where = this.settings.historyFolder
    if (moved.length) new Notice(`Moved the drafts of ${moved.length} note${moved.length === 1 ? '' : 's'} to ${where}`)
    else if (!skipped.length) new Notice(`Every note's drafts are already in ${where}`)
    if (skipped.length) new Notice(`Pentimento: not moved: ${skipped.join('; ')}`, 12000)
    this.afterChange()
  }

  /** Ask, then take the note out of Pentimento: its drafts are deleted and its properties removed. */
  async confirmRemove(file: TFile): Promise<void> {
    let count = 0
    let folder = ''
    try {
      const h = await readHistory(this.store, file.path)
      count = h?.meta.revisions.length ?? 0
      folder = h?.location.historyDir ?? ''
    } catch { /* the modal still offers removal of an unreadable history */ }
    const drafts = `${count} draft${count === 1 ? '' : 's'}`
    new ConfirmModal(
      this.app,
      `Remove all drafts of ${file.basename}?`,
      `This deletes all ${drafts} (${folder || 'the history folder'}), with their summaries and cuttings, and removes the Pentimento properties from the note. The note's text stays as it is. This can't be undone.`,
      'Remove',
      async () => {
        try {
          await this.flushEditor(file)
          const res = await removeHistory(this.store, file.path, {
            updateCanonical: (unstamp) => this.rewriteNote(file, unstamp),
          })
          this.dailyNotes.delete(file.path)
          new Notice(`Removed ${res.drafts} draft${res.drafts === 1 ? '' : 's'} from ${file.basename}`)
        } catch (e) {
          new Notice(`Pentimento: ${e instanceof Error ? e.message : String(e)}`, 8000)
        } finally {
          this.afterChange()
        }
      },
      true,
    ).open()
  }

  /** Hide the drafts panel by collapsing the right sidebar, or bring it back in front. */
  async toggleHistory(): Promise<void> {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]
    const sidebar = this.app.workspace.rightSplit
    if (leaf && !sidebar.collapsed && leaf.view.containerEl.isShown()) {
      sidebar.collapse()
      return
    }
    await this.showHistory()
    if (sidebar.collapsed) sidebar.expand()
  }

  hideHistory(): void {
    this.app.workspace.rightSplit.collapse()
  }

  async showHistory(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]
    if (!leaf) {
      const right = this.app.workspace.getRightLeaf(false)
      if (!right) return
      await right.setViewState({ type: VIEW_TYPE, active: true })
      leaf = right
    }
    await this.app.workspace.revealLeaf(leaf)
  }

  private scheduleStatus(delay: number): void {
    if (this.statusTimer !== null) window.clearTimeout(this.statusTimer)
    this.statusTimer = window.setTimeout(() => {
      this.statusTimer = null
      void this.updateStatus()
    }, delay)
  }

  /** "r004" when the note matches its latest draft, "r004 · edited" when it has moved since. */
  private async updateStatus(): Promise<void> {
    const file = this.activeNote()
    if (!file) { this.statusEl.hide(); return }
    let text = 'No drafts'
    let title = 'Save a draft to start this note\'s history'
    try {
      const s = await draftStatus(this.store, file.path)
      if (s?.latest) {
        text = s.dirty ? `${s.latest.id} · edited` : s.latest.id
        title = s.dirty ? `Changed since ${s.latest.id}: ${s.latest.summary}` : `${s.latest.id}: ${s.latest.summary}`
      }
    } catch {
      text = 'Drafts unreadable'
      title = 'The draft history for this note could not be read'
    }
    this.statusEl.setText(text)
    this.statusEl.setAttr('aria-label', title)
    this.statusEl.toggleClass('is-edited', text.endsWith('edited'))
    this.statusEl.show()
  }

  private trackDailyNote(file: TFile): void {
    if (!this.dailyNotesInitialized) return
    // a saved draft in _history carries its note's properties, but is never a note
    if (file.extension === 'md' && !isDraftCopy(file.path) && this.app.metadataCache.getFileCache(file)?.frontmatter?.['Pentimento'] === true) {
      this.dailyNotes.set(file.path, file)
    } else {
      this.dailyNotes.delete(file.path)
    }
  }

  /** Once a day: a draft of each note that has drafts, changed since the last one, and sits idle. */
  async runDailyDrafts(): Promise<void> {
    if (!this.settings.dailyDrafts) return
    // Discover existing histories once per session, only when daily drafts are enabled.
    // Metadata events keep this set current, including notes stamped by the CLI.
    if (!this.dailyNotesInitialized) {
      this.dailyNotesInitialized = true
      for (const file of this.app.vault.getMarkdownFiles()) this.trackDailyNote(file)
    }
    // Moving a parent folder updates its TFiles without a rename event for each note.
    this.dailyNotes = new Map([...this.dailyNotes.values()].map((file) => [file.path, file]))
    const today = new Date().toDateString()
    const saved: string[] = []
    for (const file of [...this.dailyNotes.values()]) {
      if (isDraftCopy(file.path) || this.app.metadataCache.getFileCache(file)?.frontmatter?.['Pentimento'] !== true) continue
      if (Date.now() - file.stat.mtime < QUIET_MS) continue
      try {
        const s = await draftStatus(this.store, file.path)
        if (!s?.latest || !s.dirty || new Date(s.latest.created_at).toDateString() === today) continue
        if (await this.saveFile(file, { source: 'daily draft' }, true)) saved.push(file.basename)
      } catch { /* one unreadable history doesn't stop the rest */ }
    }
    if (saved.length) new Notice(`Saved daily drafts: ${saved.join(', ')}`)
  }
}

const folderOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
const join = (folder: string, rel: string): string => normalizePath(folder ? `${folder}/${rel}` : rel)

class NoteModal extends Modal {
  private summary = ''
  private why = ''

  constructor(app: App, private onSubmit: (summary: string, why: string) => void) {
    super(app)
  }

  onOpen(): void {
    this.setTitle('Save draft')
    new Setting(this.contentEl)
      .setName('What changed')
      .setDesc('Leave empty to have it written from the changes.')
      .addText((t) => {
        t.setPlaceholder('New second verse').onChange((v) => { this.summary = v })
        t.inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.submit() })
        window.setTimeout(() => t.inputEl.focus(), 0)
      })
    new Setting(this.contentEl)
      .setName('Why')
      .addText((t) => t.setPlaceholder('Optional').onChange((v) => { this.why = v }))
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText('Save draft').setCta().onClick(() => this.submit()))
  }

  private submit(): void {
    this.close()
    this.onSubmit(this.summary.trim(), this.why.trim())
  }

  onClose(): void { this.contentEl.empty() }
}
