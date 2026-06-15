// BUG: 路由处理器缺少错误处理

interface User {
  id: number;
  name: string;
}

// BUG: 硬编码的用户数据应来自数据库
const users: User[] = [
  { id: 1, name: 'Alice' },
];

// BUG: 未检查 id 参数的有效性
export function getUser(id: string): User | undefined {
  const numId = parseInt(id);  // 未处理 NaN 情况
  return users.find(u => u.id === numId);
}

// BUG: 未验证输入，可能存入重复 id
export function createUser(name: string): User {
  const newUser: User = {
    id: users.length + 1,  // 并发不安全
    name: name,             // 可能为空字符串
  };
  users.push(newUser);
  return newUser;
}
