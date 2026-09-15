import type { DocumentTemplateChapter } from './types';
import { formalChapterTitle } from './outline';

/**
 * 跨章写作职责分工声明（组件 6）：写作端源头确保无跨章重复——
 * 职责的载体是章节自身的规划结构（章标题 + 规划小节列表），不引入任何词表、判定器。
 * 每章写作任务注入：本章职责 + 其他章节职责 + 写作规范；作为章级恒定段随写作块下发
 *（同章各块值完全相同，prefix cache 共享命中）。
 */
export function buildCrossChapterDutyDeclaration(chapter: DocumentTemplateChapter, allChapters: DocumentTemplateChapter[]): string {
  const chapterIndex = allChapters.indexOf(chapter);
  const chapterLine = (index: number, item: DocumentTemplateChapter) => `${formalChapterTitle(index, item.title)}${item.sections?.length ? `（小节：${item.sections.join('、')}）` : ''}`;
  const others = allChapters.map((item, index) => ({ item, index })).filter(entry => entry.item !== chapter);
  return [
    '【跨章写作职责分工——只就本章主题展开，写时即不产生跨章重复】',
    `- 本章职责：${chapterLine(chapterIndex >= 0 ? chapterIndex : 0, chapter)}`,
    ...(others.length > 0 ? [
      '- 其他章节职责（不得展开复述其主题内容）：',
      ...others.map(entry => `  - ${chapterLine(entry.index, entry.item)}`),
    ] : []),
    // 4.43 篇幅诱导句清理：原「写足本章预算字数，字数不足时深化本章主题内容」为篇幅向上诱导
    //（dump 法证在案：块级膨胀的三大诱导源之一，V8 变量实验双删后 1.36→1.14x），改为合同口径
    '- 写作规范：只就本章主题展开；其他章节主题的内容如需关联，一句话引用（“详见第X章”，X 替换为实际章号），不得展开复述；篇幅以本节合同字数为准，不得借写其他章节主题充数。',
  ].join('\n');
}
