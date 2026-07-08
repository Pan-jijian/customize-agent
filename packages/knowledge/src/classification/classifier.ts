import * as path from 'node:path';
import type { Stats } from 'node:fs';
import type { ClassifiedFile, FileCategory } from '../types.js';

const DEFAULT_MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024;

/** 文件分类器，根据扩展名将文件归类到预定义的分类体系 */
export class FileClassifier {
  private readonly extensionMap: Map<string, [FileCategory, string]>;

  constructor() {
    this.extensionMap = this.buildExtensionMap();
  }

  classify(absolutePath: string, relativePath: string, stat: Stats): ClassifiedFile {
    const ext = path.extname(absolutePath).toLowerCase();
    const [category, format] = this.extensionMap.get(ext) ?? ['other', 'unknown'];

    return {
      absolutePath,
      relativePath,
      category,
      format,
      fileSize: stat.size,
      mtime: stat.mtimeMs,
      mimeType: this.inferMimeType(ext, category),
    };
  }

  classifyVirtual(fileName: string): Pick<ClassifiedFile, 'category' | 'format' | 'mimeType'> {
    const ext = path.extname(fileName).toLowerCase();
    const [category, format] = this.extensionMap.get(ext) ?? ['other', 'unknown'];
    return { category, format, mimeType: this.inferMimeType(ext, category) };
  }

  groupByCategory(files: ClassifiedFile[]): Map<FileCategory, ClassifiedFile[]> {
    const groups = new Map<FileCategory, ClassifiedFile[]>();
    for (const file of files) {
      const list = groups.get(file.category) ?? [];
      list.push(file);
      groups.set(file.category, list);
    }
    return groups;
  }

  shouldSkip(file: ClassifiedFile): string | null {
    const maxFileSize = Number(process.env.KB_MAX_FILE_SIZE_BYTES ?? DEFAULT_MAX_FILE_SIZE_BYTES);
    const maxBytes = Number.isFinite(maxFileSize) && maxFileSize > 0 ? maxFileSize : DEFAULT_MAX_FILE_SIZE_BYTES;
    if (file.fileSize > maxBytes) return `文件超过 ${Math.floor(maxBytes / 1024 / 1024)}MB 限制`;
    if (file.fileSize === 0) return '空文件';

    const ext = path.extname(file.absolutePath).toLowerCase();
    const skipExts = ['.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.class', '.pyc', '.o'];
    if (skipExts.includes(ext)) return '二进制可执行文件，跳过';

    const basename = path.basename(file.absolutePath);
    if (basename.startsWith('.') || basename.startsWith('._')) return '隐藏/系统文件，跳过';

    return null;
  }

