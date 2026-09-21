"""从 PaddleX 推理模型的 inference.yml 中提取识别字典。

官方发布的 PP-OCRv6 识别模型只带 inference.yml（内含 character_dict），
不再单独发布 *_dict.txt，因此字典必须从模型自带的配置里导出，
这样才能保证「字典 ↔ 权重」代次一致（不一致时识别结果会整体错位且不报错）。

用法: python3 extract_paddle_dict.py <inference.yml> <output_dict.txt>
输出: 逐行字符表 + 末行空格项（PaddleOCR use_space_char 约定，对应最后一个输出类）
"""
import re
import sys


def extract_character_dict(raw: str) -> list[str]:
    lines = raw.split('\n')
    start = next((i for i, line in enumerate(lines) if line.strip() == 'character_dict:'), None)
    if start is None:
        raise SystemExit('错误: inference.yml 中未找到 character_dict')

    chars: list[str] = []
    for line in lines[start + 1:]:
        if not line.startswith('  - '):
            if line.strip() == '':
                continue
            break  # 块结束
        value = line[4:]
        if len(value) >= 2 and value[0] == "'" and value[-1] == "'":
            value = value[1:-1].replace("''", "'")
        elif len(value) >= 2 and value[0] == '"' and value[-1] == '"':
            value = value[1:-1]
        chars.append(value)
    if not chars:
        raise SystemExit('错误: character_dict 为空')
    return chars


def main() -> None:
    if len(sys.argv) < 3:
        sys.exit('用法: python3 extract_paddle_dict.py <inference.yml> <output_dict.txt>')
    source, target = sys.argv[1], sys.argv[2]
    with open(source, encoding='utf-8') as handle:
        chars = extract_character_dict(handle.read())

    # 末行是空格字符：模型把空格作为独立输出类，库要求字典长度 >= 输出类别数 - 1。
    # 官方字符表不含空格项（18708 项 ↔ dictionaryLength 18708），必须补上。
    if chars[-1] != ' ':
        chars.append(' ')

    with open(target, 'w', encoding='utf-8') as handle:
        handle.write('\n'.join(chars))
    print(f'OK:{len(chars)}')


if __name__ == '__main__':
    main()
