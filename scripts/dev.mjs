#!/usr/bin/env node
/**
 * Convenience launcher: starts the Flask backend and the Vite dev server
 * together, prefixes their output, and shuts both down on Ctrl+C.
 *
 *   npm start
 *
 * Equivalent to running these in two terminals:
 *   python backend/app.py
 *   npm --prefix frontend start
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const BACKEND_PORT = process.env.COPPIFY_PORT || '5000'
const FRONTEND_PORT = process.env.FRONTEND_PORT || '3000'

const BACKEND_PORT_IS_NUMBER = /^\d+$/.test(BACKEND_PORT)

const COLOURS = { backend: '\x1b[36m', frontend: '\x1b[35m', reset: '\x1b[0m' }

/** Pipe a child's output through, tagging each line with its source. */
function pipeWithTag(stream, target, tag, colour) {
  let buffer = ''
  stream.on('data', (chunk) => {
    buffer += chunk.toString()
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) target.write(`${colour}[${tag}]${COLOURS.reset} ${line}\n`)
  })
  stream.on('end', () => {
    if (buffer) target.write(`${colour}[${tag}]${COLOURS.reset} ${buffer}\n`)
  })
}

const children = []
let shuttingDown = false

const IS_WINDOWS = process.platform === 'win32'

/**
 * `npm` is a .cmd shim on Windows, which needs the shell. Passing arguments
 * through a shell is also a deprecation warning in modern Node, so on Windows
 * we invoke npm.cmd directly with no shell, and elsewhere we use the real npm.
 */
function npmCommand() {
  return IS_WINDOWS ? 'npm.cmd' : 'npm'
}

function start(name, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd || ROOT,
    env: { ...process.env, ...options.env },
    shell: Boolean(options.shell),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  pipeWithTag(child.stdout, process.stdout, name, COLOURS[name] ?? '')
  pipeWithTag(child.stderr, process.stderr, name, COLOURS[name] ?? '')

  child.on('exit', (code, signal) => {
    if (shuttingDown) return
    process.stderr.write(`\n[${name}] exited (${signal || `code ${code}`}) - stopping everything.\n`)
    shutdown(code ?? 1)
  })

  children.push(child)
  return child
}

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM')
  }
  setTimeout(() => process.exit(code), 400)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

// --- preflight -------------------------------------------------------------
const backendArgs = BACKEND_PORT_IS_NUMBER
  ? ['backend/app.py', '--port', BACKEND_PORT]
  : ['backend/app.py']

console.log('Starting Coppify...\n')

if (!BACKEND_PORT_IS_NUMBER) {
  console.log('[warn] COPPIFY_PORT is not numeric; starting the backend on its default port.\n')
}

start('backend', process.env.PYTHON || 'python', backendArgs)
start('frontend', 'npm', ['--prefix', 'frontend', 'start'], { shell: true })

console.log(`\n  Frontend : http://localhost:${FRONTEND_PORT}`)
console.log(`  Backend  : http://127.0.0.1:${BACKEND_PORT}`)
console.log('\nPress Ctrl+C to stop both.\n')