declare module 'fast-glob' {
  interface GlobOptions {
    cwd?: string;
    ignore?: string[];
    dot?: boolean;
  }
  function globSync(patterns: string[], options?: GlobOptions): string[];
  const glob: { globSync: typeof globSync };
  export default glob;
}
