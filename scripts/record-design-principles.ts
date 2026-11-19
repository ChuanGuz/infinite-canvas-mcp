import { CanvasEngine } from '../src/core/engine.js';
import { CORE_CONVENTIONS, publishCoreConventions } from '../src/core/storage.js';

// Explicit, repeatable dogfooding update; never reset existing projects or identities.
const engine = new CanvasEngine({ dataDir: process.argv[2] ?? 'data' });
const canvas = engine.listCanvases().find(c => c.title === '无限画布知识工作台' && c.status === 'active');
if (!canvas) throw new Error('未找到正在进行的无限画布知识工作台');
const missing = CORE_CONVENTIONS.filter(input => !canvas.nodes.some(n =>
  n.kind === 'learning' && n.category === input.category && n.title === input.title &&
  n.content === input.content && n.validated && n.status === 'active'));
if (missing.length && canvas.stages.find(s => s.stageNumber === canvas.currentStageNumber)?.status === 'consolidated')
  engine.advanceStage(canvas.id, '交互设计与协作约定');
for (const input of missing) engine.recordLearning(input, canvas.id);
engine.storage.transaction(store => {
  publishCoreConventions(store, canvas.id);
  store.activeCanvasId = canvas.id;
});
console.log('核心设计与协作约定已同步到当前画布、跨项目经验库和交接文档。');
