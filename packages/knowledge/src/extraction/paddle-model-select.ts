/**
 * PaddleOCR 模型文件选择与识别参数组装。
 *
 * 模型代次、文件名、识别参数全部**固定为最优配置**，不提供环境变量开关：
 * 图纸解析的目标是数据精准与不丢失，任何「调低召回以换速度」的口子都可能让图纸标注
 * 静默变少，因此不作为可配置项暴露。
 *
 * 为什么必须按实际权重选择 preset：preset 携带检测预处理参数，v5 与 v6 的缩放策略完全不同
 * （v5 `limitType:'max'` + `maxSideLength:960` 会把整页压到 960px；v6 `limitType:'min'`
 * 只在短边过小时放大，长边仅受 `maxSideLimit:4000` 约束）。preset 与权重不匹配会得到
 * 错误的分辨率策略 —— 这正是图纸解析几乎为空的历史根因。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** 随包发布的模型代次；与 scripts/download-paddleocr-models.sh 保持一致 */
export const PADDLE_MODEL_PRESET = 'PP-OCRv6_small' as const;
/** v6 检测预处理的长边上限（与 paddleocr 的 PP-OCRv6 预设一致）：超过它就会被缩放 */
export const PADDLE_DETECTION_MAX_SIDE_PX = 4000;

/** 随包发布的模型文件名 */
export const PADDLE_MODEL_FILES = {
  detection: 'PP-OCRv6_small_det_infer.onnx',
  recognition: 'PP-OCRv6_small_rec_infer.onnx',
  dictionary: 'ppocrv6_dict.txt',
  /** 方向分类（0°/180° 纠正），可选增强：缺失时主模型仍可用 */
  orientation: 'PP-LCNet_x0_25_textline_ori_infer.onnx',
} as const;

/**
 * ONNX 权重的最小合理体积。真实模型：检测 ~10MB、识别 ~21MB、方向分类 ~1MB。
 * 用来拦住「下载失败但写入了错误响应体」的占位文件 —— 下载脚本曾把 15 字节的
 * `Entry not found` 当成模型写盘并打印「下载完成」，文件名齐全使引擎被判可用，
 * 到推理时才失败并降级 tesseract。64KB 远低于任何真实模型，不会误伤。
 */
export const MIN_ONNX_BYTES = 64 * 1024;

export interface PaddleModelSelection {
  preset: typeof PADDLE_MODEL_PRESET;
  /** 下列均为绝对路径 */
  detFile: string;
  recFile: string;
  dictFile: string;
  orientationFile?: string;
  /** 字典有效行数（含末行的空格字符） */
  dictLineCount: number;
  warnings: string[];
}

/**
 * 字典文本 → 行数组。末行是空格字符（模型把空格识别为最后一类），`trimEnd` 会误删，
 * 因此只去掉尾随的空行；此处与建实例时的口径保持一致。
 */
export function parseDictionaryLines(text: string): string[] {
  const lines = String(text ?? '').split(/\r?\n/u);
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * 校验模型目录内的文件是否齐备且体积正常。
 * 目录缺失、权重缺失或体积异常（占位文件）时返回 null，调用方据此判定引擎不可用，
 * 并给出「请执行下载脚本」的可操作提示。
 */
export function selectPaddleModelFiles(modelDir: string): PaddleModelSelection | null {
  const warnings: string[] = [];
  const resolve = (name: string): string | undefined => {
    const full = path.join(modelDir, name);
    try {
      return fs.statSync(full).size >= MIN_ONNX_BYTES ? full : undefined;
    } catch {
      return undefined;
    }
  };

  const detFile = resolve(PADDLE_MODEL_FILES.detection);
  const recFile = resolve(PADDLE_MODEL_FILES.recognition);
  if (!detFile || !recFile) {
    // 区分「文件不存在」与「文件是占位内容」，便于用户判断是没下载还是下载损坏
    if (fs.existsSync(path.join(modelDir, PADDLE_MODEL_FILES.detection)) || fs.existsSync(path.join(modelDir, PADDLE_MODEL_FILES.recognition))) {
      warnings.push(`模型权重体积异常（疑似下载失败写入的占位文件），请重新执行 scripts/download-paddleocr-models.sh`);
    }
    return null;
  }

  const dictPath = path.join(modelDir, PADDLE_MODEL_FILES.dictionary);
  let dictLineCount = 0;
  try {
    dictLineCount = parseDictionaryLines(fs.readFileSync(dictPath, 'utf8')).length;
  } catch {
    warnings.push(`无法读取字典文件 ${PADDLE_MODEL_FILES.dictionary}，识别结果可能异常`);
  }

  return {
    preset: PADDLE_MODEL_PRESET,
    detFile,
    recFile,
    dictFile: dictPath,
    orientationFile: resolve(PADDLE_MODEL_FILES.orientation),
    dictLineCount,
    warnings,
  };
}

/** 识别参数（检测/后处理阈值） */
export interface OcrRecallSettings {
  /** 检测框最小面积（像素²，检测坐标系） */
  minimumAreaThreshold?: number;
  /** 检测框置信度阈值 */
  boxScoreThreshold?: number;
  /** 识别行置信度阈值（processRecognition 的行分组前过滤） */
  recognitionScoreThreshold?: number;
}

/**
 * 组装传给 paddleocr 的逐次调用参数。
 * 注意 `processRecognition` 的行置信度过滤发生在行分组之前，只放宽检测阈值而不放宽它，
 * 低置信度的检测框仍会被整体丢弃 —— 两者必须一起放宽才有效。
 * 也不在此处传 `textlineOrientation`：方向分类是实例级配置，逐次调用传会抛错。
 */
export function buildPaddleRecognizeOptions(settings: OcrRecallSettings): {
  recognizeOptions?: Record<string, unknown>;
  processOptions?: Record<string, unknown>;
} {
  const detection: Record<string, unknown> = {};
  if (settings.minimumAreaThreshold !== undefined) detection.minimumAreaThreshold = settings.minimumAreaThreshold;
  if (settings.boxScoreThreshold !== undefined) detection.boxScoreThreshold = settings.boxScoreThreshold;

  const result: { recognizeOptions?: Record<string, unknown>; processOptions?: Record<string, unknown> } = {};
  if (Object.keys(detection).length > 0) result.recognizeOptions = { detection };
  if (settings.recognitionScoreThreshold !== undefined) {
    result.processOptions = { recognitionScoreThreshold: settings.recognitionScoreThreshold };
  }
  return result;
}
