import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MIN_ONNX_BYTES,
  PADDLE_DETECTION_MAX_SIDE_PX,
  PADDLE_MODEL_FILES,
  PADDLE_MODEL_PRESET,
  buildPaddleRecognizeOptions,
  parseDictionaryLines,
  selectPaddleModelFiles,
} from '../src/extraction/paddle-model-select.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-paddle-models-'));

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 清理 */ }
});

/** 建一个模型目录：onnx 写足体积（否则会被占位文件检查拦下），字典写指定行数 */
function makeModelDir(name: string, options: { detection?: boolean; recognition?: boolean; dictionary?: number | 'missing'; orientation?: boolean | 'tiny' } = {}): string {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const weights = Buffer.alloc(MIN_ONNX_BYTES + 1);
  if (options.detection !== false) fs.writeFileSync(path.join(dir, PADDLE_MODEL_FILES.detection), weights);
  if (options.recognition !== false) fs.writeFileSync(path.join(dir, PADDLE_MODEL_FILES.recognition), weights);
  const dictLines = options.dictionary ?? 18709;
  if (dictLines !== 'missing') {
    fs.writeFileSync(path.join(dir, PADDLE_MODEL_FILES.dictionary), Array.from({ length: dictLines }, (_, i) => `c${i}`).join('\n'));
  }
  if (options.orientation === true) fs.writeFileSync(path.join(dir, PADDLE_MODEL_FILES.orientation), weights);
  if (options.orientation === 'tiny') fs.writeFileSync(path.join(dir, PADDLE_MODEL_FILES.orientation), 'Entry not found');
  return dir;
}

// ─── 常量 ────────────────────────────────────────────────────

describe('固定模型配置', () => {
  it('代次与检测长边上限与 v6 预设一致', () => {
    expect(PADDLE_MODEL_PRESET).toBe('PP-OCRv6_small');
    expect(PADDLE_DETECTION_MAX_SIDE_PX).toBe(4000);
  });
});

// ─── 字典解析 ────────────────────────────────────────────────

describe('parseDictionaryLines', () => {
  it('保留末行的空格字符，只去掉尾随空行', () => {
    expect(parseDictionaryLines('a\nb\n \n\n')).toEqual(['a', 'b', ' ']);
  });

  it('空文本返回空数组', () => {
    expect(parseDictionaryLines('')).toEqual([]);
  });
});

// ─── 模型文件选择 ────────────────────────────────────────────

describe('selectPaddleModelFiles', () => {
  it('模型齐备时返回 v6 三元组', () => {
    const selection = selectPaddleModelFiles(makeModelDir('complete', { dictionary: 18709 }));
    expect(selection?.preset).toBe('PP-OCRv6_small');
    expect(selection?.dictLineCount).toBe(18709);
    expect(selection?.orientationFile).toBeUndefined();
  });

  it('目录不存在时返回 null', () => {
    expect(selectPaddleModelFiles(path.join(tmpDir, 'missing-dir'))).toBeNull();
  });

  it('缺识别权重时返回 null', () => {
    expect(selectPaddleModelFiles(makeModelDir('no-rec', { recognition: false }))).toBeNull();
  });

  it('权重是下载失败写入的占位文件时返回 null 并说明原因', () => {
    const dir = path.join(tmpDir, 'placeholder');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, PADDLE_MODEL_FILES.detection), 'Entry not found');
    fs.writeFileSync(path.join(dir, PADDLE_MODEL_FILES.recognition), 'Entry not found');
    expect(selectPaddleModelFiles(dir)).toBeNull();

    // 单个占位也不能放行（检测权重正常、识别权重是占位）
    const half = path.join(tmpDir, 'half-placeholder');
    fs.mkdirSync(half, { recursive: true });
    fs.writeFileSync(path.join(half, PADDLE_MODEL_FILES.detection), Buffer.alloc(MIN_ONNX_BYTES + 1));
    fs.writeFileSync(path.join(half, PADDLE_MODEL_FILES.recognition), 'Entry not found');
    expect(selectPaddleModelFiles(half)).toBeNull();
  });

  it('方向分类模型存在时被选中；是占位文件时跳过但不影响主模型', () => {
    const withOrientation = selectPaddleModelFiles(makeModelDir('with-ori', { orientation: true }));
    expect(withOrientation?.orientationFile).toContain(PADDLE_MODEL_FILES.orientation);

    const tinyOrientation = selectPaddleModelFiles(makeModelDir('tiny-ori', { orientation: 'tiny' }));
    expect(tinyOrientation?.orientationFile).toBeUndefined();
    expect(tinyOrientation?.preset).toBe('PP-OCRv6_small');
  });

  it('字典缺失时主模型仍可用并给出告警', () => {
    const selection = selectPaddleModelFiles(makeModelDir('no-dict', { dictionary: 'missing' }));
    expect(selection?.preset).toBe('PP-OCRv6_small');
    expect(selection?.dictLineCount).toBe(0);
    expect(selection?.warnings.join()).toContain('字典');
  });
});

// ─── 识别参数组装 ────────────────────────────────────────────

describe('buildPaddleRecognizeOptions', () => {
  it('未设置任何阈值时不传参数', () => {
    expect(buildPaddleRecognizeOptions({})).toEqual({});
  });

  it('检测阈值进 recognizeOptions.detection', () => {
    expect(buildPaddleRecognizeOptions({ minimumAreaThreshold: 8, boxScoreThreshold: 0.4 }).recognizeOptions)
      .toEqual({ detection: { minimumAreaThreshold: 8, boxScoreThreshold: 0.4 } });
  });

  it('识别行阈值进 processOptions', () => {
    expect(buildPaddleRecognizeOptions({ recognitionScoreThreshold: 0.35 }).processOptions)
      .toEqual({ recognitionScoreThreshold: 0.35 });
  });

  it('只传设置过的键，不塞默认值', () => {
    expect(buildPaddleRecognizeOptions({ boxScoreThreshold: 0.4, recognitionScoreThreshold: 0.35 }).recognizeOptions)
      .toEqual({ detection: { boxScoreThreshold: 0.4 } });
  });

  it('不包含 textlineOrientation（实例级配置，逐次传会抛错）', () => {
    const built = buildPaddleRecognizeOptions({ minimumAreaThreshold: 8, recognitionScoreThreshold: 0.35 });
    expect(JSON.stringify(built)).not.toContain('textlineOrientation');
  });
});
