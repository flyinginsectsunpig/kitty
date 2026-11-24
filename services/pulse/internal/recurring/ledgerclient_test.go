package recurring

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	ledgerv1 "github.com/flyinginsectsunpig/kitty/services/pulse/gen/kitty/ledger/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"
)

type fakeRecurringServer struct {
	ledgerv1.UnimplementedRecurringServiceServer
	auth    string
	request *ledgerv1.AddOccurrenceRequest
	reply   *ledgerv1.AddOccurrenceResponse
}

func (f *fakeRecurringServer) AddOccurrence(ctx context.Context, r *ledgerv1.AddOccurrenceRequest) (*ledgerv1.AddOccurrenceResponse, error) {
	md, _ := metadata.FromIncomingContext(ctx)
	if v := md.Get("authorization"); len(v) == 1 {
		f.auth = v[0]
	}
	f.request = r
	if f.reply == nil {
		return nil, status.Error(codes.FailedPrecondition, "paused")
	}
	return f.reply, nil
}

func TestLedgerClient_SendsBearerTokenAndPeriod(t *testing.T) {
	tokens := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.FormValue("grant_type") != "client_credentials" {
			http.Error(w, "bad grant", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"tok-123","token_type":"Bearer","expires_in":300}`))
	}))
	defer tokens.Close()

	lis := bufconn.Listen(1 << 20)
	fake := &fakeRecurringServer{reply: &ledgerv1.AddOccurrenceResponse{ExpenseId: "e1", AlreadyAdded: true}}
	srv := grpc.NewServer()
	ledgerv1.RegisterRecurringServiceServer(srv, fake)
	go func() { _ = srv.Serve(lis) }()
	defer srv.Stop()

	client, err := NewLedgerClient("passthrough:///bufnet", tokens.URL, "secret",
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) { return lis.DialContext(ctx) }))
	if err != nil {
		t.Fatal(err)
	}

	if err := client.AddOccurrence(context.Background(), "s1", date(2026, 11, 24)); err != nil {
		t.Fatalf("already_added must count as success: %v", err)
	}
	if fake.auth != "Bearer tok-123" || fake.request.GetPeriod() != "2026-11-24" || fake.request.GetScheduleId() != "s1" {
		t.Fatalf("auth = %q, request = %+v", fake.auth, fake.request)
	}

	fake.reply = nil
	err = client.AddOccurrence(context.Background(), "s1", date(2026, 11, 24).Add(time.Hour))
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("err = %v, want the ledger's code passed through", err)
	}
}
