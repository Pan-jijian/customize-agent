const fs = require('fs');
const path = '/Users/pan/Desktop/codeing/customize-agent/安徽创江建筑有限责任公司+裕安区公共卫生应急和服务能力提升工程（六安市裕安区苏埠镇中心卫生院医疗业务用房及配套建设工程 (1)(1).pdf';
const buf = fs.readFileSync(path);
const pdfParse = require('pdf-parse');
pdfParse(buf).then((data) => {
  const text = data.text || '';
  fs.writeFileSync('/tmp/pdf_text.txt', text, 'utf8');
  console.log('PAGES=' + data.numpages + ' TEXT_LEN=' + text.length);
  const idx = text.indexOf('主要施工内容');
  console.log('主要施工内容 first idx=' + idx);
  if (idx >= 0) {
    console.log('--- 主要施工内容 上下文 ---');
    console.log(text.slice(Math.max(0, idx - 300), idx + 1800));
  } else {
    console.log('--- 前 2000 字 ---');
    console.log(text.slice(0, 2000));
  }
}).catch((e) => {
  console.error('ERROR', e && e.message);
  process.exit(1);
});
