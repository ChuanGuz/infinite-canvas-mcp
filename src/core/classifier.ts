import { CATEGORY_ORDER, LearningInputSchema } from '../types/schema.js';
import type { LearningInput, NodeCategory } from '../types/schema.js';

// Explainable, local EN/ZH rules. An explicit category always wins; labels alone
// never prove a practice was validated in the project.
const RULES: Record<NodeCategory, RegExp[]> = {
  convention_practice: [
    /\b(conventions?|coding standards?|workflow|naming|must|shall|always|never|agreed?|guidelines?)\b/iu,
    /约定|规范|必须|禁止|统一|工作流|提交规则|命名/iu,
  ],
  architecture_design: [
    /\b(architecture|architectural|schema|data model|boundar(?:y|ies)|layer(?:ed|ing|s)?|trade-?offs?|dependency inversion|event.driven|technology selection)\b/iu,
    /架构|分层|数据模型|数据结构|模块边界|技术选型|解耦/iu,
  ],
  feature_impl: [
    /\b(implement(?:ed|ation)?|endpoint|component|feature|add(?:ed)?|route|parser|pagination|export|upload)\b/iu,
    /实现|功能|接口|组件|新增|导出|分页|上传/iu,
  ],
  pitfall_fix: [
    /\b(bugs?|fix(?:ed|es)?|pitfalls?|root cause|race condition|deadlock|regression|workaround|crash|leak|ENOENT)\b/iu,
    /踩坑|修复|根因|故障|死锁|竞态|报错|陷阱|内存泄漏/iu,
  ],
  best_practice: [
    /\b(best practice|proven|battle.tested|validated|verified|production.tested|reusable pattern)\b/iu,
    /最佳实践|验证有效|经过验证|已验证|实践检验|黄金用法|可复用模式/iu,
  ],
};

export function uniqueText(items: string[]): string[] {
  const seen = new Set<string>();
  return items.map(s => s.trim()).filter(s => {
    const key = s.toLocaleLowerCase().replace(/\s+/gu, ' ');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function extractSummaryBullets(content: string, limit = 6): string[] {
  // Extract rather than invent claims. Full original content is always preserved.
  const prose = content.replace(/```[\s\S]*?```/gu, '');
  const sentences = prose.split(/\r?\n|(?<=[。！？!?])\s*|(?<=\.)\s+(?=[A-Z\p{Script=Han}])/u)
    .map(s => s.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s*)/u, '').trim());
  const bullets = uniqueText(sentences).slice(0, limit).map(s => s.length > 300 ? `${s.slice(0, 297)}…` : s);
  return bullets.length ? bullets : [content.trim().slice(0, 300)];
}

export interface ClassificationResult {
  category: NodeCategory;
  summaryBullets: string[];
  reusablePatterns: string[];
  scores: Record<NodeCategory, number>;
  reason: string;
}

export function classifyLearning(input: LearningInput): ClassificationResult {
  const item = LearningInputSchema.parse(input);
  const scores = Object.fromEntries(CATEGORY_ORDER.map(category => {
    const score = RULES[category].reduce((total, rule) => total +
      (rule.test(item.title) ? 5 : 0) + (rule.test(item.content) ? 2 : 0) +
      (rule.test(item.tags.join(' ')) ? 7 : 0), 0) + (item.tags.includes(category) ? 20 : 0);
    return [category, score];
  })) as Record<NodeCategory, number>;
  // Specific corrective/validated intent wins ties over generic implementation words.
  const priority: NodeCategory[] = ['pitfall_fix', 'best_practice', 'convention_practice', 'architecture_design', 'feature_impl'];
  const ranked = [...priority].sort((a, b) => scores[b] - scores[a]);
  const winner = ranked[0]!;
  const category = item.category ?? (scores[winner] ? winner : 'feature_impl');
  const summaryBullets = extractSummaryBullets(item.content);
  const reusablePatterns = summaryBullets.filter(s =>
    /\b(always|never|must|prefer|use|avoid|reuse|pattern|validate|atomic|idempoten\w*)\b|应当|必须|统一|优先|使用|避免|复用|模式|原子|幂等/iu.test(s));
  if (!reusablePatterns.length && ['convention_practice', 'architecture_design', 'best_practice'].includes(category))
    reusablePatterns.push(...summaryBullets.slice(0, 2));
  return { category, summaryBullets, reusablePatterns, scores,
    reason: item.category ? '按指定分类记录' : scores[winner] ? '根据标题、标签与内容综合分类' : '默认归入功能实现' };
}
