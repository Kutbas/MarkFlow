/** 生成 bcrypt 哈希：pnpm --filter @markflow/server run hash -- 你的密码 */
import bcrypt from 'bcryptjs'

const password = process.argv[2]
if (!password) {
  console.error('用法: pnpm --filter @markflow/server run hash -- <密码>')
  process.exit(1)
}
console.log(await bcrypt.hash(password, 10))
