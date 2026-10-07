import path from 'node:path'
import { Router } from 'express'
import { config } from '../config.js'
import {
  PathError,
  isMarkdownPath,
  validateName,
  validateRelPath,
} from './paths.js'
import { getStorage } from '../storage/index.js'
import { retireDoc } from '../collab/hocuspocus.js'

export const filesRouter = Router()

/** adapter 原始错误 → PathError（保持 API 语义） */
function mapStorageError(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg === 'EXISTS') throw new PathError('目标位置已存在同名条目', 409)
  if (msg === 'NOT_FOUND') throw new PathError('路径不存在', 404)
  throw err instanceof PathError ? err : err
}

/** GET /api/files/tree — 完整目录树 */
filesRouter.get('/files/tree', async (_req, res) => {
  const storage = await getStorage()
  res.json({ tree: await storage.readTree() })
})

/** GET /api/files/content?path= — 读取单篇 Markdown（预览/导出页） */
filesRouter.get('/files/content', async (req, res) => {
  const rel = validateRelPath(String(req.query.path ?? ''), { mustBeMd: true })
  const storage = await getStorage()
  try {
    const md = await storage.readMarkdown(rel)
    res.json({ path: rel, content: md })
  } catch (err) {
    mapStorageError(err)
  }
})

interface CreateBody {
  parentDir?: string
  name?: string
  type?: 'file' | 'folder'
}

/** POST /api/files — 新建文件（自动补 .md 后缀）或文件夹 */
filesRouter.post('/files', async (req, res) => {
  const { parentDir = '', name, type = 'file' } = req.body as CreateBody
  if (name === undefined) throw new PathError('名称为空')
  const cleanName = validateName(name)
  const parent = parentDir === '' ? '' : validateRelPath(parentDir)
  const storage = await getStorage()

  if (type === 'folder') {
    const rel = parent ? `${parent}/${cleanName}` : cleanName
    try {
      await storage.createFolder(rel)
    } catch (err) {
      mapStorageError(err)
    }
    res.status(201).json({ path: rel, type: 'dir' })
    return
  }

  const fileName = isMarkdownPath(cleanName) ? cleanName : `${cleanName}.md`
  const rel = parent ? `${parent}/${fileName}` : fileName
  const title = fileName.replace(/\.md$/i, '')
  try {
    await storage.createFile(rel, `# ${title}\n\n`)
  } catch (err) {
    mapStorageError(err)
  }
  res.status(201).json({ path: rel, type: 'file' })
})

interface RenameBody {
  path?: string
  newName?: string
}

/** POST /api/files/rename — 重命名（同目录，含子孙路径整体迁移） */
filesRouter.post('/files/rename', async (req, res) => {
  const { path: rel, newName } = req.body as RenameBody
  if (rel === undefined || newName === undefined) throw new PathError('参数缺失')
  const cleanNewName = validateName(newName)
  const cur = validateRelPath(rel)
  const storage = await getStorage()

  const isMd = isMarkdownPath(cur)
  if (isMd && !isMarkdownPath(cleanNewName)) {
    throw new PathError('文件必须保留 .md 后缀')
  }
  const dirRel = path.posix.dirname(cur)
  const toRel = dirRel === '.' ? cleanNewName : `${dirRel}/${cleanNewName}`
  if (!(await storage.exists(cur))) throw new PathError('路径不存在', 404)
  if (await storage.exists(toRel)) throw new PathError('目标名称已存在', 409)
  await retireDoc(cur)
  try {
    await storage.rename(cur, toRel)
  } catch (err) {
    mapStorageError(err)
  }
  res.json({ path: toRel })
})

interface MoveBody {
  path?: string
  newParentDir?: string
}

/** POST /api/files/move — 移动文件或文件夹（禁止移动到自身内部） */
filesRouter.post('/files/move', async (req, res) => {
  const { path: rel, newParentDir } = req.body as MoveBody
  if (rel === undefined || newParentDir === undefined) throw new PathError('参数缺失')
  const cur = validateRelPath(rel)
  const targetDir = newParentDir === '' ? '' : validateRelPath(newParentDir)
  const storage = await getStorage()

  if (targetDir === cur || targetDir.startsWith(cur + '/')) {
    throw new PathError('不能移动到自身内部')
  }
  if (targetDir !== '') {
    if (!(await storage.exists(targetDir))) throw new PathError('目标目录不存在', 404)
    if (!(await storage.isFolder(targetDir))) throw new PathError('目标必须是文件夹')
  }
  const toRel = targetDir === '' ? path.posix.basename(cur) : `${targetDir}/${path.posix.basename(cur)}`
  if (await storage.exists(toRel)) throw new PathError('目标位置已存在同名条目', 409)
  await retireDoc(cur)
  try {
    await storage.move(cur, toRel)
  } catch (err) {
    mapStorageError(err)
  }
  res.json({ path: toRel })
})

/** POST /api/files/delete — 删除文件或文件夹（文件夹递归） */
filesRouter.post('/files/delete', async (req, res) => {
  const { path: rel } = req.body as { path?: string }
  if (rel === undefined) throw new PathError('参数缺失')
  const cur = validateRelPath(rel)
  const storage = await getStorage()
  await retireDoc(cur)
  if (!(await storage.exists(cur))) throw new PathError('路径不存在', 404)
  try {
    await storage.remove(cur)
  } catch (err) {
    mapStorageError(err)
  }
  res.json({ ok: true, path: rel })
})

void config
