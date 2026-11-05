import type { PlanEvalOutputs } from '@/services/planning-eval-harness'

/**
 * 管线自检样例：只用于验证“指标方向是否正确”，不是真实模型输出。
 * 真实 A/B 时在同目录放 outputs.json 覆盖这些样例。
 */
export const FIXTURE_OUTPUTS: PlanEvalOutputs = {
  'eval-seed-campus': {
    baseline: [
      { location: '梗概', text: '一个少年在校园里成长，逐渐明白友情与责任的意义。' },
      { location: '主角', text: '主角表面冷漠，内心渴望被理解，终于明白自己的价值。' },
      { location: '冲突', text: '他必须在对错之间做出选择，这是他的宿命。' },
      { location: '卖点', text: '热血、治愈、成长、群像。' },
    ],
    'prose-anchors': [
      { location: '梗概', text: '她靠补书赚五块钱一次，直到同桌把一本撕掉扉页的旧书推过来。' },
      { location: '主角', text: '她把价目表压在玻璃下，被戳穿时低头拆线，拆得满桌都是。' },
      { location: '冲突', text: '她靠补书赚钱，却不肯让人碰自己的笔记本；同桌把旧日记推过来就走。' },
      { location: '卖点', text: '一封没寄出的信被翻出来；五块钱一次的补书摊。' },
    ],
    'planning-samples': [
      { location: '梗概', text: '她把旧书推回去，说这次免费；同桌第二天又坐回原位。' },
      { location: '主角', text: '她数完零钱才发现少了两块，追到楼道只捡到一只拖鞋。' },
      { location: '冲突', text: '同桌问她“这本也要补吗？”，她把旧日记推回去，没回答。' },
      { location: '卖点', text: '她关掉台灯，锥子还捏在手里；整条走廊等她开口。' },
    ],
  },
  'eval-chapter-campus': {
    baseline: [
      { location: 'hook 1', text: '主角来到学校，开始新的一天。' },
      { location: 'hook 2', text: '主角遇见同桌，两人发生对话。' },
      { location: 'hook 3', text: '主角有所感悟，暗下决心。' },
      { location: 'hook 4', text: '故事继续发展，命运的齿轮开始转动。' },
    ],
    'prose-anchors': [
      { location: 'hook 1', text: '旧书摊窗口，她把价目表压在玻璃下：补封皮五元，补内页三元。' },
      { location: 'hook 2', text: '她拆开书脊，夹层里掉出一封没写地址的信，手上的锥子停住。' },
      { location: 'hook 3', text: '同桌把旧日记推过来就走；她翻开，第一页写着“别翻后面”。' },
      { location: 'hook 4', text: '她追到楼梯口，只捡到一只拖鞋；晚自习同桌又坐回原位。' },
    ],
    'planning-samples': [
      { location: 'hook 1', text: '第一个客人递来一本缺了扉页的词典，她把书推回去，说：“今天只补，不拆。”' },
      { location: 'hook 2', text: '拆到一半她停住，先问客人：“这封夹在里面的信，也要补吗？”' },
      { location: 'hook 3', text: '同桌把旧日记推过来就走，第一页只有一句：“别翻后面。”' },
      { location: 'hook 4', text: '她追上去，只捡到一只拖鞋。' },
      { location: 'hook 5', text: '晚自习，同桌桌上多了一瓶没开的汽水；账本上“欠一页”的后面，空着一格。' },
    ],
  },
}
