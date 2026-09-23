import { DEFAULT_DOCUMENT_DOMAIN_PROFILE, factFieldForLabel, isDiagnosticFactValue, isForbiddenFactValue, type DocumentDomainProfile } from '../document-core/documentDomainProfileService';
import { rejectValueNoise } from '../document-workflow/authoritativeValues';
import { TEMPORAL_DATE_VALUE_RE, foldAdminNameAbbreviation, foldHomoglyphVariants, hasCorruptTextMarkers, isComplianceCitationValue, isTableScrapeFragment, stripFactLabelPrefix, stripTrailingFormAnnotation, temporalValueKind, valueAfterChangeConnector } from '../document-workflow/factValueNoise';
import type { DocumentFact, ValidationIssue } from '../document-workflow/types';
import type { ProjectMaterialSummary } from '../document-core/projectMaterialService';

// V5 P6 破折号族归一（run1 实测）：全角破折号（——）/半角连字符（--）/波浪线等字形不同
// 但语义相同，「…（一标）——公共广场空间改造等…」与「…（一标）--公共广场空间改造等…」
// 曾被归一为两个 key 误报「项目名称多值冲突」。
function normalize(value: string) {
  return value.replace(/[（(]\d+[）)]/gu, '').replace(/副本|最终版|扫描件|定稿/gu, '').replace(/\s+/gu, '').replace(/[，。,.;；：:《》“”‘’()（）_\-—–―─－〜～·•]/gu, '').toLowerCase();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** 名称类字段（实体名应短且纯净的字段）：多值冲突判定对其值做粘连卫生（r14 丰乐镇实测） */
const NAME_LIKE_LABEL_RE = /项目名称|工程名称|招标人|建设单位|发包人|采购人|招标单位|建设地点|工程地点|项目地点/u;
/** 表格派生来源角色（清单/图纸解析）：其「项目名称」事实实为清单条目名或单元格坐标粘连值 */
const TABLE_DERIVED_ROLE_RE = /bill_of_quantities|drawing|table/iu;

function comparableValue(value: string, profile: DocumentDomainProfile, label?: string) {
  /**
   * 4.56.3 判据单源化（本函数此前是 `factsModel.conflictComparableFactValue` 的**第二份实现**，
   * 且缺了后者已具备的全部噪声判据）。实测代价：6 条「事实一致性冲突」blocker 全出自这一族，
   * 事实维度触发归零悬崖（冲突数 ≥5 → 60% 分量归零），综合分被压到 85。
   *
   * 现与真值层共用同一批判据：
   * - `rejectValueNoise`（缺席声明/占位/OCR 复写/段落冒充值/图签串格/超长）；
   * - `hasCorruptTextMarkers`（损坏字符）；
   * - `isTableScrapeFragment`（表头词连排的单元格抓取残片）；
   * - `valueAfterChangeConnector`（**取变更连接语之后的生效值**——此前取正则首个匹配，
   *   于是「365日历天，现变更修改为:330日历天」被判成与真值 330 并列的"另一个值"）。
   */
  const noise = rejectValueNoise(value.trim());
  if (noise) return '';
  if (hasCorruptTextMarkers(value) || isTableScrapeFragment(value)) return '';
  // 指针条款（「见《专用合同条款数据表》」）是**引用**不是取值
  if (/^(?:详|参见|见|依据)\s*[《【]/u.test(value.trim())) return '';
  // 变更叙述：生效值在连接语之后（连接语之前是旧值）——必须在后续形态判定**之前**取
  const trimmed = valueAfterChangeConnector(value.trim()).trim();
  if (trimmed !== value.trim() && rejectValueNoise(trimmed)) return '';
  /**
   * 4.58 ① 合规引用句当值（实测 `doc-1790168542563-ea526b1b` 的 `计划工期`）。
   *
   * 该组三个"值"是：`330日历天`、`计划开工日期：2026年10月10日（…）`、
   * **`符合第二章“投标人须知”第1.3.2项规定`**——第三个是**引用**（指向别处的条款），不是工期取值，
   * 却因形态为 plain 打掉了时长/日期分桶（见下方 ②），把前两者拉回全量互比 → 多值冲突。
   *
   * 判据在单源模块 `isComplianceCitationValue`（形态三连：合规动词开头 + 含条款编号 + 以规定/要求收尾），
   * 此处只做转接，不复制判据。真值自检：`330日历天`/`2026年10月10日`/`框架结构` 均不满足三连，
   * `符合国家现行验收规范合格标准`（无条款编号）、`满足GB50204-2015要求`（无条款编号）同样不满足。
   */
  if (isComplianceCitationValue(trimmed)) return '';
  if (isDiagnosticFactValue(profile, trimmed) || isForbiddenFactValue(profile, trimmed)) return '';
  if (/签章|盖章|联系人|联系电话|电话|邮箱|解密|开标|评标|保证金|交易系统|空白|填写|上传|下载|递交|投标文件制作|电子服务系统|交易平台/u.test(trimmed)) return '';
  if (/\|/u.test(trimmed) || /^#+\s*/u.test(trimmed)) return '';
  if (/见(?:招标公告|投标人须知|前附表|本项目|补疑)|资料参数行摘要|公共资源交易监督管理|开评标程序|监管部门|招标代理机构|监督管理部门|行政监督部门/u.test(trimmed)) return '';
  if (/是否|符合|采购范围|规定的投标截止时间|电子交易系统|投标人须知|招标文件正文/u.test(trimmed) && /\d{3,}/u.test(trimmed)) return '';
  if (/项目名称|工程名称/u.test(trimmed) && /项目编号|工程概况|建筑面积|本项目分为|现状建筑物|改造工程|标段/u.test(trimmed)) return '';
  if (/项目编号[:：]|工程概况[:：]|本项目分为|现状建筑物|总建筑面积|本次改造工程|清单编制说明/u.test(trimmed)) return '';
  // V5 P6 label 感知过滤（run1 实测）：
  // ① 机构类字段（招标人/建设单位/发包人）值必须含机构后缀——「在会议期间澄清」
  //   「承包人：为了进一步贯彻…」等句子片段抽取垃圾值曾被报为招标人多值冲突；
  // ② 项目名称类字段排除位置提示语（「项目所在地」）与清单条目名（「抱杆机箱」「检查井」类）。
  if (label && /招标人|建设单位|发包人|采购人|招标单位/u.test(label)) {
    if (!/局|公司|中心|政府|管委会|委员会|集团|院|大学|学校|街道|办事处|指挥部|项目部|办公室|厅|署|银行|医院/u.test(trimmed)) return '';
  }
  /**
   * 4.56.6「标签当值」过滤（实测 `计划工期` 的第二个"值"是 `标段工程工期`）。
   *
   * 招标文件里工期常以**表格**呈现，「标段工程工期」是那张表的**行标题**；抽取器把它当成了取值。
   * 它没有任何信息量，却因为形态为 plain 而**打掉了时长/日期的槽位分桶**（分桶要求组内值全部可判形态），
   * 连带把「330日历天」与「开工日期」重新拉回全量互比 → 多值冲突。
   *
   * 判据（形态，不查名单）：**值不含数字、长度不超过标签+6 字、且以标签的尾部 2 字收尾** ⇒ 是标签而非取值。
   * 反例自检：label「项目名称」/value「…建设项目」不以「名称」收尾；label「建设地点」/value 地址不以
   * 「地点」收尾；label「质量标准」/value「合格」不以「标准」收尾——均不受影响。
   */
  if (label) {
    const labelNormalized = normalize(label);
    const valueNormalized = normalize(trimmed);
    if (
      labelNormalized.length >= 2
      && valueNormalized.length > 0
      && valueNormalized.length <= labelNormalized.length + 6
      && valueNormalized.endsWith(labelNormalized.slice(-2))
      && !/\d/u.test(trimmed)
    ) return '';
  }
  if (label && NAME_LIKE_LABEL_RE.test(label)) {
    if (/所在地|地址|详见|见前附表|见招标/u.test(trimmed)) return '';
    if (/检查井|化粪池|机箱|碎石|路灯|井盖|监控系统|吊顶|抹灰|楼面|顶棚/u.test(trimmed)) return '';
    // E2 标签前缀剥离（r14 丰乐镇实测）：「招标人：肥西县丰乐镇人民政府」与「肥西县丰乐镇人民政府」
    // 因字段名前缀粘连被归一为两个 key 误报多值冲突——先剥离「label[：]」前缀再比较。
    const stripped = trimmed.replace(new RegExp(`^${escapeRegExp(label)}\\s*[：:、,，.．]?\\s*`, 'u'), '');
    // 4.56.4 尾随形式括注剥离：`巢湖执珩建设投资有限公司（盖单位章）` 与裸名是同一实体的两种书写，
    // 实测被判「招标人 存在多个值」。只剥尾部、单组 ≤12 字（中间括注如「（中国科大英才创新创业基地）」
    // 是名称组成部分，不剥）。
    const base = stripTrailingFormAnnotation(stripped || trimmed);
    // E3 粘连残片卫生（r14 丰乐镇实测）：页码表头粘连（「第页共页1.本报价依据…」）、段落粘连
    //（「安徽省合肥市肥西县2.6建设规模：…」）、多句标点、路径串、纯括号占位（「（合同名称）」）、
    // 超长值（>40 字必为表格/段落残片）一律不作为比较值——名称类事实就绪值应短且纯净。
    if (!base || base.length > 40 || /第\s*页|共\s*页/u.test(base)) return '';
    if (/[，。；;、]/u.test(base) || /[：:]/u.test(base)) return '';
    // 路径串（含文件扩展名/目录分隔符）与单元格坐标（R6C3COL3 式）残片
    if (/^[（(][^）)]*[）)]$/u.test(base) || /[/\\]|\.(?:pdf|docx?|xlsx?|zip)/iu.test(base)) return '';
    if (/R\d+C\d+/u.test(base)) return '';
    if (normalize(base) === normalize(label)) return '';
    return normalize(base);
  }
  /**
   * 4.56.4 时间值口径三步（与真值层 `stripFactLabelPrefix` / `temporalValueKind` **同源**）：
   *
   * ① 剥口径标签前缀：`计划开工日期：2026年10月10日（…）` 不剥标签则起始不是 `20\d{2}`，
   *    `temporalValueKind` 判为 plain → 槽位分桶因 plain 混入整体失效 → 与工期值被判多值冲突；
   * ② **日期形态先行识别**：工期类标签下不得把日期里的「10月」当作时长——
   *    `2026年10月10日` 会被 `\d+…(?:月)` 匹配出 `10月`，把日期伪装成时长（实测正是如此）；
   * ③ 剩余文本再走时长正则。
   */
  const withoutLabel = stripFactLabelPrefix(trimmed);
  const dateShaped = withoutLabel.replace(/（[^）]*）|\([^)]*\)/gu, '').replace(/\s+/gu, '').trim();
  if (TEMPORAL_DATE_VALUE_RE.test(dateShaped)) return normalize(dateShaped.slice(0, 40));
  const duration = /\d+(?:\.\d+)?\s*(?:日历天|天|个月|月)/u.exec(withoutLabel)?.[0];
  // V5 P6 label 感知工期归一（run1 实测）：「计划工期=360日历天；2.9」的 value 本身不含
  // 「工期」二字，旧口径只看 value 导致整串归一，与「360日历天」被误报多值冲突——
  // 工期类 label 下总是优先提取 duration 片段参与比较。
  const normalized = normalize(duration && /工期|总工期|合同工期|计划工期|施工周期|质保期|有效期|养护期/u.test(`${label || ''} ${trimmed}`) ? duration : trimmed);
  if (!normalized || normalized.length > 80) return '';
  return normalized;
}

