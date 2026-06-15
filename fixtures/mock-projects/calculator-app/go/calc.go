package main

// BUG: 故意语法错误 — 缺少闭合大括号
func Add(a int, b int) int {
	return a + b

// BUG: 除零未检查
func Divide(a int, b int) int {
	return a / b
}
