package notify

import (
	"context"
	"log"
	"strconv"
	"time"

	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"
)

// Mailpit catches the email tests' mail: SMTP on testSMTPHost:testSMTPPort, its API at testMailpitAPI.
var (
	testSMTPHost   string
	testSMTPPort   int
	testMailpitAPI string
)

func startMailpit(ctx context.Context) (stop func()) {
	c, err := testcontainers.Run(ctx, "axllent/mailpit:v1.33.1",
		testcontainers.WithExposedPorts("1025/tcp", "8025/tcp"),
		testcontainers.WithWaitStrategy(wait.ForListeningPort("8025/tcp").WithStartupTimeout(time.Minute)))
	if err != nil {
		log.Fatalf("mailpit: %v", err)
	}
	if testSMTPHost, err = c.Host(ctx); err != nil {
		log.Fatalf("mailpit host: %v", err)
	}
	smtp, err := c.MappedPort(ctx, "1025/tcp")
	if err != nil {
		log.Fatalf("mailpit smtp: %v", err)
	}
	api, err := c.MappedPort(ctx, "8025/tcp")
	if err != nil {
		log.Fatalf("mailpit api: %v", err)
	}
	testSMTPPort, _ = strconv.Atoi(smtp.Port())
	testMailpitAPI = "http://" + testSMTPHost + ":" + api.Port()
	return func() { _ = testcontainers.TerminateContainer(c) }
}