function shouldCheckStrictConflict(label: string, profile: DocumentDomainProfile) {
  const field = factFieldForLabel(profile, label);
  if (field) return field.cardinality === 'single' && field.conflictPolicy !== 'allow_multiple' && field.conflictPolicy !== 'ignore';
  return /项目名称|工程名称|招标人|建设地点|建筑面积|结构形式|层数|工期|质量标准|合同价格形式|绿色建筑等级|投标有效期|质保期/u.test(label);
}

function looksLikePathBundleName(value: string) {
  return /--|延期到|资料|附件|扫描|目录|汇总|打包|备份|招标工程量清单封面|招标工程量清单扉页|工程量清单表|清单封面|清单扉页|\d{1,2}\.\d{1,2}/u.test(value);
}

export function validateFactConsistency(input: { markdown: string; facts: DocumentFact[]; summary: ProjectMaterialSummary; profile?: DocumentDomainProfile }): ValidationIssue[] {
  const profile = input.profile || DEFAULT_DOCUMENT_DOMAIN_PROFILE;
  const issues: ValidationIssue[] = [];
  const factsByName = new Map<string, Array<{ value: string; source: string }>>();
  for (const fact of input.facts) {
    const label = fact.fieldName || fact.key;
    if (!label || !shouldCheckStrictConflict(label, profile)) continue;
    // E1（r14 丰乐镇实测）：清单/图纸表格解析派生的名称类事实实为清单条目名或单元格坐标粘连值
    //（「提升泵」「R6C3COL3:上海开艺设计集团有限公司」「分部小计」「R6C5金额(元):100000.00」），
    // 与招标文件真实项目名混入同一分组造成多值冲突误报——名称类字段只信主材料（招标文件/概况）来源。
    if (NAME_LIKE_LABEL_RE.test(label) && TABLE_DERIVED_ROLE_RE.test(fact.roleId || '')) continue;
    const value = comparableValue(String(fact.value), profile, label);
    if (!value) continue;
    factsByName.set(label, [...(factsByName.get(label) || []), { value: String(fact.value), source: fact.sourceFile }]);
  }
  for (const [label, values] of factsByName) {
    const grouped = new Map<string, Array<{ value: string; source: string }>>();
    for (const item of values) {
      const comparable = comparableValue(item.value, profile, label);
      if (!comparable) continue;
      // 4.56.3 同形变体折叠（仅作用于**分组键**，展示值不变）：
      // 「…项目—东区…」与「…项目一东区…」是同一项目名的破折号/一字变体，判多值冲突是纯误报
      const key = foldAdminNameAbbreviation(foldHomoglyphVariants(comparable));
      grouped.set(key, [...(grouped.get(key) || []), item]);
    }
    if (grouped.size > 1) {
      // V5 P6 截断等价折叠（run1 实测）：同一实体名在不同材料中一头一尾截断
      //（「…公共广场空间改造等」vs「…公共广场空间改造等提升工程」、「…有限责任公」vs
      //「…有限责任公司」）被判多值冲突——互为前缀且长差小（≤3 字，或以「等」结尾 ≤6 字）
      //视为同一取值截断，短的并入长的组。
      const ascending = [...grouped.keys()].sort((a, b) => a.length - b.length);
      const absorbed = new Set<string>();
      for (let i = 0; i < ascending.length; i += 1) {
        const short = ascending[i]!;
        if (absorbed.has(short)) continue;
        for (let j = i + 1; j < ascending.length; j += 1) {
          const long = ascending[j]!;
          const diff = long.length - short.length;
          /**
           * 4.56.3 粒度吸收扩展（实测 `建设地点`）：`巢湖市` 与
           * `巢湖市居巢经开区义成路与南外环路交口北侧` 是同一地址的**粗/细两级**，
           * 原规则要求长差 ≤3 字故未吸收，被判多值冲突。
           * 追加规则：**短值 ≤6 字且以行政区划后缀收尾**（省/市/县/区/镇/乡/村/街道）
           * 且为长值前缀时，视为粒度截断，并入长值。
           * 为何安全：区划后缀 + 极短长度使「短值是独立实体」的可能性极低，
           * 而真冲突（如两个不同城市）不会构成前缀关系。
           */
          /**
           * 4.56.6 粒度吸收扩展之二（实测 `项目名称` / `建设地点`）：
           * 短值是长值的**同一实体的粗粒度写法**，两种可判形态：
           *  ① 行政区划简称：`巢湖市居巢经济开发区`（→折简称后 `巢湖市居巢经开区`）是
           *     `巢湖市居巢经开区义成路与南外环路交口北侧` 的前缀——原规则限长 ≤6 字故未吸收；
           *  ② 项目粗名：`巢湖市光电新能源产业园项目` 是 `…项目—东区标准化厂房二标段施工` 的前缀，
           *     以 `项目/工程/标段` 收尾即为粗名形态（同项目在不同材料里的名称粒度不同）。
           * 真冲突不会构成这种前缀关系（两个不同区划/两个不同项目名互为前缀的概率极低）。
           */
          const isGenericPrefix = short.length <= 12 && /(?:省|市|县|区|镇|乡|村|开发区|经开区|新区|高新区)$/u.test(short) && long.startsWith(short);
          const isCoarseName = short.length <= 20 && /(?:项目|工程|标段)$/u.test(short) && long.startsWith(short);
          if ((diff <= 3 || (short.endsWith('等') && diff <= 6) || isGenericPrefix || isCoarseName) && long.startsWith(short)) {
            grouped.set(long, [...(grouped.get(long) || []), ...(grouped.get(short) || [])]);
            absorbed.add(short);
            break;
          }
        }
      }
      for (const key of absorbed) grouped.delete(key);
    }
    /**
     * 4.58 ② 时间槽位**三分桶**（修正 4.56.4 分桶的「一个 plain 值即失效」缺口）。
     *
     * 4.56.4 口径（判据单源 `temporalValueKind`，与真值层 D-T4 ④ 同源）要求组内值**全部**可判形态
     *（`kinds.size === 2 && !kinds.has('plain')`）才分桶，否则整组回到全量互比。实测
     * `doc-1790168542563-ea526b1b` 的 `计划工期` 组：`330日历天`（时长）+ `计划开工日期：2026年10月10日…`
     * （日期）+ `符合第二章“投标人须知”第1.3.2项规定`（合规引用句，形态 plain）——第三个值令分桶整体失效，
     * 时长与日期被拉回互比 → 多值冲突；同一族的 `标段工程工期`（表格行标题）等标签类 plain 值同理。
     *
     * 现口径：duration / date / plain **各自独立判定**（仍是同源 `temporalValueKind`，只是不再要求全组可判形态），
     * 桶内 ≥2 个分组键才报冲突，报文格式与全量互比分支完全一致（调用方零改动）。
     * 实测语义（`factConsistencyService.test.ts` 回放）：`330日历天` + `2026年10月10日` → 不报；
     * `330日历天` + `400日历天` → 报；plain 甲 + plain 乙 → 报；两个不同日期 → 报。
     *
     * 已知代价（可见记录，不静默）：跨形态的真冲突不再互比——典型是数字工期与中文数字工期
     *（`330日历天` vs `三百三十天`，后者形态判为 plain）同组时不再报出。取舍依据：plain 桶同时装着
     * 「引用句/标签值」这类噪声值（数量上占绝对多数）与真实取值，形态上无法区分；一旦让 plain 参与
     * 跨形态互比，就等于回到本次要根治的误报族（引用句与真实值几乎必同组）。
     */
    if (grouped.size > 1) {
      for (const kind of ['duration', 'date', 'plain'] as const) {
        const bucket = new Map([...grouped].filter(([key]) => temporalValueKind(key) === kind));
        if (bucket.size > 1) {
          const detail = [...bucket.values()].map(group => `${group[0]!.value}（${group.map(item => item.source).filter(Boolean).join('、') || '未知来源'}）`).join(' vs ');
          issues.push({ level: 'error', message: `事实一致性冲突：${label} 存在多个值：${detail}`, suggestion: '请确认当前绑定材料组，或在模板绑定中只绑定当前文档所需材料。' });
        }
      }
    }
  }
  const projectName = input.summary.facts.projectName;
  if (projectName && projectName !== '当前知识库项目' && !looksLikePathBundleName(projectName)) {
    const normalizedMarkdown = normalize(input.markdown);
    const candidateNames = [projectName, ...input.summary.fingerprint.projectNames]
      .flatMap(name => [name, name.replace(/^\d+(?:\.\d+)?[^\u4e00-\u9fa5]*/u, ''), name.replace(/\([^)]*\)|（[^）]*）/gu, '')])
      .map(name => normalize(name))
      .filter(name => name.length >= 4);
    // 短项目名（4-7 字符，如“徽光阁项目施工”）只做精确包含匹配：短名泛化截断误伤风险高，
    // 精确匹配是可靠的；此前按 8 字符过滤会得到空候选集，导致短名项目必报“未包含对象名称”误报
    const longNames = candidateNames.filter(name => name.length >= 8);
    const shortNames = candidateNames.filter(name => name.length < 8);
    const longMatched = longNames.some(name => normalizedMarkdown.includes(name) || (name.length >= 12 && normalizedMarkdown.includes(name.slice(0, Math.max(8, Math.floor(name.length * 0.72))))));
    const shortMatched = shortNames.some(name => normalizedMarkdown.includes(name));
    const matched = longNames.length > 0 ? longMatched : shortNames.length > 0 ? shortMatched : true;
    if (!matched) {
      issues.push({ level: 'warning', message: `正文未包含当前对象名称：${projectName}`, suggestion: '请确认标题、概况或背景信息是否已体现当前对象名称。' });
    }
  }
  return issues;
}
