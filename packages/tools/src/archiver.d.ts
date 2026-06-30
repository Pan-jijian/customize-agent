// Type declarations for archiver v8 (ESM-only, named exports)
declare module 'archiver' {
  interface ArchiverOptions {
    format?: 'tar' | 'zip' | 'json';
    gzip?: boolean;
    gzipOptions?: { level?: number };
  }

  class Archiver {
    constructor(options?: ArchiverOptions);
    pipe(stream: NodeJS.WritableStream): void;
    file(filePath: string, options?: { name?: string }): void;
    directory(dirPath: string, prefix?: string): void;
    finalize(): Promise<void>;
    on(event: 'error', handler: (err: Error) => void): void;
    on(event: 'close', handler: () => void): void;
  }

  export { Archiver, type ArchiverOptions };
}
