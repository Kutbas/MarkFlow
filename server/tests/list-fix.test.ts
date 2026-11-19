/** 有序项下压平无序项恢复嵌套（Typora 宽松行为对齐） */
import { describe, expect, it } from 'vitest'
import { nestBulletsUnderOrdered } from '@markflow/shared/list-fix'

/** 用户实测粘贴内容（`*` 项行首无缩进、紧跟有序项、无空行） */
const REPORTED = [
  '### 三、 拆解尾部的内容：`future<invoke_result_t<F, Args...>>`',
  '',
  '尾部具体包了两个东西：',
  '',
  '1. **`std::invoke_result_t<F, Args...>`（C++17 特性）**',
  '* 它的作用是“编译期类型计算”。',
  '* 意思是：“如果我用给定的参数 `Args...` 去调用可调用对象 `F`，它的执行结果（返回值）是什么类型？”',
  '* *举个例子*：如果你传进去的任务是一个返回 `int` 的函数，那么 `invoke_result_t<F, Args...>` 的计算结果就是 `int`。如果你传的函数返回 `std::string`，它就是 `std::string`。',
].join('\n')

describe('nestBulletsUnderOrdered', () => {
  it('用户实测场景：有序项后紧跟行首无序项 → 缩进到内容列（3 空格）并连续跟随', () => {
    expect(nestBulletsUnderOrdered(REPORTED)).toBe(
      [
        '### 三、 拆解尾部的内容：`future<invoke_result_t<F, Args...>>`',
        '',
        '尾部具体包了两个东西：',
        '',
        '1. **`std::invoke_result_t<F, Args...>`（C++17 特性）**',
        '   * 它的作用是“编译期类型计算”。',
        '   * 意思是：“如果我用给定的参数 `Args...` 去调用可调用对象 `F`，它的执行结果（返回值）是什么类型？”',
        '   * *举个例子*：如果你传进去的任务是一个返回 `int` 的函数，那么 `invoke_result_t<F, Args...>` 的计算结果就是 `int`。如果你传的函数返回 `std::string`，它就是 `std::string`。',
      ].join('\n'),
    )
  })

  it('多位数字标记 `10. ` → 缩进 4 空格；右括号 `1) ` 同样触发', () => {
    expect(nestBulletsUnderOrdered('10. a\n* b\n* c')).toBe('10. a\n    * b\n    * c')
    expect(nestBulletsUnderOrdered('1) a\n* b')).toBe('1) a\n   * b')
  })

  it('续行中遇下一个行首有序项：有序项保持原位，其后无序项重新嵌套', () => {
    expect(nestBulletsUnderOrdered('1. a\n* b\n2. c\n* d')).toBe('1. a\n   * b\n2. c\n   * d')
  })

  it('空行间隔 → 不嵌套（保守边界）', () => {
    const src = '1. a\n\n* b'
    expect(nestBulletsUnderOrdered(src)).toBe(src)
  })

  it('无序项打头 / 无序项跟段落、标题、行内文字 → 一律不动', () => {
    const flat = '* a\n* b\n* c'
    expect(nestBulletsUnderOrdered(flat)).toBe(flat)
    const afterPara = '正文段落\n* a'
    expect(nestBulletsUnderOrdered(afterPara)).toBe(afterPara)
    const afterHeading = '1. a\n## 标题\n* b'
    expect(nestBulletsUnderOrdered(afterHeading)).toBe(afterHeading)
  })

  it('主题分割线（- - - / * * *）不算无序项', () => {
    const src = '1. a\n- - -\n* * *'
    expect(nestBulletsUnderOrdered(src)).toBe(src)
  })

  it('已带缩进的无序项不动（本就嵌套）', () => {
    const src = '1. a\n   * b\n   * c'
    expect(nestBulletsUnderOrdered(src)).toBe(src)
  })
})

describe('nestBulletsUnderOrdered + headless 管线（渲染为嵌套列表）', () => {
  it('用户实测内容经 parse 产出 ordered_list > list_item > bullet_list，顶层无平级 bullet_list', async () => {
    const { getHeadless } = await import('@markflow/shared/headless')
    const { parse } = await getHeadless()
    const doc = parse(REPORTED + '\n')
    let nested = false
    let topLevelBullet = false
    doc.forEach((node) => {
      if (node.type.name === 'bullet_list') topLevelBullet = true
      if (node.type.name === 'ordered_list') {
        node.forEach((item) => {
          item.forEach((child) => {
            if (child.type.name === 'bullet_list') nested = true
          })
        })
      }
    })
    expect(nested).toBe(true)
    expect(topLevelBullet).toBe(false)
  })
})
