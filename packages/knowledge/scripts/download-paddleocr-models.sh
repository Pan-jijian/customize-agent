#!/usr/bin/env bash
set -euo pipefail

# PaddleOCR ONNX 模型下载脚本
# 从 Hugging Face 下载 PP-OCRv6_small 模型文件
#
# 用法：
#   bash scripts/download-paddleocr-models.sh
#
# 环境变量：
#   PADDLEOCR_MODEL_PATH  - 模型存放目录（默认 packages/knowledge/models/paddleocr）
#   HF_ENDPOINT           - Hugging Face 镜像（默认 https://huggingface.co）
#                           国内可用 https://hf-mirror.com

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODEL_DIR="${PADDLEOCR_MODEL_PATH:-$SCRIPT_DIR/../models/paddleocr}"
HF_BASE="${HF_ENDPOINT:-https://huggingface.co}"
REPO="x3zvawq/paddleocr-js-onnx"

# 模型文件列表
FILES=(
  "ppocr_v6_small/PP-OCRv6_small_det_infer.onnx"
  "ppocr_v6_small/PP-OCRv6_small_rec_infer.onnx"
  "ppocr_v6_small/ppocrv6_dict.txt"
  "pp_lcnet_x0_25_textline_ori/PP-LCNet_x0_25_textline_ori_infer.onnx"
)

echo "==> 模型存放目录: $MODEL_DIR"
mkdir -p "$MODEL_DIR"

download_file() {
  local remote_path="$1"
  local local_name="$2"
  local url="${HF_BASE}/${REPO}/resolve/main/${remote_path}"
  local output="${MODEL_DIR}/${local_name}"

  if [ -f "$output" ]; then
    echo "  [跳过] $local_name 已存在 ($(wc -c < "$output" | tr -d ' ') bytes)"
    return 0
  fi

  echo "  [下载] $local_name <- $url"
  if command -v wget &>/dev/null; then
    wget -q --show-progress --timeout=30 -O "$output" "$url"
  elif command -v curl &>/dev/null; then
    curl -L --connect-timeout 30 --max-time 300 -o "$output" "$url"
  else
    echo "错误: 需要 wget 或 curl" >&2
    exit 1
  fi

  echo "        完成 ($(wc -c < "$output" | tr -d ' ') bytes)"
}

echo "==> 下载 PP-OCRv6_small 模型文件..."
download_file "${FILES[0]}" "PP-OCRv6_small_det_infer.onnx"
download_file "${FILES[1]}" "PP-OCRv6_small_rec_infer.onnx"
download_file "${FILES[2]}" "ppocrv6_dict.txt"
download_file "${FILES[3]}" "PP-LCNet_x0_25_textline_ori_infer.onnx"

echo ""
echo "==> 下载完成！模型文件位于: $MODEL_DIR"
echo "    PaddleOCR.js PP-OCRv6_small 模型已就绪，重启知识库索引即可使用。"
