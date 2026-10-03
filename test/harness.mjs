// Loads the built main.js against a minimal fake of Obsidian's API, backed by a real folder,
// and walks a note through the save / edit / restore / daily-draft cycle. It exercises the
// plugin's own code paths; the panel's DOM drawing is left to a real Obsidian.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Module from 'node:module'
import assert from 'node:assert/strict'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pentimento-vault-'))
const abs = (p) => path.join(root, p)
const notices = []

class TFile {
  constructor(p) { this.path = p; this.extension = path.extname(p).slice(1); this.basename = path.basename(p, '.md') }
  get stat() { return { mtime: fs.statSync(abs(this.path)).mtimeMs } }
}
const status = { text: '', shown: false, classes: new Set(), attrs: {},
  addClass(...c) { c.forEach((x) => this.classes.add(x)) }, setAttr(k, v) { this.attrs[k] = v }, addEventListener() {},
  setText(t) { this.text = t }, hide() { this.shown = false }, show() { this.shown = true },
  toggleClass(c, on) { on ? this.classes.add(c) : this.classes.delete(c) } }
let active = null
const handlers = {}
let enumerationCount = 0
let metadataReads = []
const app = {
  vault: {
    adapter: {
      exists: async (p) => fs.existsSync(abs(p)),
      read: async (p) => fs.readFileSync(abs(p), 'utf8'),
      write: async (p, c) => fs.writeFileSync(abs(p), c),
      mkdir: async (p) => fs.mkdirSync(abs(p), { recursive: true }),
      remove: async (p) => fs.rmSync(abs(p)),
      rmdir: async (p) => fs.rmSync(abs(p), { recursive: true }),
      rename: async (a, b) => fs.renameSync(abs(a), abs(b)),
      stat: async (p) => (fs.existsSync(abs(p)) ? { mtime: fs.statSync(abs(p)).mtimeMs } : null),
      list: async (p) => ({
        files: fs.readdirSync(abs(p)).filter((f) => fs.statSync(path.join(abs(p), f)).isFile()),
        folders: fs.readdirSync(abs(p)).filter((f) => fs.statSync(path.join(abs(p), f)).isDirectory()),
      }),
    },
    cachedRead: async (file) => fs.readFileSync(abs(file.path), 'utf8'),
    process: async (file, fn) => { const out = fn(fs.readFileSync(abs(file.path), 'utf8')); fs.writeFileSync(abs(file.path), out); return out },
    getMarkdownFiles: () => {
      enumerationCount++
      // Obsidian lists notes in every visible folder, never in hidden ones
      const out = []
      const walk = (rel) => {
        for (const e of fs.readdirSync(abs(rel), { withFileTypes: true })) {
          if (e.name.startsWith('.')) continue
          const p = rel ? `${rel}/${e.name}` : e.name
          if (e.isDirectory()) walk(p)
          else if (e.name.endsWith('.md')) out.push(new TFile(p))
        }
      }
      walk('')
      return out
    },
    on: (name, fn) => { handlers[name] = fn; return {} },
  },
  workspace: {
    getActiveFile: () => active,
    getLeavesOfType: () => [],
    on: (name, fn) => { handlers[name] = fn; return {} },
    onLayoutReady: (fn) => fn(),
  },
  metadataCache: {
    on: (name, fn) => { handlers[`metadata:${name}`] = fn; return {} },
    getFileCache: (file) => {
      metadataReads.push(file.path)
      const m = /^---\n([\s\S]*?)\n---/.exec(fs.readFileSync(abs(file.path), 'utf8'))
      return { frontmatter: m && /^Pentimento: true$/m.test(m[1]) ? { Pentimento: true } : undefined }
    },
  },
}

