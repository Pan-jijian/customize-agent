// 故意注入的类型错误：参数类型应为 number
export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a, b) {  // 缺少类型注解
  return a - b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}

// BUG: divide 未处理除零情况
export function divide(a: number, b: number): number {
  return a / b;  // 应抛出除零错误
}
