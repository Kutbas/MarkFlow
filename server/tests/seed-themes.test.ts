/** 主题播种：内置主题增量复制到主题目录（生产容器主题卷为空的发布阻断项） */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, expect, it, vi } from 'vitest'

let seedsRoot = ''
let themesDir = ''

beforeEach(() => {
  seedsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-seeds-'))
  themesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-themes-'))
  fs.mkdirSync(path.join(seedsRoot, 'themes'))
  // 注意：不建 notes 目录——本文件聚焦主题，避免触碰笔记播种/PG
  fs.writeFileSync(path.join(seedsRoot, 'themes', 'markflow-a.css'), '/* a */')
  fs.writeFileSync(path.join(seedsRoot, 'themes', 'markflow-b.css'), '/* b */')
  fs.writeFileSync(path.join(seedsRoot, 'themes', 'README.md'), '非 css 忽略')

  process.env.SEEDS_DIR = seedsRoot
  process.env.THEMES_DIR = themesDir
})

afterAll(() => {
  fs.rmSync(seedsRoot, { recursive: true, force: true })
  fs.rmSync(themesDir, { recursive: true, force: true })
})

async function runSeed(): Promise<void> {
  // config 在 import 时固化 THEMES_DIR——每个用例的 tmpdir 不同，必须重置模块注册表
  // （storage/index 与 bootstrap 同批重置，setStorageOverride 的单例才对 bootstrap 生效）
  vi.resetModules()
  const { setStorageOverride } = await import('../src/storage/index.js')
  setStorageOverride({ readTree: async () => [] } as never)
  const { seedIfEmpty } = await import('../src/bootstrap.js')
  await seedIfEmpty()
}

it('主题目录为空时复制内置 css（忽略非 css）', async () => {
  await runSeed()
  expect(fs.existsSync(path.join(themesDir, 'markflow-a.css'))).toBe(true)
  expect(fs.existsSync(path.join(themesDir, 'markflow-b.css'))).toBe(true)
  expect(fs.existsSync(path.join(themesDir, 'README.md'))).toBe(false)
})

it('已有同名主题不覆盖 + 新增内置主题自动补齐', async () => {
  // 用户自定义版（内容必须保留）
  fs.writeFileSync(path.join(themesDir, 'markflow-a.css'), '/* 用户自定义 */')
  await runSeed()
  expect(fs.readFileSync(path.join(themesDir, 'markflow-a.css'), 'utf8')).toBe('/* 用户自定义 */')

  // 升级场景：seeds 带来新主题
  fs.writeFileSync(path.join(seedsRoot, 'themes', 'markflow-new.css'), '/* new */')
  await runSeed()
  expect(fs.readFileSync(path.join(themesDir, 'markflow-a.css'), 'utf8')).toBe('/* 用户自定义 */')
  expect(fs.existsSync(path.join(themesDir, 'markflow-new.css'))).toBe(true)
})

it('seeds 无 themes 目录时静默跳过', async () => {
  fs.rmSync(path.join(seedsRoot, 'themes'), { recursive: true })
  await expect(runSeed()).resolves.toBeUndefined()
  expect(fs.readdirSync(themesDir)).toHaveLength(0)
})
