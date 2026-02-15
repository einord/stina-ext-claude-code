#!/usr/bin/env node

/**
 * Pack the extension for distribution
 *
 * Creates a zip file containing:
 * - manifest.json
 * - dist/index.js
 * - README.md
 *
 * Output is placed in the releases/ directory.
 */

import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = join(__dirname, '..')
const releasesDir = join(rootDir, 'releases')

// Read manifest for version
const manifest = JSON.parse(readFileSync(join(rootDir, 'manifest.json'), 'utf-8'))
const outputName = `${manifest.id}-${manifest.version}.zip`
const outputPath = join(releasesDir, outputName)

// Check if dist exists
if (!existsSync(join(rootDir, 'dist', 'index.js'))) {
  console.error('Error: dist/index.js not found. Run "pnpm build" first.')
  process.exit(1)
}

// Ensure releases directory exists
if (!existsSync(releasesDir)) {
  mkdirSync(releasesDir, { recursive: true })
  console.log('Created releases/ directory')
}

// Create zip using system zip command
try {
  execSync(`zip -j "${outputPath}" manifest.json dist/index.js README.md`, {
    cwd: rootDir,
    stdio: 'inherit',
  })
  console.log(`\n✓ Created: releases/${outputName}`)
  console.log('\nTo create a release:')
  console.log('1. Push changes to main branch')
  console.log('2. GitHub Action will automatically create a release')
} catch (error) {
  console.error('Failed to create zip:', error.message)
  process.exit(1)
}
