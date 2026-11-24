package notify

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fakeFirebase is a token endpoint and an FCM endpoint in one test server.
type fakeFirebase struct {
	srv    *httptest.Server
	auth   string
	body   map[string]any
	status int
	reply  string
}

func newFakeFirebase(t *testing.T) *fakeFirebase {
	t.Helper()
	f := &fakeFirebase{status: http.StatusOK, reply: `{"name":"projects/kitty-test/messages/1"}`}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/token":
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"access_token":"fcm-access","token_type":"Bearer","expires_in":3600}`)
		case r.URL.Path == "/v1/projects/kitty-test/messages:send":
			f.auth = r.Header.Get("Authorization")
			_ = json.NewDecoder(r.Body).Decode(&f.body)
			w.WriteHeader(f.status)
			_, _ = io.WriteString(w, f.reply)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

// serviceAccount is a Firebase service-account key whose token endpoint is the fake.
func (f *fakeFirebase) serviceAccount(t *testing.T) []byte {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKCS8PrivateKey(key)
	b, _ := json.Marshal(map[string]string{
		"type": "service_account", "project_id": "kitty-test", "private_key_id": "k1",
		"private_key":  string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})),
		"client_email": "pulse@kitty-test.iam.gserviceaccount.com", "token_uri": f.srv.URL + "/token",
	})
	return b
}

func (f *fakeFirebase) pusher(t *testing.T) Pusher {
	t.Helper()
	p, err := NewFCM(f.serviceAccount(t), f.srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

var msg = Message{Title: "Flat 4B", Body: "Sam added Groceries · your share R 150,00", Link: "kitty://groups/g1"}

func TestFCM_SendsMessageWithBearerToken(t *testing.T) {
	f := newFakeFirebase(t)

	res, err := f.pusher(t).Push(context.Background(), "phone-token", msg)

	if err != nil || res != PushSent {
		t.Fatalf("res=%v err=%v", res, err)
	}
	if f.auth != "Bearer fcm-access" {
		t.Fatalf("auth = %q", f.auth)
	}
	m := f.body["message"].(map[string]any)
	n := m["notification"].(map[string]any)
	if m["token"] != "phone-token" || n["title"] != "Flat 4B" || !strings.Contains(n["body"].(string), "Groceries") ||
		m["data"].(map[string]any)["link"] != "kitty://groups/g1" || m["android"].(map[string]any)["priority"] != "HIGH" {
		t.Fatalf("body = %v", f.body)
	}
}

func TestFCM_UnregisteredIsDeadToken(t *testing.T) {
	f := newFakeFirebase(t)
	f.status = http.StatusNotFound
	f.reply = `{"error":{"code":404,"status":"NOT_FOUND","details":[{"@type":"type.googleapis.com/google.firebase.fcm.v1.FcmError","errorCode":"UNREGISTERED"}]}}`

	res, err := f.pusher(t).Push(context.Background(), "old-token", msg)

	if res != PushDeadToken {
		t.Fatalf("res=%v err=%v", res, err)
	}
}

func TestFCM_InvalidTokenIsDeadToken(t *testing.T) {
	f := newFakeFirebase(t)
	f.status = http.StatusBadRequest
	f.reply = `{"error":{"code":400,"status":"INVALID_ARGUMENT","details":[{"@type":"type.googleapis.com/google.firebase.fcm.v1.FcmError","errorCode":"INVALID_ARGUMENT"}]}}`

	if res, _ := f.pusher(t).Push(context.Background(), "garbage", msg); res != PushDeadToken {
		t.Fatalf("res=%v", res)
	}
}

func TestFCM_ServerErrorIsRetry(t *testing.T) {
	f := newFakeFirebase(t)
	f.status = http.StatusServiceUnavailable
	f.reply = `{"error":{"code":503,"status":"UNAVAILABLE"}}`

	res, err := f.pusher(t).Push(context.Background(), "phone-token", msg)

	if res != PushRetry || err == nil {
		t.Fatalf("res=%v err=%v", res, err)
	}
}