class Plugin {
  constructor(a) { this.app = a; this.commands = {} }
  registerView() {} addRibbonIcon() {} addSettingTab() {} registerEvent() {} registerInterval(id) { clearInterval(id); return id }
  addCommand(c) { this.commands[c.id] = c } addStatusBarItem() { return status }
  async loadData() { return { author: 'Lucas', dailyDrafts: false } } async saveData() {}
}
const fake = {
  Plugin, TFile, ItemView: class {}, Modal: class {}, PluginSettingTab: class {}, Setting: class {}, MarkdownView: class {},
  Notice: class { constructor(m) { notices.push(m) } },
  normalizePath: (p) => p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, ''),
  sanitizeHTMLToDom: () => null,
}
const load = Module._load
Module._load = function (req, ...rest) { return req === 'obsidian' ? fake : load.call(this, req, ...rest) }
globalThis.window = globalThis
const require = Module.createRequire(import.meta.url)
const Pentimento = require('../main.js').default

const settle = () => new Promise((r) => setTimeout(r, 20))
const write = (p, s) => fs.writeFileSync(abs(p), s)
const read = (p) => fs.readFileSync(abs(p), 'utf8')

write('Harbor.md', '# Harbor Lights\n\n## Chorus\nharbor lights, harbor lights\nkeep the water gold tonight\n\n## Bridge\nmaybe it is the tide, maybe it is the wine\n')
write('Untracked.md', '# Shopping\n\neggs\n')
active = new TFile('Harbor.md')

const plugin = new Pentimento(app)
await plugin.onload()
await settle()
assert.equal(status.text, 'No drafts')
assert.equal(enumerationCount, 0, 'disabled daily drafts do not enumerate the vault')
assert.equal(plugin.commands['save-draft'].checkCallback(true), true)

await plugin.saveFile(active)
assert.match(notices.at(-1), /^Saved r001: First draft$/)
assert.match(read('Harbor.md'), /Current Revision: r001/)
await settle()
await new Promise((r) => setTimeout(r, 10))

write('Harbor.md', read('Harbor.md').replace('harbor lights, harbor lights\nkeep the water gold tonight', 'so let the harbor burn its lamps\nlet the last boat slip its ropes'))
handlers.modify(active)
await new Promise((r) => setTimeout(r, 700))
assert.equal(status.text, 'r001 · edited')
assert.ok(status.classes.has('is-edited'))

