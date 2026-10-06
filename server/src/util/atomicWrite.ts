import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export function sha1(content: string): string {
  return crypto.createHash('sha1').update(content, 'utf8').digest('hex')
}

/**
 * 原子写盘：先写同目录临时文件（.tmp-markflow- 前缀，被文件监听忽略），
 * 再 rename 覆盖目标——外部读者永远不会看到半个文件。
 */
export async function atomicWrite(absPath: string, content: string): Promise<void> {
  const dir = path.dirname(absPath)
  const tmp = path.join(dir, `.tmp-markflow-${crypto.randomUUID().slice(0, 8)}`)
  await fs.promises.writeFile(tmp, content, 'utf8')
  await fs.promises.rename(tmp, absPath)
}
