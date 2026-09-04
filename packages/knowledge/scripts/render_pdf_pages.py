"""PDF 页面渲染——用 PyMuPDF 提取高保真页面图片。
用法: python3 render_pdf_pages.py <pdf_path> <output_dir> [dpi=300] [pages=all|1,5,9]
输出: <output_dir>/page-<n>.png"""
import sys, os
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

    for page_no in page_numbers:
        if page_no < 1 or page_no > num_pages:
            continue
        pix = doc[page_no - 1].get_pixmap(dpi=dpi)
        out = os.path.join(output_dir, f"page-{page_no}.png")
        pix.save(out)

    doc.close()
    print(f"OK:{num_pages}")


if __name__ == '__main__':
    main()
