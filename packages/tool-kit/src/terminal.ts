import { execa } from 'execa';

export class TerminalTool {
  private cwd: string;
  //危险命令黑名单
  private blackList = [
    /rm\s+-rf/,
    /del\s+\/f/i,
    /format/i,
    /mkfs/,
    /shutdown/i
  ]
  constructor(cwd:string){
    this.cwd = cwd;
  }
  /**
   * 安全的执行一条终端命令
   * @param command 待执行命令字符串
   * @param timeoutMills 超时时间（默认30s，防止常驻进程挂死）
   */
  async executeCommand(command:string,timeoutMills:number = 30000):Promise<{stdout:string,stderr:string;code:number|null|undefined}>{
    //1、安全沙箱检查
    const isDangerous = this.blackList.some(regex => regex.test(command));
    if(isDangerous){
      throw new Error(`[安全拦截] 命令行包含危险指令，已被拒绝执行: "${command}"`);
    }
    try{
      const result = await execa({
        shell:true,
        cwd:this.cwd,
        timeout:timeoutMills,
        reject:false
      })`${command}`;
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        code: result.exitCode
      };
    }catch(error){
      return {
        stdout: '',
        stderr: (error as Error).message,
        code: -1
      };
    }
  }
}