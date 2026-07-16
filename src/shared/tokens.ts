// 模型最大上下文窗口（tokens）
export const MODEL_MAX_CONTEXT: Record<string, number> = {
  'glm-5.2': 1_048_576,
  'glm-5.1': 204_800,
  'glm-4.5': 131_072,
  'deepseek-v4-pro': 1_048_576,
  'deepseek-v4-flash': 1_048_576,
}

export const DEFAULT_MAX_CONTEXT = 1_048_576

export interface ContextUsage {
  used: number
  max: number
}

// 中英文混合 token 估算
// 中文: 1 token ≈ 1.5 字符 → 权重 0.67
// 英文/数字: 1 token ≈ 4 字符 → 权重 0.25
// 其他: 权重 0.33
export function estimateTokens(text: string): number {
  let tokens = 0
  for (const ch of text) {
    if (/[一-鿿㐀-䶿]/.test(ch)) {
      tokens += 1 / 1.5
    } else if (/[a-zA-Z0-9]/.test(ch)) {
      tokens += 1 / 4
    } else {
      tokens += 1 / 3
    }
  }
  return Math.ceil(tokens)
}
