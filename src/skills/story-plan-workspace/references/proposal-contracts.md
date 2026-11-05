# 规划提案输出契约

所有阶段输出纯 JSON，不使用 Markdown 代码块。外层统一：

```json
{
  "stage": "seed",
  "baseRevision": "rev-20261103-1420",
  "payload": {},
  "warnings": []
}
```

- `stage` 必须与请求阶段一致。
- `baseRevision` 必须回传请求中的值；缺失时服务层拒绝落库。
- `payload` 为阶段对象，字段见下。
- `warnings` 为字符串数组，没有也要返回空数组。

## A1 seed → SeedProposal

```json
{
  "titles": ["书名一", "书名二"],
  "genre": "都市异能",
  "premise": "一句话梗概",
  "synopsis": "200 字内简介",
  "coreConflict": "谁和谁在争什么，为什么好看或好笑（代价可选，不是必需）",
  "characters": [
    { "name": "主角名", "role": "主角", "desire": "欲望", "obstacle": "阻碍", "flaw": "缺陷" }
  ],
  "worldAnchors": ["只列驱动剧情的铁律"],
  "sellingPoints": ["可复用爽点/看点"],
  "tone": "基调",
  "audience": "目标读者"
}
```

约束：`titles` 1-3 个；用户已给书名时只返回该书名；`characters` 3-6 个且必须含主角；`worldAnchors` 3-5 条；`sellingPoints` 3-5 条。

## A1+ seed-assist → SeedAssistProposal

只补全或重规划作者指定的一个线索块，不生成其他块。外层 `stage` 为 `seed-assist`，`payload` 结构：

```json
{
  "field": "premise",
  "suggestions": ["第 1 条完整建议", "第 2 条完整建议"],
  "items": [
    {
      "text": "与 suggestions 对应、可直接填入该字段的完整文本",
      "axis": "候选轴，如轻喜剧、关系流、悬疑感",
      "scene": "一个能发生且可重复的具体场面",
      "functionPositions": ["可选：该候选命中的功能位"],
      "whyItWorks": "可核对的机制或固定场面，不写空泛评价",
      "risks": ["与已填线索的冲突或风险"]
    }
  ],
  "reason": "一句话说明取舍",
  "warnings": ["只在确有冲突或需要作者决策时填写"]
}
```

约束：`field` 原样回传请求字段；`suggestions` 1-5 条，与 `items[].text` 一一对应且顺序一致；每条 `item` 必须有 `text`、`axis`、`scene`；只生成目标字段的候选，不越界补全其他设定；作者已填事实优先，冲突写入 `warnings`。

## A2 master → MasterPlanProposal

```json
{
  "masterOutline": "300-600 字全书主线",
  "volumes": [
    {
      "title": "卷名",
      "summary": "80-150 字卷纲",
      "goal": "本卷核心目标",
      "climax": "卷末高潮",
      "endingHook": "指向下一卷的钩子",
      "estimatedChapters": 12,
      "targetWordCount": 36000
    }
  ]
}
```

约束：`volumes` 1-8 卷；每卷字段必填；`estimatedChapters` 为正整数；`targetWordCount` 为正整数；不出现章级事件。

## A3 volume-chapters → VolumeChaptersProposal

```json
{
  "volumeIndex": 0,
  "chapters": [
    {
      "title": "雨夜来客",
      "hooks": ["发生什么", "推进什么", "留下什么"],
      "conflict": "本章核心冲突",
      "turn": "转折/爽点/信息揭示",
      "payoff": "本章落点",
      "endingType": "画面/动作/台词/信息/未完成动作/误会",
      "targetWordCount": 3000
    }
  ]
}
```

约束：`volumeIndex` 从 0 开始；`chapters` 非空；`hooks` 1-3 条且每条为非空字符串；`targetWordCount` 500-20000；章名不带“第 X 章”前缀；同卷章名不得重复。

## A4 chapter-detail → ChapterDetailProposal

```json
{
  "summary": "1-3 句本章摘要",
  "hooks": ["可执行事件一", "可执行事件二", "可执行事件三"],
  "targetWordCount": 3000,
  "continuityNotes": ["承接上一章 X；为下一章留 Y"]
}
```

约束：`hooks` 3-6 条；`continuityNotes` 必须返回数组（可为空）；已写正文的章不得生成。

## A5 review → OutlineReview

```json
{
  "score": 78,
  "issues": [
    {
      "id": "pacing-003",
      "severity": "warning",
      "type": "pacing",
      "volumeOrder": 0,
      "chapterOrder": 4,
      "title": "连续三章低强度",
      "description": "问题说明",
      "suggestion": "修改建议",
      "patch": { "summary": "可选摘要补丁", "hooks": ["可选 hooks 补丁"] }
    }
  ],
  "summary": "总体结论"
}
```

约束：`score` 0-100；`severity` 只能是 `blocking` / `warning` / `info`；`type` 只能是 `pacing` / `logic` / `motivation` / `repetition` / `setup-payoff` / `hook-density` / `volume-escalation` / `chapter-closure` / `serial-unit` / `relationship-state`；`patch` 只能指向未写章；已写章不得出现在补丁中。

## A6 calibrate → RecalibrateDiff

```json
{
  "diffs": [
    {
      "chapterId": "chapter-id",
      "chapterOrder": 7,
      "title": "章名",
      "oldHooks": ["旧走向"],
      "newHooks": ["新走向"],
      "reason": "为什么要改",
      "rippleEffects": ["对前后章/伏笔/角色的影响"]
    }
  ]
}
```

约束：`diffs` 只能包含未写章；`oldHooks` / `newHooks` 均为字符串数组；已写章条目在解析阶段直接丢弃；不得修改书名、简介、主线与卷纲。

## import-outline → OutlineDocument

```json
{
  "masterOutline": "从正文反推的主线",
  "volumes": [
    {
      "title": "卷名",
      "summary": "卷纲",
      "chapters": [
        { "title": "章名", "summary": "章摘要", "hooks": ["钩子"] }
      ]
    }
  ]
}
```

约束：只读已写章，不修改正文；缺失信息写入外层 `warnings`；章节顺序与正文一致。

## warnings 写法

- 一条 warning 只写一个缺口或假设，避免“信息不足”这类空话。
- 格式建议：`【假设】...`、`【缺口】...`、`【冲突】...`、`【风险】...`。
- 用户已明确的禁忌不得写成 warning 后再违反。
