package notify

import (
	"testing"
)

func TestReadSuppressNotification(t *testing.T) {
	cases := []struct {
		name    string
		raw     string
		want    bool
		wantErr string
	}{
		{name: "omitted", raw: `{"value_number":"1"}`, want: false},
		{name: "null", raw: `{"suppress_notification":null}`, want: false},
		{name: "false", raw: `{"suppress_notification":false}`, want: false},
		{name: "true", raw: `{"suppress_notification":true}`, want: true},
		{
			name:    "string",
			raw:     `{"suppress_notification":"true"}`,
			wantErr: "Invalid suppress_notification",
		},
		{
			name:    "number",
			raw:     `{"suppress_notification":1}`,
			wantErr: "Invalid suppress_notification",
		},
		{
			name:    "object",
			raw:     `{"suppress_notification":{}}`,
			wantErr: "Invalid suppress_notification",
		},
		{name: "empty object", raw: `{}`, want: false},
		{name: "empty body object", raw: `[]`, want: false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ReadSuppressNotification([]byte(tc.raw))
			if tc.wantErr != "" {
				if err == nil || err.Error() != tc.wantErr {
					t.Fatalf("err=%v want %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected err: %v", err)
			}
			if got != tc.want {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}

func TestReadSuppressNotificationInvalidJSONDefersToCreate(t *testing.T) {
	got, err := ReadSuppressNotification([]byte(`{`))
	if err != nil {
		t.Fatalf("invalid JSON should defer to Create, got err %v", err)
	}
	if got {
		t.Fatal("want false")
	}
}
