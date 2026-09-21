#!/usr/bin/env bash
set -euo pipefail

# PaddleOCR ONNX 模型下载脚本
# 从 Hugging Face 官方仓（PaddlePaddle/*_onnx）下载 PP-OCRv6_small 检测/识别模型与方向分类模型。
#
# 用法：
#   bash scripts/download-paddleocr-models.sh
#
# 环境变量：
#   PADDLEOCR_MODEL_PATH  - 模型存放目录（默认 packages/knowledge/models/paddleocr）
#   HF_ENDPOINT           - Hugging Face 镜像（默认 https://huggingface.co）
#                           国内可用 https://hf-mirror.com
#
# 说明：脚本会把下载结果写到 .part 临时文件，校验体积通过后才改名到目标文件名 ——
# 下载失败时 HF 会返回 200 + 错误正文（如 "Entry not found"），若不校验就会把
# 十几字节的占位文件当成模型写盘，引擎被判可用却在推理时失败并静默降级 tesseract。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODEL_DIR="${PADDLEOCR_MODEL_PATH:-$SCRIPT_DIR/../models/paddleocr}"
HF_BASE="${HF_ENDPOINT:-https://huggingface.co}"

# 识别模型官方仓只发布 inference.yml（内含 character_dict），字典由此导出
DET_REPO="PaddlePaddle/PP-OCRv6_small_det_onnx"
REC_REPO="PaddlePaddle/PP-OCRv6_small_rec_onnx"
ORI_REPO="PaddlePaddle/PP-LCNet_x0_25_textline_ori_onnx"

# 单位字节：检测 ~10MB、识别 ~21MB、方向分类 ~1MB
MIN_DET_BYTES=$((1024 * 1024))
MIN_REC_BYTES=$((4 * 1024 * 1024))
MIN_ORI_BYTES=$((256 * 1024))

echo "==> 模型存放目录: $MODEL_DIR"
mkdir -p "$MODEL_DIR"

fetch() {
  local url="$1"
  local output="$2"
  local min_bytes="$3"
  local part="${output}.part"

  rm -f "$part"
  echo "  [下载] $(basename "$output") <- $url"
  if command -v curl &>/dev/null; then
    curl -fL --connect-timeout 30 --max-time 600 -o "$part" "$url"
  elif command -v wget &>/dev/null; then
    wget -q --timeout=30 -O "$part" "$url"
  else
    echo "错误: 需要 wget 或 curl" >&2
    exit 1
  fi

  local size
  size=$(wc -c < "$part" | tr -d ' ')
  if [ "$size" -lt "$min_bytes" ]; then
    echo "错误: $(basename "$output") 仅 $size 字节（应 >= $min_bytes），疑似下载失败或仓库缺少该文件。" >&2
    echo "      文件内容前 80 字节: $(head -c 80 "$part" 2>/dev/null)" >&2
    rm -f "$part"
    exit 1
  fi
  mv "$part" "$output"
  echo "        完成 ($size bytes)"
}

fetch "${HF_BASE}/${DET_REPO}/resolve/main/inference.onnx" \
      "$MODEL_DIR/PP-OCRv6_small_det_infer.onnx" "$MIN_DET_BYTES"
fetch "${HF_BASE}/${REC_REPO}/resolve/main/inference.onnx" \
      "$MODEL_DIR/PP-OCRv6_small_rec_infer.onnx" "$MIN_REC_BYTES"
fetch "${HF_BASE}/${REC_REPO}/resolve/main/inference.yml" \
      "$MODEL_DIR/ppocrv6_rec_inference.yml" $((64 * 1024))
fetch "${HF_BASE}/${ORI_REPO}/resolve/main/inference.onnx" \
      "$MODEL_DIR/PP-LCNet_x0_25_textline_ori_infer.onnx" "$MIN_ORI_BYTES"

# 字典从识别模型自带的 inference.yml 导出，保证与权重同代次
PYTHON_BIN="${PADDLEOCR_PYTHON:-python3}"
if ! command -v "$PYTHON_BIN" &>/dev/null; then
  echo "错误: 未找到 $PYTHON_BIN，无法从 inference.yml 导出字典" >&2
  exit 1
fi
echo "  [导出] ppocrv6_dict.txt <- ppocrv6_rec_inference.yml"
DICT_RESULT=$("$PYTHON_BIN" "$SCRIPT_DIR/extract_paddle_dict.py" \
  "$MODEL_DIR/ppocrv6_rec_inference.yml" "$MODEL_DIR/ppocrv6_dict.txt")
echo "        $DICT_RESULT"
rm -f "$MODEL_DIR/ppocrv6_rec_inference.yml"

echo ""
echo "==> 下载完成！模型文件位于: $MODEL_DIR"
echo "    PP-OCRv6_small + 方向分类模型已就绪，重启知识库索引即可使用。"
echo "    验证: node -e \"const{selectPaddleModelFiles}=require('$SCRIPT_DIR/../dist/extraction/paddle-model-select.js');console.log(selectPaddleModelFiles('$MODEL_DIR'))\""
