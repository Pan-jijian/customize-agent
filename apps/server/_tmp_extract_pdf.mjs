import fs from 'node:fs';
import { PDFParse } from 'pdf-parse';

const pdfPath = '/Users/pan/Desktop/codeing/customize-agent/安徽创江建筑有限责任公司+裕安区公共卫生应急和服务能力提升工程（六安市裕安区苏埠镇中心卫生院医疗业务用房及配套建设工程 (1)(1).pdf';

const buf = fs.readFileSync(pdfPath);
const parser = new PDFParse({ data: buf });
const result = await parser.getText({ pageJoiner: '\n\n' });

fs.writeFileSync('/tmp/pdf_text.txt', result.text, 'utf8');
console.log('PAGES:', result.pages?.length);
console.log('TEXT_LEN:', result.text.length);
await parser.destroy();
