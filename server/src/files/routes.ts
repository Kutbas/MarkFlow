import fs from 'node:fs'
import path from 'node:path'
import { Router } from 'express'
import { config } from '../config.js'
import { PathError, isMarkdownPath, safeJoin, safeJoinDir, validateName } from './paths.js'
import { readTree } from './tree.js'
import { retireDoc } from '../collab/hocuspocus.js'

export const filesRouter = Router()

/** GET /api/files/tree — 完整目录树 */
filesRouter.get('/files/tree', (_req, res) => {
  res.json({ tree: readTree(config.notesDir) })
})

/** GET /api/files/content?path= — 读取单篇原始 Markdown（导出页/调试用；编辑走协同通道） */
filesRouter.get('/files/content', (req, res) => {
  const rel = String(req.query.path ?? '')
  const { abs } = safeJoin(config.notesDir, rel, { mustExist: true, mustBeMd: true })
  res.json({ path: rel, content: fs.readFileSync(abs, 'utf8') })
})

interface CreateBody {
  parentDir?: string
  name?: string
  type?: 'file' | 'folder'
}

/** POST /api/files — 新建文件（自动补 .md 后缀）或文件夹 */
filesRouter.post('/files', (req, res) => {
  const { parentDir = '', name, type = 'file' } = req.body as CreateBody
  if (name === undefined) throw new PathError('名称为空')
  const cleanName = validateName(name)
  const parent = safeJoinDir(config.notesDir, parentDir)
  if (type === 'folder') {
    const target = path.join(parent.abs, cleanName)
    if (fs.existsSync(target)) throw new PathError('同名文件夹已存在', 409)
    fs.mkdirSync(target)
    res.status(201).json({ path: parent.rel ? `${parent.rel}/${cleanName}` : cleanName, type: 'dir' })
  } else {
    const fileName = isMarkdownPath(cleanName) ? cleanName : `${cleanName}.md`
    const target = path.join(parent.abs, fileName)
    if (fs.existsSync(target)) throw new PathError('同名文件已存在', 409)
    const title = fileName.replace(/\.md$/i, '')
    fs.writeFileSync(target, `# ${title}\n\n`)
    res.status(201).json({
      path: parent.rel ? `${parent.rel}/${fileName}` : fileName,
      type: 'file',
    })
  }
})

interface RenameBody {
  path?: string
  newName?: string
}

/** POST /api/files/rename — 重命名（同目录） */
filesRouter.post('/files/rename', async (req, res) => {
  const { path: rel, newName } = req.body as RenameBody
  if (rel === undefined || newName === undefined) throw new PathError('参数缺失')
  const cleanNewName = validateName(newName)
  const current = safeJoin(config.notesDir, rel, { mustExist: true })
  if (fs.statSync(current.abs).isFile() && !isMarkdownPath(cleanNewName)) {
    throw new PathError('文件必须保留 .md 后缀')
  }
  const target = path.join(path.dirname(current.abs), cleanNewName)
  if (fs.existsSync(target)) throw new PathError('目标名称已存在', 409)
  // 改名前先下线协同文档（冲刷挂起落盘到旧路径，再断开所有连接）
  await retireDoc(current.rel)
  fs.renameSync(current.abs, target)
  const dirRel = path.posix.dirname(current.rel)
  res.json({ path: dirRel === '.' ? cleanNewName : `${dirRel}/${cleanNewName}` })
})

interface MoveBody {
  path?: string
  newParentDir?: string
}

/** POST /api/files/move — 移动文件或文件夹（禁止移动到自身内部） */
filesRouter.post('/files/move', async (req, res) => {
  const { path: rel, newParentDir } = req.body as MoveBody
  if (rel === undefined || newParentDir === undefined) throw new PathError('参数缺失')
  const current = safeJoin(config.notesDir, rel, { mustExist: true })
  const targetDir = safeJoinDir(config.notesDir, newParentDir)
  if (fs.statSync(targetDir.abs).isDirectory() === false) {
    throw new PathError('目标必须是文件夹')
  }
  if (targetDir.abs === current.abs || targetDir.abs.startsWith(current.abs + path.sep)) {
    throw new PathError('不能移动到自身内部')
  }
  const target = path.join(targetDir.abs, path.basename(current.abs))
  if (fs.existsSync(target)) throw new PathError('目标位置已存在同名条目', 409)
  // 移动前先下线协同文档
  await retireDoc(current.rel)
  fs.renameSync(current.abs, target)
  res.json({
    path: targetDir.rel ? `${targetDir.rel}/${path.basename(current.abs)}` : path.basename(current.abs),
  })
})

/** POST /api/files/delete — 删除文件或文件夹（文件夹递归删除） */
filesRouter.post('/files/delete', async (req, res) => {
  const { path: rel } = req.body as { path?: string }
  if (rel === undefined) throw new PathError('参数缺失')
  const current = safeJoin(config.notesDir, rel, { mustExist: true })
  // 删除前先下线协同文档（含目录下所有在线文档）
  await retireDoc(current.rel)
  fs.rmSync(current.abs, { recursive: true })
  res.json({ ok: true, path: rel })
})