await plugin.saveFile(active)
assert.equal(notices.at(-1), 'Saved r002: Rewrote Chorus')
write('Harbor.md', read('Harbor.md').replace(/\n## Bridge\n.*\n/, '\n'))
await plugin.saveFile(active)
assert.equal(notices.at(-1), 'Saved r003: Removed Bridge')

// restore r001 after a further unsaved edit: the edit is kept as its own draft first
write('Harbor.md', read('Harbor.md') + '\none stray line\n')
await plugin.restore(active, 'r001')
assert.equal(notices.at(-1), 'Restored r001 as r005')
assert.match(read('Harbor.md'), /keep the water gold tonight/)
const meta = read('.history/Harbor/meta.yml')
assert.match(meta, /summary: Saved before restoring r001/)
assert.match(meta, /summary: Restored r001/)
assert.match(meta, /author: Lucas/)

// daily drafts: only tracked notes that changed, are idle, and have no draft today
plugin.settings.dailyDrafts = true
write('Harbor.md', read('Harbor.md') + '\na late addition\n')
await plugin.runDailyDrafts()
assert.ok(!fs.existsSync(abs('.history/Harbor/r006.md')), 'a draft from today blocks the daily one')
const m = read('.history/Harbor/meta.yml').replace(/(created_at: "?)\d{4}-\d{2}-\d{2}/g, '$12026-01-01')
write('.history/Harbor/meta.yml', m)
await plugin.runDailyDrafts()
assert.ok(!fs.existsSync(abs('.history/Harbor/r006.md')), 'a note edited minutes ago is left alone')
const old = new Date(Date.now() - 60 * 60 * 1000)
fs.utimesSync(abs('Harbor.md'), old, old)
await plugin.runDailyDrafts()
assert.ok(fs.existsSync(abs('.history/Harbor/r006.md')), 'an idle, changed note gets its daily draft')
assert.equal(notices.at(-1), 'Saved daily drafts: Harbor')
assert.ok(!fs.existsSync(abs('.history/Untracked')), 'notes without drafts are never touched')
assert.match(read('.history/Harbor/meta.yml'), /source: daily draft/)

assert.equal(enumerationCount, 1, 'daily checks discover existing notes only once')
metadataReads = []
await plugin.runDailyDrafts()
assert.ok(!metadataReads.includes('Untracked.md'), 'subsequent checks inspect only participating notes')
plugin.settings.dailyDrafts = false
await plugin.runDailyDrafts()
plugin.settings.dailyDrafts = true
await plugin.runDailyDrafts()
assert.equal(enumerationCount, 1, 'reenabling daily drafts reuses the maintained set')

// An external tool stamps a note after initial discovery; metadata events enroll it.
write('External.md', read('Harbor.md').replace('History Folder: .history/Harbor', 'History Folder: .history/External'))
handlers['metadata:changed'](new TFile('External.md'))
metadataReads = []
await plugin.runDailyDrafts()
assert.ok(metadataReads.includes('External.md'), 'externally tracked notes join daily checks')
write('External.md', '# No longer tracked\n')
handlers['metadata:changed'](new TFile('External.md'))
metadataReads = []
await plugin.runDailyDrafts()
assert.ok(!metadataReads.includes('External.md'), 'removing the property stops daily checks')
write('External.md', read('Harbor.md'))
handlers['metadata:changed'](new TFile('External.md'))
fs.rmSync(abs('External.md'))
handlers.delete(new TFile('External.md'))
metadataReads = []
await plugin.runDailyDrafts()
assert.ok(!metadataReads.includes('External.md'), 'deleted notes leave daily checks')

// remove Pentimento from the note: properties off, history gone, text untouched
const before = read('Harbor.md').replace(/^---\n[\s\S]*?\n---\n\n?/, '')
const confirmations = []
fake.Modal.prototype.open = function () { confirmations.push(this); }
await plugin.confirmRemove(active)
assert.equal(confirmations.length, 1, 'removal asks first')
assert.ok(fs.existsSync(abs('.history/Harbor')), 'nothing is removed before confirming')
await confirmations[0].onConfirm()
assert.ok(!fs.existsSync(abs('.history')), 'the history folder is gone, and the empty .history with it')
assert.equal(read('Harbor.md'), before, 'the note keeps its text and loses only the properties')
assert.match(notices.at(-1), /^Removed 6 drafts from Harbor$/)
metadataReads = []
await plugin.runDailyDrafts()
assert.ok(!metadataReads.includes('Harbor.md'), 'removing drafts also removes the note from daily checks')

// moving a note to another folder takes its drafts along
fs.mkdirSync(abs('Songs')); fs.mkdirSync(abs('Archive'))
write('Songs/Move.md', '# Move\n\nfirst words of a song\n')
const moving = new TFile('Songs/Move.md')
await plugin.saveFile(moving)
assert.ok(fs.existsSync(abs('Songs/.history/Move/r001.md')))
metadataReads = []
await plugin.runDailyDrafts()
assert.ok(metadataReads.includes('Songs/Move.md'), 'saving a new note enrolls it without another scan')
fs.renameSync(abs('Songs/Move.md'), abs('Archive/Move.md'))
handlers.rename(new TFile('Archive/Move.md'), 'Songs/Move.md')
await new Promise((r) => setTimeout(r, 800))
assert.ok(fs.existsSync(abs('Archive/.history/Move/r001.md')), 'the drafts followed the note')
assert.ok(!fs.existsSync(abs('Songs/.history')), 'the emptied .history folder is gone')
// renaming in place leaves the history where its frontmatter points
fs.renameSync(abs('Archive/Move.md'), abs('Archive/Moved.md'))
handlers.rename(new TFile('Archive/Moved.md'), 'Archive/Move.md')
await settle()
assert.ok(fs.existsSync(abs('Archive/.history/Move/r001.md')), 'a rename in place moves nothing')
metadataReads = []
await plugin.runDailyDrafts()
assert.ok(metadataReads.includes('Archive/Moved.md'), 'daily drafts follow renamed notes')
assert.ok(!metadataReads.includes('Songs/Move.md') && !metadataReads.includes('Archive/Move.md'), 'old paths leave daily checks')
assert.equal(enumerationCount, 1, 'file and metadata events never rescan the vault')

// Obsidian Sync: with the setting on, new notes keep their drafts in a visible _history folder
plugin.settings.historyFolder = '_history'
write('Fresh.md', '# Fresh\n\na new song for the synced folder\n')
const fresh = new TFile('Fresh.md')
await plugin.saveFile(fresh)
assert.ok(fs.existsSync(abs('_history/Fresh/r001.md')), 'the first draft starts in _history')
assert.match(read('Fresh.md'), /History Folder: _history\/Fresh/)
// a saved draft there looks like a note to Obsidian, but is never treated as one
active = new TFile('_history/Fresh/r001.md')
assert.equal(plugin.commands['save-draft'].checkCallback(true), false, 'a saved draft is not a note')
assert.equal(plugin.commands['remove-drafts'].checkCallback(true), false)
plugin.settings.dailyDrafts = true
const oldish = new Date(Date.now() - 60 * 60 * 1000)
fs.utimesSync(abs('_history/Fresh/r001.md'), oldish, oldish)
// Obsidian indexes the draft and reports it like any note
handlers['metadata:changed'](new TFile('_history/Fresh/r001.md'))
await plugin.runDailyDrafts()
assert.ok(!fs.existsSync(abs('_history/Fresh/_history')), 'daily drafts never start a history inside a history')
active = fresh

// a note that already has drafts in .history moves with the command, property and all
write('Older.md', '# Older\n\nwritten before syncing was on\n')
plugin.settings.historyFolder = '.history'
await plugin.saveFile(new TFile('Older.md'))
plugin.settings.historyFolder = '_history'
const offered = confirmations.length
await plugin.offerMove()
assert.equal(confirmations.length, offered + 1, 'turning sync on offers to move existing drafts')
await confirmations.at(-1).onConfirm()
assert.ok(fs.existsSync(abs('_history/Older/r001.md')), 'the drafts moved to _history')
assert.ok(!fs.existsSync(abs('.history')), 'the emptied .history folder is gone')
assert.match(read('Older.md'), /History Folder: _history\/Older/)
// the renamed note from earlier (Archive/Moved.md, drafts in .history/Move) moves too
assert.match(notices.at(-1), /^Moved the drafts of 2 notes to _history$/)
assert.ok(fs.existsSync(abs('Archive/_history/Move/r001.md')) && !fs.existsSync(abs('Archive/.history')))
const { verifyDoc } = await import('pentimento/dist/verify.js').catch(() => import(path.join(process.cwd(), 'node_modules/pentimento/dist/verify.js')))
assert.deepEqual(verifyDoc(abs('Older.md')).filter((i) => i.level === 'error'), [], 'the CLI agrees with the moved history')
await plugin.saveFile(new TFile('Older.md'))
assert.ok(fs.existsSync(abs('_history/Older/r002.md')), 'later drafts go to the new place')
// and back: turning sync off moves them into hidden folders again
plugin.settings.historyFolder = '.history'
await plugin.moveHistories()
assert.ok(fs.existsSync(abs('.history/Older/r002.md')) && fs.existsSync(abs('.history/Fresh/r001.md')))
assert.ok(!fs.existsSync(abs('_history')), 'the emptied _history folder is gone')
plugin.settings.historyFolder = '_history'
await plugin.moveHistories()

// a note moved to another folder takes its _history along, and the emptied one goes
fs.mkdirSync(abs('Elsewhere'))
fs.renameSync(abs('Fresh.md'), abs('Elsewhere/Fresh.md'))
handlers.rename(new TFile('Elsewhere/Fresh.md'), 'Fresh.md')
await new Promise((r) => setTimeout(r, 800))
assert.ok(fs.existsSync(abs('Elsewhere/_history/Fresh/r001.md')), 'the drafts followed the note')
assert.ok(fs.existsSync(abs('_history/Older')), 'other notes keep their drafts')

console.log('harness: all checks passed')
console.log(notices.join('\n'))
fs.rmSync(root, { recursive: true })
