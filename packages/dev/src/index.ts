#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

function printUsage() {
  console.log('Usage: stravix-dev <entry-file> [-- <node-args>]')
  console.log('Example: stravix-dev src/index.ts')
}

const args = process.argv.slice(2)
if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  printUsage()
  process.exit(args.length ? 0 : 1)
}

const separatorIndex = args.indexOf('--')
const entryArg = separatorIndex === -1 ? args[0] : args.slice(0, separatorIndex)[0]
const passthrough = separatorIndex === -1 ? [] : args.slice(separatorIndex + 1)

if (!entryArg) {
  printUsage()
  process.exit(1)
}

const entryPath = path.resolve(process.cwd(), entryArg)
if (!existsSync(entryPath)) {
  console.error(`Entry file not found: ${entryPath}`)
  process.exit(1)
}

const isTypeScriptEntry = /\.(ts|tsx|mts|cts)$/.test(entryPath)
const nodeArgs = ['--watch', '--enable-source-maps']

if (isTypeScriptEntry) {
  nodeArgs.push('--import', 'tsx')
}

nodeArgs.push(entryPath, ...passthrough)

console.log(`Stravix dev watching: ${entryArg}`)

const child = spawn(process.execPath, nodeArgs, {
  stdio: 'inherit',
  env: process.env
})

process.on('SIGINT', () => {
  child.kill('SIGINT')
})

process.on('SIGTERM', () => {
  child.kill('SIGTERM')
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }

  process.exit(code ?? 0)
})
