import { z } from "zod";

export const APP_ERROR_CODES = [
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "OWNERSHIP_MISMATCH",
  "INVALID_TRANSITION",
  "APPROVAL_REQUIRED",
  "APPROVAL_INVALID",
  "VERSION_CONFLICT",
  "MODEL_CONFIG_MISSING",
  "MODEL_AUTH_FAILED",
  "MODEL_BALANCE_INSUFFICIENT",
  "MODEL_UNAVAILABLE",
  "MODEL_RATE_LIMITED",
  "MODEL_TIMEOUT",
  "MODEL_RESPONSE_INVALID",
  "MODEL_BUDGET_EXCEEDED",
  "AGENT_LIMIT_REACHED",
  "ORIGIN_REJECTED",
  "AUTH_REQUIRED",
  "AUTH_FORBIDDEN",
  "AUTH_INVALID_CREDENTIALS",
  "AUTH_REGISTRATION_FAILED",
  "AUTH_RATE_LIMITED",
  "INVITE_INVALID",
  "DATABASE_ERROR",
] as const;

export const AppErrorCodeSchema = z.enum(APP_ERROR_CODES);
export type AppErrorCode = z.infer<typeof AppErrorCodeSchema>;

const publicMessages: Record<AppErrorCode, string> = {
  VALIDATION_ERROR: "输入信息有误，请检查后重试。",
  NOT_FOUND: "未找到请求的内容。",
  OWNERSHIP_MISMATCH: "无权访问此内容。",
  INVALID_TRANSITION: "当前状态不能执行此操作。",
  APPROVAL_REQUIRED: "此操作需要先确认。",
  APPROVAL_INVALID: "确认已失效，请重新确认。",
  VERSION_CONFLICT: "内容已被更新，请刷新后重试。",
  MODEL_CONFIG_MISSING: "模型尚未配置。",
  MODEL_AUTH_FAILED: "模型服务认证失败，请联系管理员检查配置。",
  MODEL_BALANCE_INSUFFICIENT: "模型服务余额不足，请联系管理员。",
  MODEL_UNAVAILABLE: "模型服务暂时不可用，请稍后重试。",
  MODEL_RATE_LIMITED: "模型服务当前请求过多，请稍后重试。",
  MODEL_TIMEOUT: "模型响应超时，请重试。",
  MODEL_RESPONSE_INVALID: "模型返回了无效结果，请重试。",
  MODEL_BUDGET_EXCEEDED: "今日模型用量已达上限。",
  AGENT_LIMIT_REACHED: "本次执行已达操作上限。",
  ORIGIN_REJECTED: "请求来源不受信任。",
  AUTH_REQUIRED: "请先登录。",
  AUTH_FORBIDDEN: "无权执行此操作。",
  AUTH_INVALID_CREDENTIALS: "账号或密码无效。",
  AUTH_REGISTRATION_FAILED: "无法创建账号，请检查账号名或联系管理员。",
  AUTH_RATE_LIMITED: "尝试次数过多，请稍后重试。",
  INVITE_INVALID: "邀请无效或已过期。",
  DATABASE_ERROR: "暂时无法完成操作，请稍后重试。",
};

export class AppError extends Error {
  readonly name = "AppError";

  constructor(
    public readonly code: AppErrorCode,
    public readonly status: number,
    public readonly internalMessage: string,
    public readonly safeDetail?: string,
  ) {
    super(internalMessage);
  }
}

export type SafeErrorResponse = {
  code: AppErrorCode;
  message: string;
};

export function toSafeErrorResponse(error: unknown): SafeErrorResponse {
  if (!(error instanceof AppError)) {
    return {
      code: "DATABASE_ERROR",
      message: publicMessages.DATABASE_ERROR,
    };
  }

  return {
    code: error.code,
    message: publicMessages[error.code],
  };
}
