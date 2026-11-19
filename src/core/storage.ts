import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { StoreSchema } from '../types/schema.js';
import type { Store, LearningInput } from '../types/schema.js';
import { buildHandoff } from './handoff.js';

export const emptyStore = (): Store => ({
  schemaVersion: 1, activeCanvasId: null, groups: [], canvases: [], crossProjectExperiences: [],
});

/** Ignore generated identities and geometry, but require every demo content field to match. */
export function demoFingerprint(store: Store): string {
  return createHash('sha256').update(JSON.stringify(store, (key, value) =>
    /(?:Id|Ids|At)$/.test(key) || ['id', 'bounds', 'viewport', 'nodeIds', 'sourceNodeIds'].includes(key) ? undefined : value)).digest('hex');
}

const learning = (category: LearningInput['category'], title: string, content: string, tags: string[], open = false): LearningInput =>
  ({ category, title, content, tags, importance: 4, validated: !open, status: open ? 'open' : 'active' });

/** 所有示例叙述均为简体中文；协议字段与内部标识仍保持稳定。 */
export const DEMO_PROJECTS = [
  {
    group: { name: '智能工具研发', description: '沉淀研发经验，让项目知识连续传承。', color: '#2f6b55', icon: '工具' },
    title: '无限画布知识工作台', description: '按阶段记录功能、架构与约定，让不同助手接手时都能理解项目。', completed: false,
    stages: [
      { title: '基础架构与可靠存储', learnings: [
        learning('convention_practice', '严格检查与小步提交', '所有业务模块必须通过严格类型检查。每次阶段整理前运行测试，并保持改动便于审查。', ['类型检查', '提交约定']),
        learning('architecture_design', '业务引擎独立于接入方式', '分类、布局和存储放在独立业务层。网页接口与助手工具调用同一套业务逻辑。', ['架构分层', '模块边界']),
        learning('feature_impl', '原子保存项目数据', '先在同目录写入临时文件并刷新到磁盘，再整体替换旧文件。保存前校验数据，避免留下半份内容。', ['可靠存储', '原子替换']),
        learning('pitfall_fix', '修复中文文件乱码', '读写项目文件时明确使用统一的万国码编码。避免终端默认编码不同导致中文内容损坏。', ['中文编码', '环境排查']),
        learning('best_practice', '摘要保留原始依据', '阶段小结必须保留来源记录。交接时可以回到原文核对结论，避免只留下无法验证的摘要。', ['交接', '证据追溯']),
      ] },
      { title: '助手接入与实时同步', learnings: [
        learning('convention_practice', '先校验再写入', '所有工具输入必须先完成校验。画布不存在或阶段状态不允许修改时，返回清晰的中文提示。', ['输入校验', '工具约定']),
        learning('architecture_design', '共享事务存储', '网页与助手共用同一份事务存储。提交成功后再推送更新，保证看到的都是已经保存的数据。', ['事务', '实时同步']),
        learning('feature_impl', '画布切换与阶段整理', '已实现画布选择、学习记录和阶段整理。切换后继续写入当前画布，阶段成果按类别自动归拢。', ['画布切换', '阶段整理']),
        learning('pitfall_fix', '诊断日志与工具通信分离', '诊断日志写入错误输出通道。标准输出只保留协议消息，避免调试内容破坏助手通信。', ['通信', '日志排查']),
        learning('best_practice', '交接文档可以重建', '项目数据库是唯一事实来源。启动时重新生成交接文档，修复意外中断造成的文档不同步。', ['交接', '恢复']),
      ] },
      { title: '交互画布与使用验收', learnings: [
        learning('feature_impl', '画布平移与缩放', '已实现鼠标拖动平移和滚轮缩放。卡片坐标保持稳定，阶段跳转能快速定位当前工作区。', ['画布', '视口']),
        learning('feature_impl', '键盘导航验收', '待验证分类区域与终局卡片之间的键盘焦点移动。发布前确认读屏标签能够准确表达操作含义。', ['无障碍', '待办'], true),
        learning('architecture_design', '大画布性能验证', '待完成五千张卡片的性能测试，再决定是否只渲染视口附近的卡片。', ['性能', '待办'], true),
      ] },
    ],
  },
  {
    group: { name: '平台工程', description: '积累可复用的服务基础能力。', color: '#2f6c78', icon: '平台' },
    title: '可靠发布服务', description: '已完成的内部发布编排项目，沉淀经过验证的服务规范和恢复经验。', completed: true,
    stages: [
      { title: '服务约定与可靠性', learnings: [
        learning('convention_practice', '在服务入口校验输入', '每个服务入口都使用结构化规则校验输入。不合法的数据必须在进入业务逻辑前拒绝。', ['校验', '服务边界']),
        learning('architecture_design', '发布编排保持幂等', '每次发布请求使用唯一幂等标识。将输入校验、持久化状态流转与部署操作分离，避免重复执行。', ['幂等', '架构']),
        learning('feature_impl', '支持安全重试的部署队列', '任务标识持久化保存，并限制重试次数。保留最近失败原因，让中断后的部署可以恢复。', ['队列', '可靠性']),
        learning('pitfall_fix', '退避机制避免重试风暴', '重试时采用带随机偏移的递增等待时间。设置总体重试预算，避免大量任务同时冲击服务。', ['重试', '可靠性']),
      ] },
      { title: '运行验证与项目收尾', learnings: [
        learning('best_practice', '原子替换本地状态', '小型本地状态文件使用原子替换。先写入并刷新临时文件，再替换之前的完整快照。', ['存储', '原子替换', '可靠性']),
        learning('convention_practice', '推广经验前先提供证据', '可靠性方案必须通过恢复测试后才能进入共享经验库。引入新项目时仍需结合实际条件重新验证。', ['测试', '经验复用']),
      ] },
    ],
  },
];

