import { useEffect, useRef, useState } from "react";
import {
  Check,
  Copy,
  ExternalLink,
  LoaderCircle,
  MessageSquarePlus,
  Send,
  X,
} from "lucide-react";
import {
  type FeedbackCategory,
  type FeedbackReceipt,
  GITHUB_ISSUES_URL,
  type PublicStats,
  fetchPublicStats,
  submitAnonymousFeedback,
} from "./telemetry";
import { APP_VERSION, type View } from "./types";

export default function FeedbackModal({
  close,
  isTauri,
  view,
  lastError,
  onStatsUpdate,
}: {
  close: () => void;
  isTauri: boolean;
  view: View | null;
  lastError?: string;
  onStatsUpdate?: (stats: PublicStats) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const initialCategory: FeedbackCategory =
    lastError || view?.support_tier === "read_only" ? "compat" : "bug";

  const [category, setCategory] = useState<FeedbackCategory>(initialCategory);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [website, setWebsite] = useState("");
  const [attachDiag, setAttachDiag] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [receipt, setReceipt] = useState<FeedbackReceipt | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  const publicText = (input: string) =>
    input.trim().startsWith("[最近提示]") ? "" : input.trim();
  const publicTitle = publicText(title);
  const publicDescription = publicText(description);
  const { vid, pid, version_display } = view?.snapshot.identity || {};
  const hexId = (value?: string) => typeof value === "string" && /^[0-9a-f]{4}$/i.test(value);
  const modelIds = hexId(vid) && hexId(pid) ? { vid, pid } : null;
  const firmware =
    version_display && /^[0-9]{1,3}(\.[0-9]{1,3}){1,2}$/.test(version_display)
      ? version_display : null;
  const diagnostic = attachDiag && view ? {
    identity: { ...modelIds, ...(firmware ? { version_display: firmware } : {}) },
    support_tier: view.support_tier,
  } : null;
  const previewTitle = publicTitle.length >= 2
    ? publicTitle
    : publicDescription.split(/\r?\n/)[0].slice(0, 50);

  const handleSubmit = async () => {
    if (submitting) return;
    setSubmitError("");
    if (publicTitle.length < 2 && publicDescription.length < 4) {
      setSubmitError("请简单填写问题标题或现象描述");
      return;
    }
    setSubmitting(true);
    try {
      const res = await submitAnonymousFeedback({
        category,
        title: publicTitle,
        description: publicDescription,
        platform: isTauri ? "desktop" : "web",
        app_version: APP_VERSION,
        diagnostic,
        website,
      });
      setReceipt(res);
      void fetchPublicStats().then((s) => {
        if (s && onStatsUpdate) onStatsUpdate(s);
      });
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const copyReceipt = async () => {
    if (!receipt) return;
    try {
      await navigator.clipboard.writeText(receipt.id);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore clipboard failure
    }
  };

  return (
    <dialog
      ref={ref}
      className="feedback-dialog"
      onCancel={(e) => {
        e.preventDefault();
        if (!submitting) close();
      }}
    >
      <header>
        <h2>
          <MessageSquarePlus size={19} />
          免登录问题反馈与兼容上报
        </h2>
        <button
          className="icon"
          aria-label="关闭反馈窗口"
          disabled={submitting}
          onClick={close}
        >
          <X size={20} />
        </button>
      </header>

      {receipt ? (
        <div className="feedback-receipt">
          <div className="receipt-badge">
            <Check size={24} />
          </div>
          <h3>反馈已收到，无需任何账号操作</h3>
          <p>
            反馈已接收，将同步到项目的公开 GitHub Issue。
          </p>
          <div className="receipt-code-row">
            <span>回执编号</span>
            <code>{receipt.id}</code>
            <button className="mini" onClick={() => void copyReceipt()}>
              <Copy size={14} />
              {copied ? "已复制" : "复制编号"}
            </button>
          </div>
          {receipt.issue_url && (
            <p className="hint">
              已同步至 Issue #{receipt.issue_number}：
              <a href={receipt.issue_url} target="_blank" rel="noreferrer">
                点击查看
              </a>
            </p>
          )}
          <div className="dialog-actions">
            <button className="primary" autoFocus onClick={close}>
              完成并关闭
            </button>
          </div>
        </div>
      ) : (
        <div className="feedback-form">
          <p className="feedback-lead">
            无需注册 GitHub 账号。你填写的标题和描述会公开显示在 GitHub Issues，
            请勿填写邮箱、QQ、设备序列号或其他隐私信息。
          </p>

          <div className="segmented feedback-cats" role="radiogroup">
            {(
              [
                ["compat", "手柄连接 / 兼容"],
                ["bug", "功能异常 (Bug)"],
                ["feature", "功能建议"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={category === id ? "active" : ""}
                onClick={() => setCategory(id)}
              >
                {label}
              </button>
            ))}
          </div>

          <label className="feedback-field">
            <span>问题简述</span>
            <input
              type="text"
              maxLength={100}
              placeholder={
                category === "compat"
                  ? "例如：致动 O+ 蓝牙读取报错 / 某型号无法识别背键"
                  : category === "feature"
                    ? "例如：希望能增加某项摇杆预设或快捷键"
                    : "例如：修改某项设置后回读不一致"
              }
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>

          <label className="feedback-field">
            <span>详细现象或复现步骤</span>
            <textarea
              rows={4}
              maxLength={6000}
              placeholder="请简单描述你遇到的情况、手柄型号（如 O+ 传奇版 / 精英版）、连接方式（蓝牙 / 接收器 / 有线）…"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>

          {/* Honeypot anti-bot field */}
          <input
            type="text"
            name="website"
            tabIndex={-1}
            autoComplete="off"
            aria-hidden="true"
            className="feedback-hp"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
          />

          {view && (
            <label className="feedback-check">
              <input
                type="checkbox"
                checked={attachDiag}
                onChange={(e) => setAttachDiag(e.target.checked)}
              />
              <span>附上手柄兼容摘要（型号编码、固件版本和支持分级）</span>
            </label>
          )}

          <details className="feedback-preview" open>
            <summary>公开内容预览</summary>
            <strong>{previewTitle ? `[玩家反馈] ${previewTitle}` : "（未填写）"}</strong>
            <p>{publicDescription || previewTitle || "（未填写）"}</p>
            {diagnostic && (
              <p>
                {modelIds && `型号编码 ${modelIds.vid}:${modelIds.pid} · `}
                {firmware && `固件 ${firmware} · `}
                支持分级 {diagnostic.support_tier}
              </p>
            )}
            <small>
              {isTauri ? "Windows 桌面版" : "在线网页驱动"} · v{APP_VERSION}。
              公开 Issue 还会显示反馈类型、回执号和提交时间。
            </small>
          </details>

          {submitError && (
            <p className="field-error" role="alert">
              {submitError}
            </p>
          )}

          <div className="dialog-actions feedback-actions">
            {!isTauri && (
              <a
                href={GITHUB_ISSUES_URL}
                target="_blank"
                rel="noreferrer"
                className="feedback-gh-link"
              >
                用 GitHub 提 Issue <ExternalLink size={14} />
              </a>
            )}
            <div className="feedback-submit-group">
              <button disabled={submitting} onClick={close}>
                取消
              </button>
              <button
                className="primary"
                disabled={submitting}
                onClick={() => void handleSubmit()}
              >
                {submitting ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <Send size={16} />
                )}
                {submitting ? "正在提交…" : "提交公开反馈"}
              </button>
            </div>
          </div>
        </div>
      )}
    </dialog>
  );
}
