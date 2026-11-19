import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { CanvasEngine } from '../src/core/engine.js';
import { classifyLearning, extractSummaryBullets } from '../src/core/classifier.js';
import { layoutCanvas, STAGE_SPACING } from '../src/core/layout.js';
import { atomicWriteFile } from '../src/core/storage.js';
import { CATEGORY_ORDER, CanvasGroupSchema, CanvasSchema, CanvasNodeSchema, CanvasEdgeSchema,
  CategoryClusterSchema, CrossProjectExperienceSchema, FinalDistillationZoneSchema,
  HandoffPackageSchema, NodeCategorySchema, StageZoneSchema, StoreSchema } from '../src/types/schema.js';
import type { Bounds, Canvas, LearningInput, NodeCategory } from '../src/types/schema.js';

function setup(t: TestContext, seedDemo = false) {
  const dataDir = mkdtempSync(join(tmpdir(), 'infinite-canvas-test-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const engine = new CanvasEngine({ dataDir, seedDemo });
  return { engine, dataDir };
}
function project(t: TestContext) {
  const fixture = setup(t);
  const group = fixture.engine.createGroup({ name: 'Engineering', description: 'Shared engineering knowledge' });
  const canvas = fixture.engine.createCanvas({ groupId: group.id, title: 'Knowledge service', projectKey: 'knowledge', description: 'Preserve decisions across AI sessions' });
  return { ...fixture, group, canvas };
}
function inside(inner: Bounds, outer: Bounds) {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}
function overlaps(a: Bounds, b: Bounds) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}
function assertLayout(canvas: Canvas) {
  for (let i = 0; i < canvas.nodes.length; i++) {
    const node = canvas.nodes[i]!;
    assert.ok(Object.values(node.bounds).every(Number.isFinite));
    assert.ok(node.bounds.width > 0 && node.bounds.height > 0);
    for (const other of canvas.nodes.slice(i + 1)) assert.equal(overlaps(node.bounds, other.bounds), false, `${node.title} overlaps ${other.title}`);
    if (node.zone === 'stage') {
      const stage = canvas.stages.find(s => s.stageNumber === node.stageNumber)!;
      assert.ok(inside(node.bounds, stage.clusters[node.category].bounds));
      assert.ok(inside(node.bounds, stage.bounds));
    } else assert.ok(inside(node.bounds, canvas.finalZone!.bounds));
  }
  for (const stage of canvas.stages) {
    assert.equal(stage.bounds.x, (stage.stageNumber - 1) * STAGE_SPACING);
    let bottom = 0;
    for (const category of CATEGORY_ORDER) {
      const bounds = stage.clusters[category].bounds;
      assert.ok(bounds.y >= bottom);
      assert.ok(inside(bounds, stage.bounds));
      bottom = bounds.y + bounds.height;
    }
  }
}

test('English and Chinese classification covers all five categories, tags, explicit overrides, and fallback', async t => {
  const cases: [LearningInput, NodeCategory][] = [
    [{ title: 'Add pagination', content: 'Implemented cursor pagination for the export endpoint.' }, 'feature_impl'],
    [{ title: 'Coding conventions', content: 'Always use strict TypeScript. Never commit secrets.' }, 'convention_practice'],
    [{ title: 'Layered architecture', content: 'Define data models and module boundaries.' }, 'architecture_design'],
    [{ title: 'Fix a race condition', content: 'The root cause was concurrent replacement of the cache.' }, 'pitfall_fix'],
    [{ title: 'Proven recovery pattern', content: 'This best practice was verified during recovery drills.' }, 'best_practice'],
    [{ title: '新增导出功能', content: '实现分页导出接口和上传组件。' }, 'feature_impl'],
    [{ title: '统一命名规范', content: '必须遵守提交约定。禁止绕过工作流。' }, 'convention_practice'],
    [{ title: '分层架构', content: '定义数据模型和模块边界，减少耦合。' }, 'architecture_design'],
    [{ title: '修复并发故障', content: '定位竞态根因，记录踩坑经验。' }, 'pitfall_fix'],
    [{ title: '经过验证的最佳实践', content: '实践检验证明此可复用模式有效。' }, 'best_practice'],
    [{ title: 'Decision', content: 'Use one service boundary.', tags: ['architecture_design'] }, 'architecture_design'],
    [{ title: 'Bug fix', content: 'Root cause and workaround.', category: 'convention_practice' }, 'convention_practice'],
    [{ title: 'Observation', content: 'A neutral observation.' }, 'feature_impl'],
    [{ title: 'Prefix-safe matching', content: 'The fixture was prefixed yesterday.' }, 'feature_impl'],
  ];
  for (const [input, expected] of cases) await t.test(input.title, () => {
    const actual = classifyLearning(input);
    assert.equal(actual.category, expected);
    assert.ok(actual.summaryBullets.length);
  });
  assert.throws(() => classifyLearning({ title: '', content: 'text' }));
  assert.throws(() => classifyLearning({ title: 'x', content: 'text', category: 'invalid' as NodeCategory }));
});

test('summary extraction deduplicates bullets, handles Chinese sentences and extracts reusable candidates', () => {
  const result = classifyLearning({ title: 'Agreed persistence convention', content: '- Use atomic replacement.\n- Use atomic replacement.\n- Validate before writing.\n```ts\nthrow new Error();\n```' });
  assert.deepEqual(result.summaryBullets, ['Use atomic replacement.', 'Validate before writing.']);
  assert.deepEqual(result.reusablePatterns, result.summaryBullets);
  assert.deepEqual(extractSummaryBullets('必须验证输入。避免部分写入！'), ['必须验证输入。', '避免部分写入！']);
  assert.ok(extractSummaryBullets('```ts\nconst a = 1;\n```').length);
  assert.ok(extractSummaryBullets('x'.repeat(600))[0]!.length <= 300);
});

test('multi-group management validates input, persists updates, and isolates returned snapshots', t => {
  const { engine, dataDir, group } = project(t);
  const other = engine.createGroup({ name: 'Platform', color: '#10b981', icon: 'layers' });
  assert.equal(engine.listGroups().length, 2);
  engine.updateGroup(group.id, { name: 'AI Engineering', description: 'Updated context' });
  assert.equal(engine.listGroups().find(g => g.id === group.id)!.icon, group.icon);
  assert.match(engine.getHandoffContext().markdown, /AI Engineering/);
  other.name = 'external mutation';
  assert.equal(engine.listGroups()[1]!.name, 'Platform');
  assert.throws(() => engine.createGroup({ name: ' ' }));
  assert.throws(() => engine.updateGroup('missing', { name: 'x' }), /Group not found/);
  assert.equal(new CanvasEngine({ dataDir }).listGroups()[0]!.name, 'AI Engineering');
});

test('multi-canvas creation, filtering, selection, unique project keys, and restart selection', t => {
  const { engine, dataDir, group, canvas } = project(t);
  const otherGroup = engine.createGroup({ name: 'Other' });
  const next = engine.createCanvas({ groupId: otherGroup.id, title: 'Next project', projectKey: 'next' });
  assert.equal(engine.getCanvas().id, next.id);
  assert.equal(engine.listCanvases(group.id).length, 1);
  engine.switchCanvas(canvas.id);
  assert.equal(new CanvasEngine({ dataDir }).getCanvas().id, canvas.id);
  const detached = engine.getCanvas();
  detached.title = 'mutated';
  assert.equal(engine.getCanvas().title, canvas.title);
  assert.throws(() => engine.createCanvas({ groupId: group.id, title: 'Duplicate', projectKey: 'KNOWLEDGE' }), /already exists/);
  assert.throws(() => engine.createCanvas({ groupId: 'missing', title: 'No group', projectKey: 'missing' }), /Group not found/);
  assert.throws(() => engine.switchCanvas('missing'), /Canvas not found/);
});

test('recordLearning classifies, places, preserves metadata, and merges exact duplicates without losing evidence', t => {
  const { engine } = project(t);
  const input: LearningInput = { title: 'Fix storage race condition', content: 'Use one writer lock to prevent concurrent replacement.', tags: ['storage'], relatedFiles: ['src/store.ts'], importance: 5 };
  const node = engine.recordLearning(input);
  assert.equal(node.category, 'pitfall_fix');
  const again = engine.recordLearning({ ...input, tags: ['atomic'], relatedFiles: ['tests/store.test.ts'], validated: true });
  assert.equal(again.id, node.id);
  assert.deepEqual(again.tags, ['storage', 'atomic']);
  assert.equal(again.relatedFiles.length, 2);
  assert.equal(again.validated, true);
  assert.equal(engine.getCanvas().nodes.length, 1);
  assert.deepEqual(engine.getCanvas().stages[0]!.clusters.pitfall_fix.nodeIds, [node.id]);
  assertLayout(engine.getCanvas());
  assert.throws(() => engine.recordLearning({ title: 'Invalid', content: ' ', importance: 8 }));
});

test('layout keeps dense, variable-height cards inside ordered category containers with no overlap', t => {
  const { engine } = project(t);
  for (let stage = 1; stage <= 3; stage++) {
    for (const category of CATEGORY_ORDER) for (let i = 0; i < 5; i++) engine.recordLearning({
      title: `${category} card ${i}`, content: `Use ${'durable project evidence '.repeat(i * 6 + 1)}.\nPreserve record ${i}.`, category,
    });
    if (stage < 3) engine.advanceStage();
  }
  const canvas = engine.getCanvas();
  assertLayout(canvas);
  assert.deepEqual(layoutCanvas(structuredClone(canvas)), canvas, 'Reflow must be deterministic');
});

test('checkpoint covers every category, preserves sources, is idempotent, and creates evolution edges', t => {
  const { engine } = project(t);
  for (const category of CATEGORY_ORDER) engine.recordLearning({ title: category, content: `Use ${category} evidence.`, category, validated: true });
  const originalIds = engine.getCanvas().nodes.map(n => n.id);
  const first = engine.consolidateStage();
  assert.equal(first.status, 'consolidated');
  assert.ok(first.consolidatedAt);
  assert.equal(engine.getCanvas().nodes.filter(n => n.kind === 'stage_summary').length, 5);
  for (const source of originalIds) assert.ok(engine.getCanvas().edges.some(e => e.source === source && e.type === 'summarizes'));
  const checkpoint = engine.getCanvas();
  engine.consolidateStage();
  assert.deepEqual(engine.getCanvas(), checkpoint);
  assert.throws(() => engine.recordLearning({ title: 'Too late', content: 'Record after checkpoint.' }), /advance/);
  engine.advanceStage(undefined, 'Follow-up');
  engine.recordLearning({ title: 'Feature two', content: 'Implemented another endpoint.', category: 'feature_impl' });
  const second = engine.consolidateStage(undefined, { advanceToNextStage: true, nextStageTitle: 'Acceptance' });
  const canvas = engine.getCanvas();
  assert.equal(second.stageNumber, 2);
  assert.equal(canvas.currentStageNumber, 3);
  assert.equal(canvas.stages[2]!.status, 'in_progress');
  assert.equal(canvas.stages[2]!.title, 'Acceptance');
  assert.equal(canvas.edges.filter(e => e.type === 'evolution').length, 6);
  assert.ok(originalIds.every(id => canvas.nodes.some(n => n.id === id)));
  assertLayout(canvas);
});

test('explicit stage advancement automatically checkpoints and supports empty stages', t => {
  const { engine } = project(t);
  engine.advanceStage();
  assert.equal(engine.getCanvas().stages[0]!.status, 'consolidated');
  assert.match(engine.getCanvas().stages[0]!.summary, /No learning/);
  const before = engine.getCanvas();
  assert.throws(() => engine.advanceStage(undefined, ' '));
  assert.deepEqual(engine.getCanvas(), before);
});

test('final distillation synthesizes validated findings, excludes unsafe candidates, and publishes idempotently', t => {
  const { engine } = project(t);
  const candidates = CATEGORY_ORDER.map(category => engine.recordLearning({ title: `Validated ${category}`, content: `Use the proven ${category} approach.`, category, validated: true, importance: 5 }));
  const unvalidated = engine.recordLearning({ title: 'Best practice label is not proof', content: 'Speculative approach.', category: 'best_practice', importance: 5 });
  const unresolved = engine.recordLearning({ title: 'Pending decision', content: 'Needs confirmation.', category: 'architecture_design', importance: 5, validated: true, status: 'open' });
  const superseded = engine.recordLearning({ title: 'Old convention', content: 'Obsolete approach.', category: 'convention_practice', validated: true, status: 'superseded' });
  engine.advanceStage();
  engine.recordLearning({ title: 'Validated convention_practice', content: 'Use the proven convention_practice approach.', category: 'convention_practice', validated: true, importance: 5 });
  const final = engine.finalizeProjectDistillation();
  const canvas = engine.getCanvas();
  assert.equal(canvas.status, 'completed');
  assert.equal(final.confirmedPractices.length, 2);
  assert.equal(final.coreImplementations.length, 2);
  assert.equal(final.reusablePatterns.length, 5, 'Identical findings across stages merge');
  assert.ok(final.bounds.x > canvas.stages.at(-1)!.bounds.x + canvas.stages.at(-1)!.bounds.width);
  assert.equal(canvas.nodes.filter(n => n.kind === 'distillation').length, 4);
  for (const candidate of candidates) assert.ok(canvas.edges.some(e => e.source === candidate.id && e.type === 'distills'));
  for (const excluded of [unvalidated, unresolved, superseded]) assert.ok(!canvas.edges.some(e => e.source === excluded.id && e.type === 'distills'));
  assertLayout(canvas);
  engine.finalizeProjectDistillation();
  assert.deepEqual(engine.getCanvas(), canvas);
  assert.equal(engine.queryCrossProjectExperiences().length, 5);
  assert.throws(() => engine.advanceStage(), /completed/);
  assert.throws(() => engine.recordLearning({ title: 'x', content: 'y' }), /completed/);
});

test('review can resolve open items, supersede conventions, and explicitly validate final candidates', t => {
  const { engine } = project(t);
  const open = engine.recordLearning({ title: 'Decision', content: 'Use a reviewed boundary.', category: 'architecture_design', status: 'open', importance: 5 });
  engine.updateLearning(open.id, { status: 'active', validated: true });
  assert.equal(engine.getHandoffContext().openItems.length, 0);
  const old = engine.recordLearning({ title: 'Old rule', content: 'Use old conventions.', category: 'convention_practice', validated: true });
  engine.updateLearning(old.id, { status: 'superseded' });
  assert.equal(engine.getHandoffContext().conventions.length, 0);
  const reviewed = engine.recordLearning({ title: 'New rule', content: 'Use current conventions.', category: 'convention_practice' });
  assert.throws(() => engine.finalizeProjectDistillation(undefined, { validatedNodeIds: [reviewed.id, 'missing'] }), /Cannot validate/);
  assert.equal(engine.getCanvas().nodes.find(n => n.id === reviewed.id)!.validated, false, 'Failed transaction must roll back all validation');
  engine.finalizeProjectDistillation(undefined, { validatedNodeIds: [reviewed.id] });
  assert.equal(engine.queryCrossProjectExperiences().length, 2);
});

test('an empty project can finalize without inventing reusable practices', t => {
  const { engine } = project(t);
  const final = engine.finalizeProjectDistillation();
  assert.deepEqual(final.reusablePatterns, []);
  assert.deepEqual(final.confirmedPractices, []);
  assert.equal(engine.getCanvas().status, 'completed');
  assertLayout(engine.getCanvas());
});

test('handoff provides complete history, current context, unresolved work, source files, and synchronized Markdown', t => {
  const { engine, dataDir, canvas } = project(t);
  engine.recordLearning({ title: 'Agreed workflow', content: 'Always run tests before checkpoints.', category: 'convention_practice', relatedFiles: ['package.json'], validated: true });
  engine.advanceStage();
  engine.recordLearning({ title: 'Pending keyboard test', content: 'TODO: validate keyboard focus navigation.', status: 'open', tags: ['accessibility'] });
  const handoff = engine.getHandoffContext();
  HandoffPackageSchema.parse(handoff);
  assert.equal(handoff.stages.length, 2);
  assert.equal(handoff.currentStage.stageNumber, 2);
  assert.equal(handoff.conventions.length, 1);
  assert.equal(handoff.openItems.length, 1);
  assert.equal(handoff.nodes.length, engine.getCanvas().nodes.length);
  assert.match(handoff.markdown, /package\.json/);
  assert.match(handoff.markdown, /TODO: validate keyboard focus navigation/);
  assert.match(handoff.markdown, /Preserve decisions across AI sessions/);
  assert.ok(handoff.nextSteps.some(s => s.includes('Pending keyboard test')));
  const file = join(dataDir, 'handoffs', `HANDOFF-${canvas.id}.md`);
  assert.equal(readFileSync(file, 'utf8'), handoff.markdown);
  writeFileSync(file, 'interrupted stale mirror');
  const restarted = new CanvasEngine({ dataDir });
  assert.equal(readFileSync(file, 'utf8'), restarted.getHandoffContext().markdown);
  rmSync(file);
  new CanvasEngine({ dataDir });
  assert.equal(readFileSync(file, 'utf8'), handoff.markdown);
});

test('cross-project search filters keywords/category/tags, imports with provenance, and requires target validation', t => {
  const { engine, group, canvas } = project(t);
  engine.recordLearning({ title: 'Atomic persistence', content: 'Use atomic replacement for local JSON state.', category: 'best_practice', tags: ['Storage', 'atomic'], relatedFiles: ['source-only.ts'], validated: true });
  engine.recordLearning({ title: 'Service architecture', content: 'Separate transport from domain boundaries.', category: 'architecture_design', tags: ['architecture'], validated: true, importance: 5 });
  engine.finalizeProjectDistillation();
  assert.equal(engine.queryCrossProjectExperiences({ query: 'atomic JSON', tags: ['storage'], category: 'best_practice' }).length, 1);
  assert.equal(engine.queryCrossProjectExperiences({ query: 'absent' }).length, 0);
  assert.equal(engine.queryCrossProjectExperiences({ tags: ['unknown'] }).length, 0);
  assert.equal(engine.queryCrossProjectExperiences({ excludeCanvasId: canvas.id }).length, 0);
  assert.equal(engine.queryCrossProjectExperiences({ limit: 1 }).length, 1);
  assert.throws(() => engine.queryCrossProjectExperiences({ limit: -1 }));
  const target = engine.createCanvas({ groupId: group.id, title: 'Successor', projectKey: 'successor' });
  const experience = engine.queryCrossProjectExperiences({ query: 'atomic' })[0]!;
  const imported = engine.applyExperienceToCanvas(experience.id);
  assert.equal(imported.category, 'convention_practice');
  assert.equal(imported.sourceExperienceId, experience.id);
  assert.equal(imported.validated, false);
  assert.deepEqual(imported.relatedFiles, [], 'Source files must not masquerade as target project files');
  assert.equal(engine.applyExperienceToCanvas(experience.id).id, imported.id);
  assert.deepEqual(engine.queryCrossProjectExperiences({ query: 'atomic' })[0]!.appliedCanvasIds, [target.id]);
  const architecture = engine.queryCrossProjectExperiences({ category: 'architecture_design' })[0]!;
  assert.equal(engine.applyExperienceToCanvas(architecture.id).category, 'architecture_design');
  assert.equal(engine.getHandoffContext().appliedExperiences.length, 2);
  assert.throws(() => engine.applyExperienceToCanvas('missing'), /Experience not found/);
  engine.finalizeProjectDistillation();
  assert.equal(engine.queryCrossProjectExperiences().length, 2, 'Imported guidance must not become proof in a new project');
});

test('first boot seeds two groups, consolidated stages 1/2, active stage 3, and a finalized project only once', t => {
  const { engine, dataDir } = setup(t, true);
  assert.equal(engine.listGroups().length, 2);
  assert.equal(engine.listCanvases().length, 2);
  const active = engine.getCanvas();
  assert.equal(active.currentStageNumber, 3);
  assert.deepEqual(active.stages.map(s => s.status), ['consolidated', 'consolidated', 'in_progress']);
  assert.ok(active.nodes.length >= 20);
  const completed = engine.listCanvases().find(c => c.status === 'completed')!;
  assert.ok(completed.finalZone!.confirmedPractices.length);
  assert.ok(engine.queryCrossProjectExperiences().length >= 5);
  for (const canvas of engine.listCanvases()) {
    assertLayout(canvas);
    assert.equal(readFileSync(join(dataDir, 'handoffs', `HANDOFF-${canvas.id}.md`), 'utf8'), engine.getHandoffContext(canvas.id).markdown);
  }
  const before = readFileSync(join(dataDir, 'store.json'), 'utf8');
  new CanvasEngine({ dataDir });
  assert.equal(readFileSync(join(dataDir, 'store.json'), 'utf8'), before);
});

test('every requested domain schema validates real fixtures and rejects malformed values/references', t => {
  const { engine } = setup(t, true);
  const store = engine.storage.read();
  const canvas = store.canvases[0]!;
  CanvasGroupSchema.parse(store.groups[0]);
  CanvasSchema.parse(canvas);
  CanvasNodeSchema.parse(canvas.nodes[0]);
  CanvasEdgeSchema.parse(canvas.edges[0]);
  StageZoneSchema.parse(canvas.stages[0]);
  CategoryClusterSchema.parse(canvas.stages[0]!.clusters.feature_impl);
  CrossProjectExperienceSchema.parse(store.crossProjectExperiences[0]);
  FinalDistillationZoneSchema.parse(store.canvases[1]!.finalZone);
  HandoffPackageSchema.parse(engine.getHandoffContext());
  assert.equal(NodeCategorySchema.safeParse('decision_todo').success, false);
  assert.equal(CanvasNodeSchema.safeParse({ ...canvas.nodes[0], bounds: { x: 0, y: 0, width: -1, height: 2 } }).success, false);
  assert.equal(StageZoneSchema.safeParse({ ...canvas.stages[0], clusters: {} }).success, false);
  const dangling = structuredClone(store);
  dangling.canvases[0]!.edges[0]!.target = 'missing';
  assert.equal(StoreSchema.safeParse(dangling).success, false);
  const orphan = structuredClone(store);
  orphan.canvases[0]!.groupId = 'missing';
  assert.equal(StoreSchema.safeParse(orphan).success, false);
  const membership = structuredClone(store);
  membership.canvases[0]!.stages[0]!.clusters.convention_practice.nodeIds = [];
  assert.equal(StoreSchema.safeParse(membership).success, false);
});

test('existing empty stores remain empty; corrupt stores fail loudly and are never replaced by demo data', t => {
  const { engine, dataDir } = setup(t);
  assert.equal(new CanvasEngine({ dataDir }).listGroups().length, 0);
  assert.throws(() => engine.getCanvas(), /no active canvas/);
  writeFileSync(engine.storage.storePath, '{ corrupt');
  assert.throws(() => new CanvasEngine({ dataDir }));
  assert.equal(readFileSync(engine.storage.storePath, 'utf8'), '{ corrupt');
  writeFileSync(engine.storage.storePath, JSON.stringify({ schemaVersion: 99 }));
  assert.throws(() => new CanvasEngine({ dataDir }));
  assert.equal(readFileSync(engine.storage.storePath, 'utf8'), '{"schemaVersion":99}');
});

test('failed mutations do not change disk and multiple engine instances reload before updating', t => {
  const { engine, dataDir, canvas } = project(t);
  const other = new CanvasEngine({ dataDir });
  engine.recordLearning({ title: 'First', content: 'Implemented first component.' });
  other.recordLearning({ title: 'Second', content: 'Implemented second component.' }, canvas.id);
  assert.equal(engine.getCanvas().nodes.length, 2);
  const before = readFileSync(engine.storage.storePath, 'utf8');
  assert.throws(() => engine.storage.transaction(draft => { draft.activeCanvasId = 'invalid'; }));
  assert.equal(readFileSync(engine.storage.storePath, 'utf8'), before);
  assert.throws(() => engine.storage.transaction(draft => { draft.groups = []; throw new Error('abort'); }), /abort/);
  assert.equal(readFileSync(engine.storage.storePath, 'utf8'), before);
  assert.equal(readdirSync(dataDir).filter(name => name.endsWith('.tmp') || name.endsWith('.lock')).length, 0);
});

test('concurrent-writer lock fails safely instead of overwriting state', t => {
  const { engine, dataDir } = project(t);
  const before = readFileSync(engine.storage.storePath, 'utf8');
  const lock = join(dataDir, 'store.lock');
  writeFileSync(lock, 'another writer');
  assert.throws(() => engine.createGroup({ name: 'Blocked' }), /Store is locked/);
  assert.equal(readFileSync(engine.storage.storePath, 'utf8'), before);
  assert.equal(readFileSync(lock, 'utf8'), 'another writer');
  rmSync(lock);
  engine.createGroup({ name: 'Recovered' });
  assert.equal(engine.listGroups().length, 2);
});

test('mirror failure reports committed JSON and startup repairs the handoff after the filesystem issue is fixed', t => {
  const { engine, dataDir, canvas } = project(t);
  const mirror = join(dataDir, 'handoffs', `HANDOFF-${canvas.id}.md`);
  rmSync(mirror);
  mkdirSync(mirror); // A directory at the file path prevents handoff replacement.
  assert.throws(() => engine.recordLearning({ title: 'Committed evidence', content: 'Implemented durable recording.' }), /Store committed, but handoff synchronization failed/);
  assert.equal(engine.getCanvas().nodes.length, 1);
  rmSync(mirror, { recursive: true });
  const recovered = new CanvasEngine({ dataDir });
  assert.equal(readFileSync(mirror, 'utf8'), recovered.getHandoffContext().markdown);
  assert.match(readFileSync(mirror, 'utf8'), /Committed evidence/);
  assert.equal(readdirSync(dataDir).some(name => name.endsWith('.lock')), false);
});

test('atomic replacement failure cleans up its temporary file and leaves the original target intact', t => {
  const { dataDir } = setup(t);
  const target = join(dataDir, 'existing-directory');
  mkdirSync(target);
  writeFileSync(join(target, 'evidence.txt'), 'preserve');
  assert.throws(() => atomicWriteFile(target, 'cannot replace a directory'));
  assert.equal(readFileSync(join(target, 'evidence.txt'), 'utf8'), 'preserve');
  assert.equal(readdirSync(dataDir).some(name => name.endsWith('.tmp')), false);
});
