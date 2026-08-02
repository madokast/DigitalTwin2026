package notify

import (
	"fmt"

	"github.com/mdk/digitaltwin2026/faas/internal/jsonutil"
)

// InvalidSuppressNotification 与 Next INVALID_SUPPRESS_NOTIFICATION 同文案。
const InvalidSuppressNotification = "Invalid suppress_notification"

// ReadSuppressNotification 从原始 JSON body peek suppress_notification。
// 省略 / null → false；出现且非 boolean → Invalid suppress_notification。
// 非法 JSON 返回 false,nil，由后续 Create 报 Invalid JSON body。
// 须在 Create/insert 之前调用，避免已写入却因字段类型 400。
func ReadSuppressNotification(raw []byte) (bool, error) {
	if len(raw) == 0 {
		return false, nil
	}
	var m any
	if err := jsonutil.DecodeUseNumber(raw, &m); err != nil {
		return false, nil
	}
	obj, ok := m.(map[string]any)
	if !ok {
		return false, nil
	}
	v, present := obj["suppress_notification"]
	if !present || v == nil {
		return false, nil
	}
	b, ok := v.(bool)
	if !ok {
		return false, fmt.Errorf("%s", InvalidSuppressNotification)
	}
	return b, nil
}
