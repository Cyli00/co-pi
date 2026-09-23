// 改编自 pi-permission-system 33.0.5，许可证与来源见同目录 README.md。
export function memoizeAsyncWithRetry<T>(factory: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | null = null;
  return () => {
    cached ??= factory().catch((error: unknown) => {
      cached = null;
      throw error;
    });
    return cached;
  };
}
