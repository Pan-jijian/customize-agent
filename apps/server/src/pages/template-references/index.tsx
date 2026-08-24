import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { App, Button, Card, Drawer, Dropdown, Popconfirm, Progress, Spin, Tag, Tooltip, Upload } from 'antd';
import { CheckCircleFilled, CloseCircleFilled, DeleteOutlined, FileTextOutlined, InboxOutlined, MoreOutlined, ProfileOutlined, RiseOutlined, UploadOutlined } from '@ant-design/icons';
import { useAppTranslations } from '@/components/Layout';
import { deleteTemplateReferenceApi, getTemplateReferenceTypeProfiles, getTemplateReferences, patchTemplateReference, uploadTemplateReference, type ReferenceTypeProfile, type TemplateReferenceRecord } from '@/lib/api';

const PROJECT_TYPES = ['房建', '市政', '公路', '桥梁与隧道', '水利水电', '电力', '机电安装', '装饰装修', '园林绿化', '铁路', '港口与航道', '矿山冶金', '其他'];

/** 每类型的视觉主色（自定义卡片用）；浅底/描边通过主色加透明通道派生，深浅色主题下均可用 */
const TYPE_THEME: Record<string, { base: string }> = {
  房建: { base: '#1677ff' },
  市政: { base: '#16a34a' },
  公路: { base: '#ea580c' },
  桥梁与隧道: { base: '#dc2626' },
  水利水电: { base: '#0891b2' },
  电力: { base: '#ca8a04' },
  机电安装: { base: '#7c3aed' },
  装饰装修: { base: '#c026d3' },
  园林绿化: { base: '#65a30d' },
  铁路: { base: '#4f46e5' },
  港口与航道: { base: '#b45309' },
  矿山冶金: { base: '#db2777' },
  其他: { base: '#64748b' },
};

const typeBase = (type: string) => (TYPE_THEME[type] || TYPE_THEME.其他).base;

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

/** 页头统计小件：彩色圆点 + 数值 + 标签 */
function HeaderStat({ value, label, accent }: { value: number; label: string; accent: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-[var(--colorBorderSecondary)] bg-[var(--colorBgElevated)] px-4 py-2.5">
      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: accent }} />
      <div className="leading-tight">
        <div className="text-lg font-bold text-[var(--colorText)]">{value}</div>
        <div className="text-[11px] text-[var(--colorTextTertiary)]">{label}</div>
      </div>
    </div>
  );
}

/** 迷你指标块：画像卡/文件卡内的单格指标 */
function MiniStat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="rounded-lg px-2 py-1.5 bg-[var(--colorFillQuaternary)] min-w-0">
      <div className="text-[11px] text-[var(--colorTextTertiary)] truncate">{label}</div>
      <div className="text-sm font-bold text-[var(--colorText)] leading-tight">
        {value}
        {unit && <span className="text-[10px] font-normal text-[var(--colorTextTertiary)] ml-0.5">{unit}</span>}
      </div>
    </div>
  );
}

