export interface Message {
  role:'system'|'user'|'assistant'|'tool';
  content:string;
}
export interface LLMResponse{
  content:string;
  thinkingContent?:string;
  usage?:{
    promptTokens:number;
    completionTokens:number;
  }
}