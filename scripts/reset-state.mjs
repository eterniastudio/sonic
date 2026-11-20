#!/usr/bin/env node
/**
 * Clears Sonic runtime state (pass --legacy for the pre-rename Sonic V2 folder) during development.
 *
 * Only the files named by the flags are removed; the managed media engine and
 * anything in your export folder are never touched. The app recreates each file
 * with its defaults on the next launch.
 *
 *   node scripts/reset-state.mjs --yes                 # queue only
 *   node scripts/reset-state.mjs --yes --library       # queue + library records
 *   node scripts/reset-state.mjs --yes --all           # everything Sonic owns
 *
 * `--yes` is required: this deletes files.
 */

import { existsSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = new Set(process.argv.slice(2))

if (!args.has('--yes')) {
  console.error('Refusing to run without --yes. This deletes Sonic state files.')
  console.error('Usage: node scripts/reset-state.mjs --yes [--library] [--settings] [--all]')
  process.exit(2)
}

function userDataDir() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    if (!appData) throw new Error('APPDATA is not set')
    return join(appData, process.argv.includes('--legacy') ? 'Sonic V2' : 'Sonic')
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Sonic')
  }
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  return join(configHome, 'Sonic')
}

const root = userDataDir()

// Directories are only removed with --all; they are caches, not decisions.
const files = ['queue.json']
const directories = []

if (args.has('--library') || args.has('--all')) files.push('library.json')
if (args.has('--settings') || args.has('--all')) files.push('settings.json', 'window.json')
if (args.has('--all')) directories.push('staging', 'covers')

const removed = []
const skipped = []

for (const name of files) {
  const target = join(root, name)
  if (!existsSync(target)) {
    skipped.push(name)
    continue
  }
  rmSync(target, { force: true })
  removed.push(name)
}

for (const name of directories) {
  const target = join(root, name)
  if (!existsSync(target)) {
    skipped.push(`${name}/`)
    continue
  }
  rmSync(target, { recursive: true, force: true })
  removed.push(`${name}/`)
}

console.log(`Sonic state at ${root}`)

const engine = join(root, 'engine')
if (existsSync(engine)) {
  const entries = statSync(engine).isDirectory() ? 'present' : 'present'
  console.log(`Kept: engine/ (${entries}) — never touched by this script`)
}

console.log(removed.length > 0 ? `Removed: ${removed.join(', ')}` : 'Removed: nothing')
if (skipped.length > 0) console.log(`Not present: ${skipped.join(', ')}`)
