#!/usr/bin/env node
import { cp, mkdir, readFile, writeFile, access, rename } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { emitKeypressEvents } from 'node:readline'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function printUsage() {
  console.log('Usage: create-stravi <project-name> [--ts|--js]')
  console.log('Example: npm create stravi@latest my-api')
}

function detectPackageManager() {
  const ua = process.env.npm_config_user_agent || ''
  if (ua.startsWith('pnpm/')) return 'pnpm'
  if (ua.startsWith('yarn/')) return 'yarn'
  if (ua.startsWith('bun/')) return 'bun'
  return 'npm'
}

function getNextStepCommands() {
  const pm = detectPackageManager()

  if (pm === 'pnpm') {
    return { install: 'pnpm install', dev: 'pnpm dev' }
  }

  if (pm === 'yarn') {
    return { install: 'yarn', dev: 'yarn dev' }
  }

  if (pm === 'bun') {
    return { install: 'bun install', dev: 'bun run dev' }
  }

  return { install: 'npm install', dev: 'npm run dev' }
}

async function exists(targetPath) {
  try {
    await access(targetPath, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

function parseArgs(argv) {
  let projectName
  let language

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      return { help: true }
    }

    if (arg === '--ts' || arg === '--typescript') {
      if (language && language !== 'ts') {
        throw new Error('Choose only one language flag: --ts or --js.')
      }
      language = 'ts'
      continue
    }

    if (arg === '--js' || arg === '--javascript') {
      if (language && language !== 'js') {
        throw new Error('Choose only one language flag: --ts or --js.')
      }
      language = 'js'
      continue
    }

    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`)
    }

    if (projectName) {
      throw new Error('Only one project name can be provided.')
    }

    projectName = arg
  }

  return { help: false, language, projectName }
}

function clearMenuLines(count) {
  process.stdout.write('\r')
  for (let i = 0; i < count; i += 1) {
    process.stdout.write('\x1B[2K')
    if (i < count - 1) {
      process.stdout.write('\x1B[1A\r')
    }
  }
  process.stdout.write('\r')
}

function renderLanguagePrompt(selectedIndex) {
  const options = ['TypeScript', 'JavaScript']
  process.stdout.write('Select language:\n')
  for (let i = 0; i < options.length; i += 1) {
    const prefix = i === selectedIndex ? '❯' : ' '
    const suffix = i === options.length - 1 ? '' : '\n'
    process.stdout.write(`${prefix} ${options[i]}${suffix}`)
  }
}

async function promptForLanguage() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return 'ts'
  }

  const options = ['ts', 'js']
  let selectedIndex = 0

  return new Promise((resolve) => {
    const stdin = process.stdin
    emitKeypressEvents(stdin)

    const wasRaw = Boolean(stdin.isRaw)
    if (!wasRaw) {
      stdin.setRawMode(true)
    }

    const cleanup = (value) => {
      stdin.off('keypress', onKeypress)
      if (!wasRaw) {
        stdin.setRawMode(false)
      }
      stdin.pause()
      clearMenuLines(3)
      process.stdout.write(`Select language:\n❯ ${value === 'ts' ? 'TypeScript' : 'JavaScript'}\n`)
      resolve(value)
    }

    const onKeypress = (_, key) => {
      if (key?.name === 'up' || key?.name === 'k') {
        selectedIndex = selectedIndex === 0 ? options.length - 1 : selectedIndex - 1
        clearMenuLines(3)
        renderLanguagePrompt(selectedIndex)
        return
      }

      if (key?.name === 'down' || key?.name === 'j') {
        selectedIndex = selectedIndex === options.length - 1 ? 0 : selectedIndex + 1
        clearMenuLines(3)
        renderLanguagePrompt(selectedIndex)
        return
      }

      if (key?.name === 'return') {
        cleanup(options[selectedIndex])
        return
      }

      if (key?.ctrl && key.name === 'c') {
        process.stdout.write('\n')
        process.exit(1)
      }
    }

    renderLanguagePrompt(selectedIndex)
    stdin.on('keypress', onKeypress)
    stdin.resume()
  })
}

async function run() {
  let parsed
  try {
    parsed = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }

  if (parsed.help) {
    printUsage()
    process.exit(0)
  }

  const { projectName } = parsed

  if (!projectName) {
    printUsage()
    process.exit(1)
  }

  if (!/^[a-zA-Z0-9-_]+$/.test(projectName)) {
    console.error('Project name can only contain letters, numbers, dashes, and underscores.')
    process.exit(1)
  }

  const targetDir = path.resolve(process.cwd(), projectName)

  if (await exists(targetDir)) {
    console.error(`Directory already exists: ${targetDir}`)
    process.exit(1)
  }

  const language = parsed.language || (await promptForLanguage())
  const templateDir = path.resolve(__dirname, language === 'js' ? 'template-js' : 'template-ts')

  await mkdir(targetDir, { recursive: true })
  await cp(templateDir, targetDir, { recursive: true })

  const gitignorePath = path.join(targetDir, 'gitignore.txt')
  const dotGitignorePath = path.join(targetDir, '.gitignore')
  if ((await exists(gitignorePath)) && !(await exists(dotGitignorePath))) {
    await rename(gitignorePath, dotGitignorePath)
  }

  const packageJsonPath = path.join(targetDir, 'package.json')
  const packageJsonRaw = await readFile(packageJsonPath, 'utf8')
  const packageJson = JSON.parse(packageJsonRaw)
  packageJson.name = projectName
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8')

  const tsconfigPath = path.join(targetDir, 'tsconfig.json')
  if (await exists(tsconfigPath)) {
    const tsconfigRaw = await readFile(tsconfigPath, 'utf8')
    const tsconfig = JSON.parse(tsconfigRaw)

    if (tsconfig?.compilerOptions?.paths) {
      delete tsconfig.compilerOptions.paths
      await writeFile(tsconfigPath, `${JSON.stringify(tsconfig, null, 2)}\n`, 'utf8')
    }
  }

  const nextSteps = getNextStepCommands()
  const languageLabel = language === 'js' ? 'JavaScript' : 'TypeScript'

  console.log('\nStravi app created successfully.')
  console.log(`Template: ${languageLabel}`)
  console.log(`\nNext steps:\n  cd ${projectName}\n  ${nextSteps.install}\n  ${nextSteps.dev}\n`)
}

run().catch((error) => {
  console.error('Failed to create app:', error)
  process.exit(1)
})
