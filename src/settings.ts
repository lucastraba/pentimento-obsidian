import { PluginSettingTab, Setting, type App, type SettingDefinitionItem } from 'obsidian'
import type { HistoryFolder } from 'pentimento/model'
import type PentimentoPlugin from './main'

export interface PentimentoSettings {
  /** recorded on each draft; empty means "unknown", as with the CLI outside git */
  author: string
  /** once a day, save a draft of every note that has drafts and changed since the last one */
  dailyDrafts: boolean
  /** where a note's first draft starts its history: hidden `.history`, or `_history`, which Obsidian Sync carries */
  historyFolder: HistoryFolder
}

export const DEFAULT_SETTINGS: PentimentoSettings = {
  author: '',
  dailyDrafts: false,
  historyFolder: '.history',
}

const AUTHOR = { name: 'Your name', desc: 'Recorded as the author of each draft you save.' }
const SYNC = {
  name: 'Sync drafts with Obsidian Sync',
  desc: 'Obsidian Sync skips hidden folders, so drafts in .history stay on the device that saved them. With this on, new notes keep their drafts in a visible _history folder instead. Obsidian then treats saved drafts as notes: they appear in search and the graph unless you add _history to Excluded files, and renaming a note also rewrites links inside its old drafts, even when excluded. Notes that already have drafts can be moved.',
}
const DAILY = {
  name: 'Save a draft every day',
  desc: 'Once a day, notes that already have drafts and changed since their last one get a new draft. Notes you are editing right now are left until you stop for a while.',
}

export class PentimentoSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: PentimentoPlugin) {
    super(app, plugin)
  }

  /** Obsidian 1.13 and later render these, and include them in settings search. */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      { ...AUTHOR, control: { type: 'text', key: 'author', placeholder: 'Your name' } },
      { ...DAILY, control: { type: 'toggle', key: 'dailyDrafts' } },
      { ...SYNC, control: { type: 'toggle', key: 'syncDrafts' } },
    ]
  }

  getControlValue(key: string): unknown {
    if (key === 'syncDrafts') return this.plugin.settings.historyFolder === '_history'
    return (this.plugin.settings as unknown as Record<string, unknown>)[key]
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    if (key === 'author') this.plugin.settings.author = typeof value === 'string' ? value.trim() : ''
    else if (key === 'dailyDrafts') this.plugin.settings.dailyDrafts = value === true
    else if (key === 'syncDrafts') this.plugin.settings.historyFolder = value === true ? '_history' : '.history'
    await this.plugin.saveSettings()
    if (key === 'dailyDrafts' && value === true) void this.plugin.runDailyDrafts()
    if (key === 'syncDrafts') void this.plugin.offerMove()
  }

  /** The same settings for Obsidian versions before 1.13, which don't read the definitions. */
  display(): void {
    const { containerEl } = this
    containerEl.empty()

    new Setting(containerEl)
      .setName(AUTHOR.name)
      .setDesc(AUTHOR.desc)
      .addText((text) => text
        .setPlaceholder('Your name')
        .setValue(this.plugin.settings.author)
        .onChange((value) => { void this.setControlValue('author', value) }))

    new Setting(containerEl)
      .setName(DAILY.name)
      .setDesc(DAILY.desc)
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.dailyDrafts)
        .onChange((value) => { void this.setControlValue('dailyDrafts', value) }))

    new Setting(containerEl)
      .setName(SYNC.name)
      .setDesc(SYNC.desc)
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.historyFolder === '_history')
        .onChange((value) => { void this.setControlValue('syncDrafts', value) }))
  }
}