/** 类型 chip：上传预选与文件库筛选共用；激活态填充主色，未激活态为主色浅底描边 */
function TypeChip({ active, color, label, onClick }: { active: boolean; color: string; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all duration-150 cursor-pointer ${active ? 'text-white shadow-sm scale-[1.03]' : 'hover:-translate-y-0.5 hover:shadow-sm'}`}
      style={active
        ? { background: color, borderColor: color }
        : { background: `${color}14`, borderColor: `${color}33`, color }}
    >
      {label}
    </button>
  );
}

/** 空态提示 */
function EmptyHint({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 gap-3">
      <span className="w-12 h-12 rounded-2xl flex items-center justify-center text-xl bg-[var(--colorFillSecondary)] text-[var(--colorTextTertiary)]">
        <InboxOutlined />
      </span>
      <span className="text-sm text-[var(--colorTextTertiary)]">{text}</span>
    </div>
  );
}

/** 详情抽屉小节：彩色短竖条 + 标题 */
function DrawerSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <span className="w-1 h-3.5 rounded-full bg-[var(--colorAccent)]" />
        <span className="text-sm font-semibold text-[var(--colorText)]">{title}</span>
      </div>
      {children}
    </div>
  );
}

/** 指标区间块（最小 ~ 均值 ~ 最大） */
function RangeStat({ label, range, kind }: { label: string; range: { avg: number; min: number; max: number }; kind: 'perK' | 'percent' | 'int' }) {
  const fmt = kind === 'int' ? (value: number) => String(Math.round(value)) : kind === 'percent' ? (value: number) => `${Math.round(value * 100)}%` : (value: number) => value.toFixed(1);
  return (
    <div className="rounded-xl px-3 py-2.5 border border-[var(--colorBorderSecondary)] bg-[var(--colorFillQuaternary)]">
      <div className="text-[11px] text-[var(--colorTextTertiary)] mb-1 truncate">{label}</div>
      <div className="text-sm font-bold text-[var(--colorText)]">{fmt(range.avg)}</div>
      <div className="text-[10px] text-[var(--colorTextTertiary)] mt-0.5">{fmt(range.min)} ~ {fmt(range.max)}</div>
    </div>
  );
}

export default function TemplateReferencesPage() {
  const t = useAppTranslations();
  const { message } = App.useApp();
  const [references, setReferences] = useState<TemplateReferenceRecord[]>([]);
  const [typeProfiles, setTypeProfiles] = useState<ReferenceTypeProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [selectedType, setSelectedType] = useState<string | undefined>(undefined);
  const [profileDetail, setProfileDetail] = useState<ReferenceTypeProfile | null>(null);

  const loadAll = useCallback(async () => {
    try {
      const [refsRes, profilesRes] = await Promise.all([getTemplateReferences(), getTemplateReferenceTypeProfiles()]);
      setReferences(refsRes.references);
      setTypeProfiles(profilesRes.profiles);
    } catch { setReferences([]); setTypeProfiles([]); }
  }, []);

  useEffect(() => {
    void loadAll().finally(() => setLoading(false));
  }, [loadAll]);

  const handleUpload = async (file: File) => {
    setUploading(true);
    try {
      const result = await uploadTemplateReference(file, selectedType);
      message.success(t('refs.uploaded'));
      if (result.reference.status === 'failed') message.warning(`${result.reference.fileName}：${result.reference.errorMessage || t('refs.uploadFailed')}`);
      await loadAll();
    } catch (error) {
      message.error(error instanceof Error ? error.message : t('refs.uploadFailed'));
    } finally {
      setUploading(false);
    }
  };

  const handleChangeType = async (record: TemplateReferenceRecord, projectType: string) => {
    try {
      await patchTemplateReference(record.id, { projectType });
      await loadAll();
      message.success(t('refs.typeChanged'));
    } catch (error) {
      message.error(error instanceof Error ? error.message : t('refs.operationFailed'));
    }
  };

  const handleDelete = async (record: TemplateReferenceRecord) => {
    try {
      await deleteTemplateReferenceApi(record.id);
      await loadAll();
    } catch (error) {
      message.error(error instanceof Error ? error.message : t('refs.operationFailed'));
    }
  };

  const readyCount = useMemo(() => references.filter(item => item.status === 'ready').length, [references]);
  const filteredReferences = useMemo(() => (selectedType ? references.filter(item => item.projectType === selectedType) : references), [references, selectedType]);
  const typeCount = (type: string) => references.filter(item => item.projectType === type).length;

  // ═══════ 类型画像卡：自定义卡片（渐变顶条 + 类型徽标 + 指标格 + 典型章节胶囊） ═══════
  const renderProfileCard = (profile: ReferenceTypeProfile) => {
    const m = profile.metrics;
    const base = typeBase(profile.projectType);
    return (
      <div
        key={profile.projectType}
        role="button"
        tabIndex={0}
        onClick={() => setProfileDetail(profile)}
        onKeyDown={event => { if (event.key === 'Enter') setProfileDetail(profile); }}
        className="group relative rounded-2xl border border-[var(--colorBorderSecondary)] bg-[var(--colorBgElevated)] overflow-hidden transition-all duration-200 hover:shadow-lg hover:-translate-y-0.5 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-[var(--colorAccent)]"
        title={t('refs.profileDetail')}
      >
        <div className="h-1.5" style={{ background: `linear-gradient(90deg, ${base}, ${base}55)` }} />
        <div className="p-5 flex flex-col gap-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="shrink-0 w-9 h-9 rounded-xl flex items-center justify-center text-base font-bold" style={{ background: `${base}14`, color: base }}>
                {profile.projectType.slice(0, 1)}
              </span>
              <div className="min-w-0">
                <div className="font-semibold text-[var(--colorText)] leading-tight">{profile.projectType}</div>
                <div className="text-xs text-[var(--colorTextTertiary)] mt-0.5">
                  {profile.sourceCount}{t('refs.profileSamples')} · {t('refs.profileUpdated')} {new Date(profile.updatedAt).toLocaleDateString()}
                </div>
              </div>
            </div>
            <ProfileOutlined className="text-[var(--colorTextTertiary)] group-hover:text-[var(--colorAccent)] transition-colors shrink-0" />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <MiniStat label={t('refs.paramDensity')} value={m.paramDensity.avg.toFixed(1)} unit="/千字" />
            <MiniStat label={t('refs.arrowChain')} value={String(Math.round(m.arrowChainCoverage.avg * 100))} unit="%" />
            <MiniStat label={t('refs.duplication')} value={String(Math.round(m.duplicationRate.avg * 100))} unit="%" />
            <MiniStat label={t('refs.tables')} value={String(Math.round(m.tableCount.avg))} />
            <MiniStat label={t('refs.sectionSubsection')} value={String(Math.round(m.sectionCount.avg))} unit={`章 · ${Math.round(m.subsectionCount?.avg || 0)} 节`} />
            <MiniStat label={t('refs.words')} value={(m.avgSectionWords.avg / 1000).toFixed(1)} unit="k/章" />
          </div>
          {profile.typicalHeadings.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {profile.typicalHeadings.slice(0, 4).map(heading => (
                <span key={heading.title} className="px-2 py-0.5 rounded-md text-[11px] leading-5 truncate max-w-full bg-[var(--colorFillSecondary)] text-[var(--colorTextSecondary)]" title={heading.title}>
                  {heading.title}<span className="opacity-60 ml-1">{Math.round(heading.ratio * 100)}%</span>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  };

  // ═══════ 文件卡：自定义卡片（类型色文件图标 + 指标格 + 章节胶囊 + 操作） ═══════
  const renderReferenceCard = (record: TemplateReferenceRecord) => {
    const profile = record.qualityProfile;
    const ready = record.status === 'ready';
    const base = typeBase(record.projectType);
    return (
      <div key={record.id} className="rounded-2xl border border-[var(--colorBorderSecondary)] bg-[var(--colorBgElevated)] transition-all duration-200 hover:shadow-md overflow-hidden">
        <div className="flex items-start justify-between gap-3 px-4 pt-4 pb-3">
          <div className="flex items-start gap-3 min-w-0">
            <span className="shrink-0 w-9 h-9 rounded-xl flex items-center justify-center text-base" style={{ background: `${base}14`, color: base }}>
              <FileTextOutlined />
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 min-w-0">
                <Tooltip title={record.fileName}>
                  <span className="font-medium text-[var(--colorText)] truncate block">{record.fileName}</span>
                </Tooltip>
              </div>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                <span className="px-1.5 py-px rounded text-[11px] font-medium" style={{ background: `${base}14`, color: base }}>{record.projectType}</span>
                {record.typeSource === 'auto' && <span className="text-[11px] text-[var(--colorTextTertiary)]">{t('refs.autoClassified')}</span>}
                <span className="text-[11px] text-[var(--colorTextTertiary)]">{formatBytes(record.fileSize)} · {new Date(record.uploadedAt).toLocaleDateString()}</span>
              </div>
            </div>
          </div>
          <div className="flex items-center shrink-0" onClick={event => event.stopPropagation()}>
            <Dropdown
              menu={{
                items: PROJECT_TYPES.filter(type => type !== record.projectType).map(type => ({ key: `type-${type}`, label: `${t('refs.changeType')}：${type}` })),
                onClick: ({ key }) => { const type = key.replace('type-', ''); if (type) { void handleChangeType(record, type); } },
              }}
            >
              <Button size="small" type="text" className="!w-7 !h-7 !min-w-7 flex items-center justify-center" icon={<MoreOutlined />} />
            </Dropdown>
            <Popconfirm title={t('refs.deleteConfirm')} onConfirm={() => { void handleDelete(record); }}>
              <Button size="small" type="text" danger className="!w-7 !h-7 !min-w-7 flex items-center justify-center" icon={<DeleteOutlined />} />
            </Popconfirm>
          </div>
        </div>
        <div className="px-4 pb-4 flex flex-col gap-3">
          {record.status === 'failed' && (
            <div className="rounded-lg border border-red-200 bg-red-50/40 px-2.5 py-2 text-xs text-[var(--colorDanger)]">
              <CloseCircleFilled className="mr-1" />{t('refs.statusFailed')}：{record.errorMessage || t('refs.uploadFailed')}
            </div>
          )}
          {record.status === 'parsing' && (
            <div className="flex items-center gap-2 text-xs text-[var(--colorTextTertiary)]"><Spin size="small" />{t('refs.statusParsing')}</div>
          )}
          {ready && profile && (
            <>
              <div className="grid grid-cols-3 gap-2">
                <MiniStat label={t('refs.paramDensity')} value={profile.paramDensity.toFixed(1)} unit="/千字" />
                <MiniStat label={t('refs.arrowChain')} value={String(Math.round(profile.arrowChainCoverage * 100))} unit="%" />
                <MiniStat label={t('refs.duplication')} value={String(Math.round(profile.duplicationRate * 100))} unit="%" />
                <MiniStat label={t('refs.tables')} value={String(profile.tableCount)} />
                <MiniStat label={t('refs.sectionSubsection')} value={String(profile.sectionCount)} unit={`章 · ${profile.subsectionCount || 0} 节`} />
                <MiniStat label={t('refs.words')} value={(profile.wordCount / 10000).toFixed(1)} unit="万" />
              </div>
              {profile.headingStructure.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <span className="text-[11px] text-[var(--colorTextTertiary)]">{t('refs.headingPreview')}</span>
                  <div className="flex flex-wrap gap-1">
                    {profile.headingStructure.slice(0, 4).map(title => (
                      <span key={title} className="px-1.5 py-px rounded text-[11px] truncate max-w-full bg-[var(--colorFillSecondary)] text-[var(--colorTextSecondary)]" title={title}>{title}</span>
                    ))}
                    {profile.headingStructure.length > 4 && <span className="text-[11px] text-[var(--colorTextTertiary)] leading-5">+{profile.headingStructure.length - 4}</span>}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    );
  };

  const profileSourceFiles = useMemo(() => (profileDetail ? references.filter(item => item.projectType === profileDetail.projectType && item.status === 'ready') : []), [references, profileDetail]);
  const detailBase = profileDetail ? typeBase(profileDetail.projectType) : typeBase('其他');

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="space-y-6 animateFadeIn">
        {/* ═══════ 页头：标题 + 描述 + 概览统计 ═══════ */}
        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-5 pb-1">
          <div className="max-w-3xl">
            <h1 className="text-3xl font-extrabold tracking-tight text-[var(--colorText)] mb-2.5 flex items-center gap-2.5">
              <span className="w-11 h-11 rounded-2xl flex items-center justify-center text-2xl bg-[var(--colorFillSecondary)]" style={{ color: 'var(--colorAccent)' }}>
                <ProfileOutlined />
              </span>
              {t('refs.title')}
            </h1>
            <p className="text-sm text-[var(--colorTextSecondary)] leading-relaxed">{t('refs.description')}</p>
          </div>
          <div className="flex items-center gap-3 flex-wrap shrink-0">
            <HeaderStat value={readyCount} label={t('refs.totalSamples')} accent="#1677ff" />
            <HeaderStat value={typeProfiles.length} label={t('refs.coveredTypes')} accent="#16a34a" />
          </div>
        </div>

        {/* ═══════ 上传区：类型 chip 预选 + 拖拽上传 ═══════ */}
        <Card className="rounded-2xl" styles={{ body: { padding: 24 } }}>
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2.5">
                <UploadOutlined className="text-[var(--colorAccent)]" />
                <span className="font-semibold text-[var(--colorText)]">{t('refs.uploadSection')}</span>
              </div>
              <span className="inline-flex items-center gap-1.5 text-xs text-[var(--colorTextTertiary)]">
                <CheckCircleFilled style={{ color: 'var(--colorOk)' }} />
                {t('refs.redLine')}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              <TypeChip active={!selectedType} color="#6366f1" label={t('refs.autoClassify')} onClick={() => setSelectedType(undefined)} />
              {PROJECT_TYPES.map(type => (
                <TypeChip key={type} active={selectedType === type} color={typeBase(type)} label={type} onClick={() => setSelectedType(prev => (prev === type ? undefined : type))} />
              ))}
            </div>
            <Upload.Dragger
              accept=".pdf,.docx,.doc"
              multiple={false}
              showUploadList={false}
              disabled={uploading}
              className="!rounded-xl"
              customRequest={({ file, onSuccess, onError }) => {
                const rawFile = file as File;
                handleUpload(rawFile)
                  .then(() => onSuccess?.({}))
                  .catch(error => onError?.(error instanceof Error ? error : new Error(t('refs.uploadFailed'))));
              }}
            >
              <p className="ant-upload-drag-icon"><InboxOutlined /></p>
              <p className="ant-upload-text">{uploading ? t('refs.uploading') : t('refs.uploadTitle')}</p>
              <p className="ant-upload-hint">{t('refs.uploadHint')}</p>
            </Upload.Dragger>
          </div>
        </Card>

        {/* ═══════ 类型画像 ═══════ */}
        <Card
          className="rounded-2xl"
          title={
            <div className="flex items-center gap-2.5">
              <RiseOutlined className="text-[var(--colorAccent)]" />
              <span>{t('refs.profileTitle')}</span>
              <span className="text-xs font-normal text-[var(--colorTextTertiary)]">{t('refs.profileSubtitle')}</span>
            </div>
          }
          styles={{ body: { padding: 24 } }}
        >
          {loading ? <Spin /> : typeProfiles.length === 0
            ? <EmptyHint text={t('refs.profileNoSamples')} />
            : <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">{typeProfiles.map(renderProfileCard)}</div>}
        </Card>

        {/* ═══════ 文件库：类型 chip 筛选 + 文件卡 ═══════ */}
        <Card
          className="rounded-2xl"
          title={
            <div className="flex items-center gap-2.5">
              <FileTextOutlined className="text-[var(--colorAccent)]" />
              <span>{t('refs.fileLibrary')}</span>
              <span className="text-xs font-normal text-[var(--colorTextTertiary)]">{readyCount} / {references.length}</span>
            </div>
          }
          styles={{ body: { padding: 24 } }}
        >
          <div className="flex flex-wrap gap-2 mb-5">
            <TypeChip active={!selectedType} color="#6366f1" label={`${t('refs.allFiles')} · ${references.length}`} onClick={() => setSelectedType(undefined)} />
            {PROJECT_TYPES.map(type => {
              const count = typeCount(type);
              if (count === 0) return null;
              return <TypeChip key={type} active={selectedType === type} color={typeBase(type)} label={`${type} · ${count}`} onClick={() => setSelectedType(prev => (prev === type ? undefined : type))} />;
            })}
          </div>
          {loading ? <Spin /> : filteredReferences.length === 0
            ? <EmptyHint text={t('refs.noReferences')} />
            : <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-4">{filteredReferences.map(renderReferenceCard)}</div>}
        </Card>
      </div>

      {/* ═══════ 类型画像详情抽屉 ═══════ */}
      <Drawer
        title={null}
        open={!!profileDetail}
        onClose={() => setProfileDetail(null)}
        size={600}
        styles={{ body: { padding: 0 } }}
      >
        {profileDetail && (
          <div className="flex flex-col">
            <div className="px-6 pt-6 pb-5" style={{ background: `linear-gradient(180deg, ${detailBase}0f, transparent)` }}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="w-10 h-10 rounded-xl flex items-center justify-center text-lg font-bold" style={{ background: `${detailBase}1f`, color: detailBase }}>
                    {profileDetail.projectType.slice(0, 1)}
                  </span>
                  <div>
                    <div className="text-lg font-bold text-[var(--colorText)]">{profileDetail.projectType} · {t('refs.profileDetailTitle')}</div>
                    <div className="text-xs text-[var(--colorTextTertiary)] mt-0.5">{t('refs.profileUpdated')} {new Date(profileDetail.updatedAt).toLocaleString()}</div>
                  </div>
                </div>
                <Tag className="!m-0 shrink-0" style={{ color: detailBase, background: `${detailBase}14`, border: `1px solid ${detailBase}33` }}>
                  {profileDetail.sourceCount}{t('refs.profileSamples')} · {(profileDetail.totalWords / 10000).toFixed(1)} 万字
                </Tag>
              </div>
            </div>
            <div className="px-6 pb-8 flex flex-col gap-6">
              <DrawerSection title={t('refs.profileMetrics')}>
                <div className="grid grid-cols-4 gap-2.5">
                  <RangeStat label={t('refs.paramDensity')} range={profileDetail.metrics.paramDensity} kind="perK" />
                  <RangeStat label={t('refs.arrowChain')} range={profileDetail.metrics.arrowChainCoverage} kind="percent" />
                  <RangeStat label={t('refs.duplication')} range={profileDetail.metrics.duplicationRate} kind="percent" />
                  <RangeStat label={t('refs.tables')} range={profileDetail.metrics.tableCount} kind="int" />
                  <RangeStat label={t('refs.sections')} range={profileDetail.metrics.sectionCount} kind="int" />
                  <RangeStat label={t('refs.subsections')} range={profileDetail.metrics.subsectionCount || { avg: 0, min: 0, max: 0 }} kind="int" />
                  <RangeStat label={t('refs.subitems')} range={profileDetail.metrics.subitemCount || { avg: 0, min: 0, max: 0 }} kind="int" />
                  <RangeStat label={t('refs.avgSectionWords')} range={{ avg: profileDetail.metrics.avgSectionWords.avg, min: profileDetail.metrics.avgSectionWords.avg, max: profileDetail.metrics.avgSectionWords.avg }} kind="int" />
                </div>
              </DrawerSection>
              <DrawerSection title={t('refs.profileTypicalHeadings')}>
                {profileDetail.typicalHeadings.length === 0
                  ? <span className="text-xs text-[var(--colorTextTertiary)]">{t('refs.noReferences')}</span>
                  : profileDetail.typicalHeadings.map(heading => (
                    <div key={heading.title} className="flex items-center gap-3 rounded-lg px-2.5 py-1.5 border border-transparent hover:border-[var(--colorBorderSecondary)] transition-colors">
                      <span className="flex-1 min-w-0 text-[13px] text-[var(--colorText)] truncate" title={heading.title}>{heading.title}</span>
                      <Progress percent={Math.round(heading.ratio * 100)} size="small" showInfo={false} className="!w-24 !m-0" strokeColor={detailBase} />
                      <span className="w-16 text-right text-xs text-[var(--colorTextTertiary)] shrink-0">{Math.round(heading.ratio * 100)}% · {heading.count}</span>
                    </div>
                  ))}
              </DrawerSection>
              <DrawerSection title={t('refs.profileCommonTables')}>
                {profileDetail.commonTables.length === 0
                  ? <span className="text-xs text-[var(--colorTextTertiary)]">{t('refs.noReferences')}</span>
                  : <div className="flex flex-wrap gap-1.5">
                    {profileDetail.commonTables.map(item => (
                      <span key={item.title} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs bg-[var(--colorFillSecondary)] text-[var(--colorTextSecondary)]">
                        {item.title}<span className="opacity-60">×{item.count}</span>
                      </span>
                    ))}
                  </div>}
              </DrawerSection>
              <DrawerSection title={t('refs.profileFrequentParams')}>
                {profileDetail.frequentParams.length === 0
                  ? <span className="text-xs text-[var(--colorTextTertiary)]">{t('refs.noReferences')}</span>
                  : <div className="flex flex-wrap gap-1.5">
                    {profileDetail.frequentParams.map(item => (
                      <span key={item.token} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs" style={{ background: `${detailBase}14`, color: detailBase }}>
                        {item.token}<span className="opacity-60">×{item.count}</span>
                      </span>
                    ))}
                  </div>}
              </DrawerSection>
              <DrawerSection title={t('refs.profileSources')}>
                {profileSourceFiles.map(item => (
                  <div key={item.id} className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 bg-[var(--colorFillQuaternary)]">
                    <FileTextOutlined className="text-[var(--colorTextTertiary)] text-sm shrink-0" />
                    <span className="flex-1 min-w-0 text-[13px] text-[var(--colorText)] truncate" title={item.fileName}>{item.fileName}</span>
                    <span className="text-xs text-[var(--colorTextTertiary)] shrink-0">{formatBytes(item.fileSize)}</span>
                  </div>
                ))}
              </DrawerSection>
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}
