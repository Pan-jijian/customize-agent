#!/usr/bin/env python3
"""PaddleOCR 外部引擎桥接脚本（CUSTOMIZE_PADDLE_OCR_CMD 协议适配器）。

协议（与 packages/knowledge/src/extraction/content-extractor.ts 的 tryPaddleOcrLayout 对齐）：
  输入：ocr-paddle-bridge.py <image_path>（PNG/JPG，由管线渲染生成）
  输出：stdout 为 JSON 数组 [{type, text, bbox: {x0,y0,x1,y1}, confidence}]，ensure_ascii=False

依赖：Python 3.9+ 与 paddleocr（pip install paddleocr，含 paddlepaddle）。
首次运行会自动下载 PP-OCRv5 模型（约 40MB）到 ~/.paddleocr。

配置示例（server 环境变量）：
  CUSTOMIZE_PADDLE_OCR_CMD="/path/to/python3 /path/to/knowledge/scripts/ocr-paddle-bridge.py"

进程内缓存 PaddleOCR 实例，避免每次调用重复加载模型（首次调用约 10-30 秒）。
"""
import json
import sys

_OCR = None


def _get(res, key, default=None):
    """PaddleOCR 3.x Result 对象兼容取值（dict 索引或属性访问）。"""
    try:
        return res[key]
    except Exception:
        return getattr(res, key, default)


def get_ocr():
    global _OCR
    if _OCR is None:
        from paddleocr import PaddleOCR
        _OCR = PaddleOCR(
            lang='ch',
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
        )
    return _OCR


def main():
    if len(sys.argv) < 2:
        print('usage: ocr-paddle-bridge.py <image_path>', file=sys.stderr)
        sys.exit(2)
    path = sys.argv[1]
    ocr = get_ocr()
    try:
        results = ocr.predict(path)
    except TypeError:  # 兼容旧版 PaddleOCR 2.x API
        results = ocr.ocr(path)

    regions = []
    for res in results:
        texts = _get(res, 'rec_texts', []) or []
        scores = _get(res, 'rec_scores', []) or []
        polys = _get(res, 'rec_polys', []) or []
        for i, text in enumerate(texts):
            box = None
            if i < len(polys):
                poly = polys[i]
                xs = [float(p[0]) for p in poly]
                ys = [float(p[1]) for p in poly]
                box = {'x0': min(xs), 'y0': min(ys), 'x1': max(xs), 'y1': max(ys)}
            regions.append({
                'type': 'text',
                'text': text,
                'bbox': box,
                'confidence': float(scores[i]) if i < len(scores) else 0.0,
            })
    print(json.dumps(regions, ensure_ascii=False))


if __name__ == '__main__':
    main()
