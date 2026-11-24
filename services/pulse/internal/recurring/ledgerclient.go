package recurring

import (
	"context"
	"fmt"
	"time"

	ledgerv1 "github.com/flyinginsectsunpig/kitty/services/pulse/gen/kitty/ledger/v1"
	"golang.org/x/oauth2"
	"golang.org/x/oauth2/clientcredentials"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

// ClientID is pulse's Keycloak client; the ledger's gRPC policy requires a token issued to it.
const ClientID = "kitty-pulse"

type ledgerClient struct {
	rpc ledgerv1.RecurringServiceClient
}

// NewLedgerConn connects to the ledger's gRPC port at addr (plain HTTP/2 on the internal network), sending a
// client-credentials token from tokenURL with every call, cached until shortly before it expires.
func NewLedgerConn(addr, tokenURL, secret string, opts ...grpc.DialOption) (*grpc.ClientConn, error) {
	tokens := (&clientcredentials.Config{ClientID: ClientID, ClientSecret: secret, TokenURL: tokenURL}).TokenSource(context.Background())
	conn, err := grpc.NewClient(addr, append([]grpc.DialOption{
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithPerRPCCredentials(bearer{tokens}),
	}, opts...)...)
	if err != nil {
		return nil, fmt.Errorf("ledger client: %w", err)
	}
	return conn, nil
}

// NewLedgerClient calls the ledger's RecurringService over conn.
func NewLedgerClient(conn grpc.ClientConnInterface) Adder {
	return ledgerClient{rpc: ledgerv1.NewRecurringServiceClient(conn)}
}

func (c ledgerClient) AddOccurrence(ctx context.Context, scheduleID string, period time.Time) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	_, err := c.rpc.AddOccurrence(ctx, &ledgerv1.AddOccurrenceRequest{ScheduleId: scheduleID, Period: period.Format(time.DateOnly)})
	return err // already_added is a success: the period is there
}

// bearer sends the service token. It allows plain HTTP/2 because the ledger's gRPC port is only reachable inside the
// server (the stock grpc oauth credentials insist on TLS).
type bearer struct{ source oauth2.TokenSource }

func (b bearer) GetRequestMetadata(context.Context, ...string) (map[string]string, error) {
	t, err := b.source.Token()
	if err != nil {
		return nil, fmt.Errorf("service token: %w", err)
	}
	return map[string]string{"authorization": "Bearer " + t.AccessToken}, nil
}

func (bearer) RequireTransportSecurity() bool { return false }
