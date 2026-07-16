"""PDF 页面渲染——用 PyMuPDF 提取高保真页面图片。
用法: python3 render_pdf_pages.py <pdf_path> <output_dir> [dpi=300]
输出: <output_dir>/page-<n>.png"""
import sys, os
import fitz

def main():
    if len(sys.argv) < 3:
        sys.exit(1)

    pdf_path = sys.argv[1]
    output_dir = sys.argv[2]
    dpi = int(sys.argv[3]) if len(sys.argv) > 3 else 300

    os.makedirs(output_dir, exist_ok=True)
    doc = fitz.open(pdf_path)

    num_pages = doc.page_count
    for i in range(num_pages):
        pix = doc[i].get_pixmap(dpi=dpi)
        out = os.path.join(output_dir, f"page-{i + 1}.png")
        pix.save(out)

    doc.close()
    print(f"OK:{num_pages}")


if __name__ == '__main__':
    main()
