"""PDF 页面渲染——用 PyMuPDF 提取高保真页面图片。

用法: python3 render_pdf_pages.py <pdf_path> <output_dir> [dpi=300] [pages=all|1,5,9]
输出: <output_dir>/page-<n>.png
      <output_dir>/pages.json  页面几何（pt 与 mm）——切片判定需要 DPI 无关的物理尺寸

pages.json 用于上层判断「是否大幅面图纸」：同一张实体图纸无论渲染多少 DPI，
被检测网络压到固定边长后的物理分辨率都一样，因此只有物理尺寸是可靠判据。
几何写入失败不影响渲染（上层会退回按 DPI 折算）。
"""
import json
import os
import sys

import fitz


def main():
    if len(sys.argv) < 3:
        sys.exit(1)

    pdf_path = sys.argv[1]
    output_dir = sys.argv[2]
    dpi = int(sys.argv[3]) if len(sys.argv) > 3 else 300
    page_spec = sys.argv[4] if len(sys.argv) > 4 else 'all'

    os.makedirs(output_dir, exist_ok=True)
    doc = fitz.open(pdf_path)

    num_pages = doc.page_count
    if page_spec == 'all':
        page_numbers = list(range(1, num_pages + 1))
    else:
        page_numbers = [int(p) for p in page_spec.split(',') if p.strip().isdigit()]

    geometry = []
    images = []
    for page_no in page_numbers:
        if page_no < 1 or page_no > num_pages:
            continue
        page = doc[page_no - 1]
        pix = page.get_pixmap(dpi=dpi)
        out = os.path.join(output_dir, f"page-{page_no}.png")
        pix.save(out)
        images.append(os.path.basename(out))
        # rect 单位是 pt（1pt = 1/72 inch）
        rect = page.rect
        geometry.append({
            'page': page_no,
            'widthPt': round(rect.width, 2),
            'heightPt': round(rect.height, 2),
            'widthMm': round(rect.width * 25.4 / 72, 2),
            'heightMm': round(rect.height * 25.4 / 72, 2),
        })

    try:
        with open(os.path.join(output_dir, 'pages.json'), 'w', encoding='utf-8') as handle:
            json.dump({'dpi': dpi, 'renderer': 'pymupdf', 'pages': geometry, 'images': images}, handle, ensure_ascii=False)
    except OSError as error:
        print(f"WARN: pages.json 写入失败: {error}", file=sys.stderr)

    doc.close()
    print(f"OK:{num_pages}")


if __name__ == '__main__':
    main()
