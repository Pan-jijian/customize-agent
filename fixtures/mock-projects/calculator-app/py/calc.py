# BUG: 语法错误 — 缺少冒号
def add(a, b)
    return a + b


def subtract(a, b):
    return a - b


# BUG: 变量名拼写错误
def multiply(a, b):
    result = a * b
    return resut  # typo: resut 应为 result


def divide(a, b):
    if b == 0:
        raise ValueError("Cannot divide by zero")
    return a / b
