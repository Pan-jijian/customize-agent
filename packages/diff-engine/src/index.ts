export interface DiffBlock{
  search:string;
  replace:string;
}

export class DiffEngine{
  /**
   * 从llm的文本输出中提取所有的 search/replace块
   */
  static parseBlocks(text:string):DiffBlock[]{
    const blocks:DiffBlock[] = [];
    // 匹配 <<<<<<< SEARCH ... ======= ... >>>>>>> REPLACE
    const regex = /<<<<<<< SEARCH\N([\S\s]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/g;
    let match;
    while((match = regex.exec(text)) !== null){
      blocks.push({
        search:match[1],
        replace:match[2]
      })
    }
    return blocks;
  }

  /**
   * 将解析出的Diff块应用到原始文件内容中
   */
  static applyPatch(fileContent:string,block:DiffBlock):string{
    const { search,replace } = block;
    //尝试精准匹配
    if(fileContent.includes(search)){
      return fileContent.replace(search,replace);
    }
    //模糊容错，去除尾部空白符再尝试匹配（防止LLM缩进多写了空格或换行）
    const cleanSearch = search.trim();
    if(cleanSearch && fileContent.includes(cleanSearch)){
      return fileContent.replace(cleanSearch,replace.trim());
    }
    throw new Error(`无法找到匹配项：${search}`);
  }
}