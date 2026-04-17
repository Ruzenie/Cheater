/**
 * @file streaming.ts — AI SDK 文本流消费工具
 *
 * 本文件提供 consumeTextStream() 函数，用于统一消费 Vercel AI SDK 的 textStream。
 * 在 Cheater 系统中，多个 Agent 需要从 AI SDK 的 streamText() 获取流式输出，
 * 本函数封装了流消费、文本拼接和终端实时回显的通用逻辑。
 *
 * 主要功能：
 *   - 逐 chunk 消费 AsyncIterable<string>，拼接为完整文本
 *   - 可选地将分片实时输出到终端（带自定义前缀，方便区分不同 Agent 的输出）
 *   - 自动处理换行符的前缀插入和末尾换行保证
 */

/**
 * 流消费选项配置。
 *
 * @property prefix - 控制台打印前缀，例如 '      [fill] '，用于区分不同 Agent 的输出
 * @property echo - 是否在消费时实时打印 chunk 到终端（默认 true）
 * @property writer - 自定义输出目标，默认 process.stdout
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
 * 消费 AI SDK 的 textStream，返回完整的拼接文本。
 *
 * 可选地将每个分片（chunk）实时输出到终端，实现「打字机效果」。
 * 每行的开头会自动插入 prefix 前缀，方便在终端中区分不同 Agent 的输出。
 *
 * @param textStream - AI SDK streamText() 返回的异步可迭代文本流
 * @param options - 消费选项（前缀、是否回显、输出目标）
 * @returns 拼接后的完整文本内容
 */
export async function consumeTextStream(
  textStream: AsyncIterable<string>,
  options: StreamConsumeOptions = {},
): Promise<string> {
  const { prefix = '', echo = true, writer = process.stdout } = options;

  let result = '';        // 累积的完整文本
  let hasWritten = false; // 是否已向 writer 写入过任何内容
  let lineStarted = false; // 当前行是否已开始（已写入前缀）

  for await (const chunk of textStream) {
    // 无论是否回显，都拼接到结果中
    result += chunk;

    // 不回显或空 chunk 时跳过终端输出
    if (!echo || chunk.length === 0) {
      continue;
    }

    // 按换行符拆分 chunk，保留换行符本身作为独立元素
    const parts = chunk.split(/(\n)/);
    for (const part of parts) {
      if (part.length === 0) {
        continue;
      }

      // 新行开始时先输出前缀
      if (!lineStarted && part !== '\n') {
        writer.write(prefix);
        hasWritten = true;
        lineStarted = true;
      }

      writer.write(part);
      hasWritten = true;

      // 遇到换行符时重置行状态，下次输出时会重新添加前缀
      if (part === '\n') {
        lineStarted = false;
      }
    }
  }

  // 如果最后一行没有以换行符结尾，补上换行以保持终端整洁
  if (echo && hasWritten && lineStarted) {
    writer.write('\n');
  }

  return result;
}
