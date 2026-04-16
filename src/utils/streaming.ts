/**
 * streaming.ts — 统一消费 AI SDK textStream，并可选输出到 CLI。
 */

export interface StreamConsumeOptions {
  /** 控制台打印前缀，例如 `      [fill] ` */
  prefix?: string;
  /** 是否在消费时实时打印 chunk */
  echo?: boolean;
  /** 自定义输出目标，默认 process.stdout */
  writer?: Pick<NodeJS.WriteStream, 'write'>;
}

/**
 * 消费 textStream，返回完整文本；可选地把分片实时输出到终端。
 */
export async function consumeTextStream(
  textStream: AsyncIterable<string>,
  options: StreamConsumeOptions = {},
): Promise<string> {
  const {
    prefix = '',
    echo = true,
    writer = process.stdout,
  } = options;

  let result = '';
  let hasWritten = false;
  let lineStarted = false;

  for await (const chunk of textStream) {
    result += chunk;

    if (!echo || chunk.length === 0) {
      continue;
    }

    const parts = chunk.split(/(\n)/);
    for (const part of parts) {
      if (part.length === 0) {
        continue;
      }

      if (!lineStarted && part !== '\n') {
        writer.write(prefix);
        hasWritten = true;
        lineStarted = true;
      }

      writer.write(part);
      hasWritten = true;

      if (part === '\n') {
        lineStarted = false;
      }
    }
  }

  if (echo && hasWritten && lineStarted) {
    writer.write('\n');
  }

  return result;
}
