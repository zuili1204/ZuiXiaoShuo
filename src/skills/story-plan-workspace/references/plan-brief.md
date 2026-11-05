# PlanBrief 字段语义

`PlanBrief` 是规划页的用户输入快照，不是最终设定。AI 只补空缺，不改已填。

## 字段

| 字段 | 类型 | 含义 | 缺失时 |
|---|---|---|---|
| `title` | string | 书名 | 给 3 个备选 |
| `genre` | string[] | 题材/标签 | 按简介推断，写入 warnings |
| `platform` | string | 目标平台 | 不推断，留空 |
| `oneLiner` | string | 一句话卖点 | 从简介提炼 |
| `synopsis` | string | 故事梗概 | 生成 200 字内简介 |
| `characters` | string | 主要角色，多行 | 生成 3-6 个核心角色 |
| `worldNotes` | string | 世界观/力量体系笔记 | 只补驱动剧情的 3-5 条锚点 |
| `targetVolumes` | number | 期望卷数 | 按题材给默认值并标注 |
| `targetChapters` | number | 期望总章数 | 按卷数 × 默认章数估算 |
| `chapterWordCount` | number | 单章目标字数 | 按平台默认 2500-3000 |
| `audience` | string | 目标读者 | 从题材/平台推断 |
| `tone` | string | 基调 | 从简介推断 |
| `mustHave` | string[] | 必有元素 | 不补，视为硬约束 |
| `avoid` | string[] | 禁止元素 | 不补，视为硬约束 |
| `extraNotes` | string | 补充说明 | 忽略 |

## 处理顺序

1. 用户表单值。
2. 小说表已有的书名、简介、题材、平台。
3. 模板示例信息。
4. AI 提案（仅缺失项）。

## 澄清问题

- 只问影响主线成立的问题，例如“主角的核心欲望是什么”“反派与主角的冲突是什么”。
- 最多 3 个；超过 3 个说明输入缺口过大，应输出最小可行立项而不是继续追问。
- 已经在表单或小说表里的信息不得再问。

## 用户事实保护

- `mustHave`、`avoid`、已填角色、已填禁忌：原样保留，不缩写、不换词、不改人设。
- 书名已填：`titles` 只返回该书名，不提供备选。
- 简介已填：`synopsis` 保留原意，只修病句；重大改写必须写入 warnings 并等待确认。
- 事实冲突：保留原文，在 warnings 列出冲突点，不擅自选一个。
