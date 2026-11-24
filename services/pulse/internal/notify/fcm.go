package notify

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
)

// Message is what a person is told.
type Message struct{ Title, Body, Link string }

// PushResult is what happened to one push.
type PushResult int

const (
	PushSent      PushResult = iota // Firebase accepted it
	PushDeadToken                   // the token no longer exists or was never valid: forget it
	PushRetry                       // Firebase is busy or failing: try again later
	PushFailed                      // rejected for another reason: don't retry
)

// Pusher sends a push notification to one phone.
type Pusher interface {
	Push(ctx context.Context, token string, m Message) (PushResult, error)
}

// FCMBaseURL is Firebase Cloud Messaging's API.
const FCMBaseURL = "https://fcm.googleapis.com"

type fcm struct {
	http    *http.Client
	sendURL string
}

// NewFCM sends with Firebase Cloud Messaging HTTP v1, authenticated as the service account in credentialsJSON (its
// project id says where to send).
func NewFCM(credentialsJSON []byte, baseURL string) (Pusher, error) {
	creds, err := google.CredentialsFromJSON(context.Background(), credentialsJSON, "https://www.googleapis.com/auth/firebase.messaging")
	if err != nil {
		return nil, fmt.Errorf("firebase credentials: %w", err)
	}
	if creds.ProjectID == "" {
		return nil, fmt.Errorf("firebase credentials: no project_id")
	}
	client := oauth2.NewClient(context.Background(), creds.TokenSource)
	client.Timeout = 15 * time.Second
	return &fcm{http: client, sendURL: fmt.Sprintf("%s/v1/projects/%s/messages:send", baseURL, creds.ProjectID)}, nil
}

func (f *fcm) Push(ctx context.Context, token string, m Message) (PushResult, error) {
	body, _ := json.Marshal(map[string]any{"message": map[string]any{
		"token":        token,
		"notification": map[string]string{"title": m.Title, "body": m.Body},
		"data":         map[string]string{"link": m.Link},
		"android":      map[string]string{"priority": "HIGH"},
	}})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, f.sendURL, bytes.NewReader(body))
	if err != nil {
		return PushFailed, err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := f.http.Do(req)
	if err != nil {
		return PushRetry, fmt.Errorf("fcm: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusOK {
		return PushSent, nil
	}
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	code := fcmErrorCode(raw)
	err = fmt.Errorf("fcm: %s %s", res.Status, code)
	switch {
	case code == "UNREGISTERED" || code == "INVALID_ARGUMENT" || res.StatusCode == http.StatusNotFound:
		return PushDeadToken, err
	case res.StatusCode == http.StatusTooManyRequests || res.StatusCode >= 500 || code == "UNAVAILABLE" || code == "QUOTA_EXCEEDED":
		return PushRetry, err
	default:
		return PushFailed, err
	}
}

// fcmErrorCode is FCM's own error code (UNREGISTERED, …) from an error body, or its status when there's none.
func fcmErrorCode(body []byte) string {
	var e struct {
		Error struct {
			Status  string `json:"status"`
			Details []struct {
				ErrorCode string `json:"errorCode"`
			} `json:"details"`
		} `json:"error"`
	}
	if json.Unmarshal(body, &e) != nil {
		return ""
	}
	for _, d := range e.Error.Details {
		if d.ErrorCode != "" {
			return d.ErrorCode
		}
	}
	return e.Error.Status
}
