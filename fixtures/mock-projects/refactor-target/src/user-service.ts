// 需要重构：将用户逻辑从单文件拆分为 service + types + utils

export interface User {
  id: number;
  name: string;
  email: string;
  createdAt: Date;
}

// 这些函数应拆分到不同模块
export class UserService {
  private users: User[] = [];

  // BUG: 重复的用户验证逻辑 (多处使用)
  private validateEmail(email: string): boolean {
    return email.includes('@');
  }

  createUser(name: string, email: string): User {
    if (!this.validateEmail(email)) {
      throw new Error('Invalid email');
    }
    const user: User = { id: this.users.length + 1, name, email, createdAt: new Date() };
    this.users.push(user);
    return user;
  }

  // BUG: 获取用户时未做空值检查
  getUser(id: number): User {
    return this.users.find(u => u.id === id)!;  // ! 断言可能返回 undefined
  }

  updateEmail(id: number, email: string): void {
    if (!this.validateEmail(email)) {
      throw new Error('Invalid email');
    }
    const user = this.getUser(id);
    user.email = email;
  }
}
