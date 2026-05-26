#!/usr/bin/env node
import { cp, mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function printUsage() {
  console.log('Usage: create-stravix <project-name>')
  console.log('Example: npm create stravix@latest my-api')
}

async function exists(targetPath) {
  try {
    await access(targetPath, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

async function run() {
  const projectName = process.argv[2]

  if (!projectName || projectName === '--help' || projectName === '-h') {
    printUsage()
    process.exit(projectName ? 0 : 1)
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

  const templateDir = path.resolve(__dirname, '../template')

  await mkdir(targetDir, { recursive: true })
  await cp(templateDir, targetDir, { recursive: true })

  const packageJsonPath = path.join(targetDir, 'package.json')
  const packageJsonRaw = await readFile(packageJsonPath, 'utf8')
  const packageJson = JSON.parse(packageJsonRaw)
  packageJson.name = projectName
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8')

  console.log('\nStravix app created successfully.')
  console.log(`\nNext steps:\n  cd ${projectName}\n  npm install\n  npm run dev\n`)
}

run().catch((error) => {
  console.error('Failed to create app:', error)
  process.exit(1)
})