/** Same-directory temp + fsync + rename keeps readers from seeing partial JSON. */
export function atomicWriteFile(path: string, contents: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx');
    writeFileSync(fd, contents, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export class JsonStorage {
  readonly dataDir: string;
  readonly storePath: string;
  readonly handoffDir: string;
  private readonly lockPath: string;

  constructor(dataDir = resolve('data')) {
    this.dataDir = resolve(dataDir);
    this.storePath = join(this.dataDir, 'store.json');
    this.handoffDir = join(this.dataDir, 'handoffs');
    this.lockPath = join(this.dataDir, 'store.lock');
    mkdirSync(this.dataDir, { recursive: true });
    mkdirSync(this.handoffDir, { recursive: true });
  }

  private locked<T>(operation: () => T): T {
    let fd: number;
    try { fd = openSync(this.lockPath, 'wx'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new Error('存储正在写入，请稍后重试。仅在确认没有写入进程时才能清理遗留锁。', { cause: error });
      throw error;
    }
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      return operation();
    } finally { closeSync(fd); unlinkSync(this.lockPath); }
  }

  initialize(factory: () => Store = emptyStore): void {
    this.locked(() => {
      // Only a genuinely absent store may seed; invalid JSON/schema is never overwritten.
      if (!existsSync(this.storePath)) this.commit(factory());
      else {
        const existing = this.read();
        // Only the exact untouched legacy fixture may be replaced; edited projects are preserved.
        if (factory !== emptyStore && demoFingerprint(existing) === 'a34d82645ae87e804f2747204a51ef4260989cb7a20086c1ee1c3fceace46dac') {
          const backup = join(this.dataDir, 'backups', `中文示例升级-${Date.now()}`);
          mkdirSync(backup, { recursive: true });
          atomicWriteFile(join(backup, 'store.json'), readFileSync(this.storePath, 'utf8'));
          for (const canvas of existing.canvases) {
            const name = `HANDOFF-${canvas.id}.md`;
            if (existsSync(join(this.handoffDir, name)))
              atomicWriteFile(join(backup, name), readFileSync(join(this.handoffDir, name), 'utf8'));
          }
          this.commit(factory());
          for (const canvas of existing.canvases) {
            const path = join(this.handoffDir, `HANDOFF-${canvas.id}.md`);
            if (existsSync(path)) unlinkSync(path);
          }
        } else this.syncHandoffs(existing);
      }
    });
  }

  read(): Store {
    return StoreSchema.parse(JSON.parse(readFileSync(this.storePath, 'utf8')) as unknown);
  }

  transaction<T>(mutate: (draft: Store) => T): T {
    return this.locked(() => {
      // Reload inside the lock so multiple engine instances cannot lose each other's updates.
      const draft = this.read();
      const result = mutate(draft);
      this.commit(draft);
      return structuredClone(result);
    });
  }

  syncHandoffs(store: Store): void {
    for (const canvas of store.canvases) {
      const path = join(this.handoffDir, `HANDOFF-${canvas.id}.md`);
      const markdown = buildHandoff(store, canvas).markdown;
      if (!existsSync(path) || readFileSync(path, 'utf8') !== markdown) atomicWriteFile(path, markdown);
    }
  }

  private commit(input: Store): void {
    const store = StoreSchema.parse(input);
    // Render/validate all derived documents before committing the source of truth.
    for (const canvas of store.canvases) buildHandoff(store, canvas);
    atomicWriteFile(this.storePath, `${JSON.stringify(store, null, 2)}\n`);
    try { this.syncHandoffs(store); }
    catch (error) {
      throw new Error('数据已保存，但交接文档同步失败。请重启引擎以重建文档。', { cause: error });
    }
  }
}
