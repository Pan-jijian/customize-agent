/**
 * 4.55.29 L1-2/L1-3 非交付物标注（单源）：导出门禁未通过、用户仍显式选择「仍要导出」时，
 * 产物必须自带标记——文件名强制加后缀 + 响应头显式声明，防止非交付物被误当正式成果投标。
 *
 * 标记只有一处来源（本模块）：服务端导出路由用 markNonDeliverableFilename 改写
 * Content-Disposition，前端直接采用服务端下发的文件名（lib/api.ts 解析该头），
 * 因此任何客户端都无法通过「自己拼文件名」绕开标注。
 */

/** 非交付物标记词（文件后缀与界面标签共用；界面展示文案走 i18n，标记词是文件系统层的稳定标识） */
export const NON_DELIVERABLE_MARKER = '非交付物';

/** 非交付物文件名后缀：追加在扩展名之前（如 `施工组织设计_非交付物_.pdf`） */
export const NON_DELIVERABLE_FILENAME_SUFFIX = `_${NON_DELIVERABLE_MARKER}_`;

/** 非交付物响应头：值为 'true' 表示本次导出未过门禁（文件名已带后缀），前端据此在界面显式标注 */
export const NON_DELIVERABLE_HEADER = 'X-Export-Not-Deliverable';

/** 文件名标注（幂等）：`X.pdf` → `X_非交付物_.pdf`；已含后缀的原样返回 */
export function markNonDeliverableFilename(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  if (base.includes(NON_DELIVERABLE_FILENAME_SUFFIX)) return fileName;
  return dot > 0 ? `${base}${NON_DELIVERABLE_FILENAME_SUFFIX}${fileName.slice(dot)}` : `${base}${NON_DELIVERABLE_FILENAME_SUFFIX}`;
}