  private buildExtensionMap(): Map<string, [FileCategory, string]> {
    const entries: Array<[string, FileCategory, string]> = [
      ['.pdf', 'document', 'pdf'], ['.docx', 'document', 'office'], ['.doc', 'document', 'office'], ['.rtf', 'document', 'office'], ['.odt', 'document', 'office'],
      ['.pptx', 'document', 'presentation'], ['.ppt', 'document', 'presentation'], ['.odp', 'document', 'presentation'],
      ['.md', 'document', 'markdown'], ['.markdown', 'document', 'markdown'], ['.mdx', 'document', 'markdown'],
      ['.txt', 'document', 'plaintext'], ['.textclipping', 'document', 'text_clipping'], ['.rst', 'document', 'plaintext'], ['.asciidoc', 'document', 'plaintext'], ['.tex', 'document', 'plaintext'],
      ['.epub', 'document', 'ebook'], ['.mobi', 'document', 'ebook'],

      ['.xlsx', 'spreadsheet', 'excel'], ['.xls', 'spreadsheet', 'excel'], ['.xlsm', 'spreadsheet', 'excel'],
      ['.csv', 'spreadsheet', 'csv'], ['.tsv', 'spreadsheet', 'tsv'], ['.tab', 'spreadsheet', 'tsv'], ['.ods', 'spreadsheet', 'opendoc'],

      ['.png', 'image', 'raster'], ['.jpg', 'image', 'raster'], ['.jpeg', 'image', 'raster'], ['.gif', 'image', 'raster'], ['.bmp', 'image', 'raster'], ['.webp', 'image', 'raster'], ['.tiff', 'image', 'raster'], ['.tif', 'image', 'raster'],
      ['.svg', 'image', 'vector'], ['.eps', 'image', 'vector'], ['.raw', 'image', 'raw'], ['.cr2', 'image', 'raw'], ['.nef', 'image', 'raw'], ['.dng', 'image', 'raw'],

      ['.dwg', 'cad', 'autocad'], ['.dxf', 'cad', 'autocad'], ['.dwt', 'cad', 'autocad'],
      ['.step', 'cad', 'step'], ['.stp', 'cad', 'step'], ['.p21', 'cad', 'step'], ['.iges', 'cad', 'iges'], ['.igs', 'cad', 'iges'],
      ['.stl', 'cad', 'mesh'], ['.obj', 'cad', 'mesh'], ['.3mf', 'cad', 'mesh'], ['.fbx', 'cad', 'mesh'], ['.glb', 'cad', 'mesh'], ['.gltf', 'cad', 'mesh'],
      ['.sldprt', 'cad', 'solidworks'], ['.sldasm', 'cad', 'solidworks'], ['.slddrw', 'cad', 'solidworks'],

      ['.ts', 'code', 'typescript'], ['.tsx', 'code', 'typescript'], ['.mts', 'code', 'typescript'], ['.cts', 'code', 'typescript'],
      ['.js', 'code', 'javascript'], ['.jsx', 'code', 'javascript'], ['.mjs', 'code', 'javascript'], ['.cjs', 'code', 'javascript'],
      ['.py', 'code', 'python'], ['.pyi', 'code', 'python'], ['.pyx', 'code', 'python'], ['.ipynb', 'code', 'python'],
      ['.java', 'code', 'java_kotlin'], ['.kt', 'code', 'java_kotlin'], ['.scala', 'code', 'java_kotlin'],
      ['.c', 'code', 'c_family'], ['.cpp', 'code', 'c_family'], ['.cc', 'code', 'c_family'], ['.cxx', 'code', 'c_family'], ['.h', 'code', 'c_family'], ['.hpp', 'code', 'c_family'],
      ['.go', 'code', 'go'], ['.rs', 'code', 'rust'], ['.rb', 'code', 'ruby'], ['.php', 'code', 'php'],
      ['.sh', 'code', 'shell'], ['.bash', 'code', 'shell'], ['.zsh', 'code', 'shell'], ['.fish', 'code', 'shell'], ['.sql', 'code', 'sql'],
      ['.toml', 'code', 'config'], ['.ini', 'code', 'config'], ['.cfg', 'code', 'config'], ['.conf', 'code', 'config'], ['.env', 'code', 'config'],

      ['.json', 'data', 'json'], ['.jsonl', 'data', 'json'], ['.json5', 'data', 'json'], ['.geojson', 'data', 'json'],
      ['.yaml', 'data', 'yaml'], ['.yml', 'data', 'yaml'], ['.xml', 'data', 'xml'], ['.xsd', 'data', 'xml'], ['.wsdl', 'data', 'xml'], ['.proto', 'data', 'protobuf'], ['.graphql', 'data', 'graphql'], ['.gql', 'data', 'graphql'],

      ['.html', 'web', 'html'], ['.htm', 'web', 'html'], ['.xhtml', 'web', 'html'], ['.css', 'web', 'stylesheet'], ['.scss', 'web', 'stylesheet'], ['.sass', 'web', 'stylesheet'], ['.less', 'web', 'stylesheet'],
      ['.hbs', 'web', 'template'], ['.ejs', 'web', 'template'], ['.pug', 'web', 'template'], ['.j2', 'web', 'template'], ['.jinja2', 'web', 'template'],

      ['.drawio', 'diagram', 'drawio'], ['.dio', 'diagram', 'drawio'], ['.vsdx', 'diagram', 'visio'], ['.vdx', 'diagram', 'visio'], ['.puml', 'diagram', 'plantuml'], ['.plantuml', 'diagram', 'plantuml'], ['.mmd', 'diagram', 'mermaid'], ['.mermaid', 'diagram', 'mermaid'], ['.excalidraw', 'diagram', 'excalidraw'],

    ];

    return new Map(entries.map(([ext, category, format]) => [ext, [category, format]]));
  }

  private inferMimeType(ext: string, category: FileCategory): string {
    const known: Record<string, string> = {
      '.pdf': 'application/pdf',
      '.json': 'application/json',
      '.md': 'text/markdown',
      '.txt': 'text/plain',
      '.csv': 'text/csv',
      '.html': 'text/html',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml',
    };
    return known[ext] ?? `application/x-customize-agent-${category}`;
  }
}
