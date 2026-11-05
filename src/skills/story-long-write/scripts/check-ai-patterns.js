'use strict';
// IMP-10：本文件曾是 story-review/scripts/check-ai-patterns.js 的独立副本，但无任何运行时调用
// （electron/services/quality-checker.ts 只认 story-review 那份）。为消除"改一处不改两处"的分裂，
// 现在收敛为单一权威实现的转发层：直接 delegate。需要修改检测规则请改 story-review 那份。
module.exports = require('../../story-review/scripts/check-ai-patterns.js');
