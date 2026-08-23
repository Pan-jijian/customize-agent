/**
 * 内置默认基准种子脚本（manual）：把项目随附的三份优秀入围施组 PDF
 * 导入模板参考库并提取质量画像，作为首批对标基准。
 * 用法：cd apps/server && npx tsx _seed-template-references.manual.ts
 */
import * as path from 'node:path';
import { addTemplateReference, listTemplateReferences } from './src/services/document-workflow/templateReferenceService';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const SEEDS = [
  { file: '安徽创江建筑有限责任公司+裕安区公共卫生应急和服务能力提升工程（六安市裕安区苏埠镇中心卫生院医疗业务用房及配套建设工程 (1)(1).pdf', type: '房建' as const },
  { file: '安徽庆宇-合经区南区老旧小区改造提升建设.pdf', type: '市政' as const },
  { file: '香馨+新桥智能制造产业园及基础设施配套项.pdf', type: '房建' as const },
];

async function main() {
  const existing = listTemplateReferences();
  for (const seed of SEEDS) {
    if (existing.some(item => item.fileName.includes(seed.file.split('.')[0].slice(0, 12)))) {
      console.log(`[skip] 已存在：${seed.file}`);
      continue;
    }
    const filePath = path.join(PROJECT_ROOT, seed.file);
    console.log(`[seed] ${seed.file} (${seed.type})`);
    const record = await addTemplateReference({ tempFilePath: filePath, fileName: seed.file, projectType: seed.type });
    const profile = record.qualityProfile;
    console.log(`  -> status=${record.status} id=${record.id}`);
    if (profile) {
      console.log(`  -> 字数=${profile.wordCount} 参数密度=${profile.paramDensity.toFixed(2)}/千字 工序链覆盖率=${(profile.arrowChainCoverage * 100).toFixed(1)}% 重复率=${(profile.duplicationRate * 100).toFixed(1)}% 表格=${profile.tableCount} 章节=${profile.sectionCount} 小节=${profile.subsectionCount}`);
    } else if (record.errorMessage) {
      console.log(`  -> 失败原因：${record.errorMessage}`);
    }
  }
  const total = listTemplateReferences();
  console.log(`\n参考库现有 ${total.length} 份：`);
  for (const item of total) console.log(`  [${item.projectType}] ${item.fileName} (${item.status}${item.isPrimary ? ', 主参考' : ''})`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
