package logapi

// TransitionResult 成功流转结果（供 HTTP 组 200 JSON + notify）。
type TransitionResult struct {
	ID                  string
	From                string
	To                  string
	TodoAuditNotifyText string
}
