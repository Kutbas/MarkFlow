/** PG 模式测试环境：必须最先 import（在 config 求值前设置 STORAGE） */
process.env.STORAGE = 'postgres'
import './env.js'
