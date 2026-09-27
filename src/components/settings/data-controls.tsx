"use client";

import { useState } from "react";
import type { DeletedCounts } from "@/lib/public-api-schemas";
import { useAccount } from "@/components/auth/auth-gate";

export const CLEAR_ALL_CONFIRMATION = "清除我的全部本地数据";
export const DELETED_COUNT_LABELS: Partial<Record<keyof DeletedCounts, string>> = {
  goals: "目标", tasks: "任务", planVersions: "计划版本", checkIns: "执行记录", evidence: "证据",
  preferences: "教练偏好", conversationMessages: "对话消息", conversationSummaries: "对话摘要",
  agentRuns: "教练运行记录", auditEvents: "审计记录", operations: "操作记录", approvalGrants: "批准凭证",
  undoRecords: "撤销记录", draftArtifacts: "草案", settings: "本机设置",
};

export function DataControls({ settingId, disabled, deletedCounts, onExport, onClear }: {
  settingId: string;
  disabled: boolean;
  deletedCounts: Partial<DeletedCounts> | null;
  onExport: () => void;
  onClear: (confirmationPhrase: string) => void;
}) {
  const [confirmation, setConfirmation] = useState("");
  const invite = useAccount().session?.mode === "invite";
  return (
    <section id="data-controls" className="settings-card settings-card--danger" aria-labelledby="data-controls-title">
      <p className="section-kicker">{invite ? "当前账号数据" : "本机数据"}</p><h2 id="data-controls-title">导出或永久清除</h2>
      <p>导出文件只包含你的目标数据，不包含批准凭证、内部操作记录或模型密钥。</p>
      <button type="button" className="button-secondary" disabled={disabled} onClick={onExport}>导出 JSON</button>
      <div className="danger-zone">
        <h3>永久清除</h3>
        <p>{invite ? "会永久清除服务器上当前账号的目标、执行记录、偏好与内部记录。其他账号不受影响；账号、登录会话、每日新回合计数及不含业务内容的 Token 用量凭据保留。正在进行的模型请求无法撤回，返回的已知用量仍会计入账号。这些限制不是供应商账单硬上限。" : "会清除全部本机目标、执行记录、偏好与内部记录；本机每日模型用量记录也会重置。这不是供应商计费额度。"}</p>
        <p className="form-help">本次清除绑定{invite ? "当前账号设置" : "当前本机设置"} {settingId}；设置代次变化后必须重新确认。</p>
        <label>输入确认短语<input aria-label="输入确认短语" value={confirmation} disabled={disabled} onChange={event => setConfirmation(event.currentTarget.value)} /></label>
        <p className="form-help">请输入“{CLEAR_ALL_CONFIRMATION}”{invite ? "（沿用确认短语，实际范围为服务器上的当前账号业务数据）" : ""}</p>
        <button type="button" className="button-danger" disabled={disabled || confirmation !== CLEAR_ALL_CONFIRMATION} onClick={() => onClear(confirmation)}>{invite ? "永久清除当前账号数据" : "永久清除全部本地数据"}</button>
      </div>
      {deletedCounts ? <section className="deleted-counts" aria-labelledby="deleted-counts-title"><h3 id="deleted-counts-title">已清除的数据</h3><ul>{Object.entries(deletedCounts).map(([key, value]) => <li key={key}>{invite && key === "settings" ? "账号设置" : DELETED_COUNT_LABELS[key as keyof DeletedCounts] ?? key}：{value}</li>)}</ul><p>{invite ? "当前账号数据已清除；账号与每日新回合计数保留。" : "本机每日模型用量记录也已重置。"}</p></section> : null}
    </section>
  );
}
