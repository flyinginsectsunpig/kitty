// pulse serves Kitty's exchange rates over gRPC. `pulse -health` checks a running instance (for container health
// checks: the image has no shell).
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	fxv1 "github.com/flyinginsectsunpig/kitty/services/pulse/gen/kitty/fx/v1"
	"github.com/flyinginsectsunpig/kitty/services/pulse/internal/fx"
	"github.com/flyinginsectsunpig/kitty/services/pulse/internal/kafkaconsume"
	"github.com/flyinginsectsunpig/kitty/services/pulse/internal/notify"
	"github.com/flyinginsectsunpig/kitty/services/pulse/internal/recurring"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/health"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
)

func main() {
	healthCheck := flag.Bool("health", false, "check a running pulse and exit 0 when it's serving")
	flag.Parse()

	port := env("PULSE_PORT", "5090")
	if *healthCheck {
		os.Exit(checkHealth(port))
	}
	if err := run(port); err != nil {
		slog.Error("pulse stopped", "err", err)
		os.Exit(1)
	}
}

func run(port string) error {
	cfg, err := requiredEnv("PULSE_DATABASE_URL", "PULSE_KAFKA_BOOTSTRAP", "PULSE_LEDGER_GRPC", "PULSE_TOKEN_URL", "PULSE_CLIENT_SECRET",
		"PULSE_WEB_URL")
	if err != nil {
		return err
	}
	dbURL := cfg["PULSE_DATABASE_URL"]
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	store, err := fx.OpenStore(ctx, dbURL)
	if err != nil {
		return err
	}
	defer store.Close()

	svc := &fx.Service{
		Source: fx.NewFrankfurter(env("PULSE_FRANKFURTER_URL", "https://api.frankfurter.dev/v1")),
		Store:  store,
		Now:    time.Now,
	}
	// Hourly, so today's rate appears soon after the ECB publishes (around 16:00 CET).
	go fx.RefreshDaily(ctx, svc, time.Hour)

	// Recurring expenses: follow the ledger's schedules, and add each period when it falls due.
	schedules, err := recurring.OpenStore(ctx, dbURL)
	if err != nil {
		return err
	}
	defer schedules.Close()
	consumer, err := recurring.NewConsumerClient(cfg["PULSE_KAFKA_BOOTSTRAP"], recurring.Topic, "pulse-recurring")
	if err != nil {
		return err
	}
	defer consumer.Close()
	go func() {
		if err := recurring.Consume(ctx, consumer, schedules); err != nil && ctx.Err() == nil {
			slog.Error("schedule consumer stopped", "err", err)
		}
	}()
	ledgerConn, err := recurring.NewLedgerConn(cfg["PULSE_LEDGER_GRPC"], cfg["PULSE_TOKEN_URL"], cfg["PULSE_CLIENT_SECRET"])
	if err != nil {
		return err
	}
	defer ledgerConn.Close()
	scheduler := &recurring.Scheduler{Store: schedules, Ledger: recurring.NewLedgerClient(ledgerConn), Now: time.Now}
	go scheduler.Run(ctx, time.Minute)

	if err := startNotifications(ctx, cfg, dbURL, notify.NewLedger(ledgerConn)); err != nil {
		return err
	}

	lis, err := net.Listen("tcp", ":"+port)
	if err != nil {
		return err
	}
	srv := grpc.NewServer()
	fxv1.RegisterRatesServiceServer(srv, svc)
	healthpb.RegisterHealthServer(srv, health.NewServer()) // SERVING once registered

	go func() {
		<-ctx.Done()
		srv.GracefulStop()
	}()
	slog.Info("pulse listening", "port", port)
	return srv.Serve(lis)
}

// startNotifications follows everyone's settings, delivers what the ledger asks for, and asks for the weekly
// summaries. Push needs PULSE_FCM_CREDENTIALS (a service-account key file) and email PULSE_SMTP_HOST; each is off,
// said once at startup, without its setting.
func startNotifications(ctx context.Context, cfg map[string]string, dbURL string, ledger notify.Ledger) error {
	store, err := notify.OpenStore(ctx, dbURL)
	if err != nil {
		return err
	}
	context.AfterFunc(ctx, store.Close)

	d := &notify.Dispatcher{Deliveries: store, Settings: store, Pending: store, Ledger: ledger, Now: time.Now, Wait: notify.Sleep}
	if path := os.Getenv("PULSE_FCM_CREDENTIALS"); path != "" {
		key, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("PULSE_FCM_CREDENTIALS: %w", err)
		}
		if d.Push, err = notify.NewFCM(key, notify.FCMBaseURL); err != nil {
			return err
		}
	} else {
		slog.Info("push notifications are off: PULSE_FCM_CREDENTIALS isn't set")
	}
	if host := os.Getenv("PULSE_SMTP_HOST"); host != "" {
		port, err := strconv.Atoi(env("PULSE_SMTP_PORT", "587"))
		if err != nil {
			return fmt.Errorf("PULSE_SMTP_PORT: %w", err)
		}
		from := os.Getenv("PULSE_SMTP_FROM")
		if from == "" {
			return fmt.Errorf("PULSE_SMTP_FROM is required when PULSE_SMTP_HOST is set")
		}
		tlsMode, err := notify.ParseTLSMode(os.Getenv("PULSE_SMTP_SSL"), os.Getenv("PULSE_SMTP_STARTTLS"), port)
		if err != nil {
			return fmt.Errorf("PULSE_SMTP_SSL / PULSE_SMTP_STARTTLS: %w", err)
		}
		d.Mail = notify.NewSMTP(host, port, tlsMode, os.Getenv("PULSE_SMTP_USER"), os.Getenv("PULSE_SMTP_PASSWORD"), from, cfg["PULSE_WEB_URL"])
	} else {
		slog.Info("email notifications are off: PULSE_SMTP_HOST isn't set")
	}

	brokers := cfg["PULSE_KAFKA_BOOTSTRAP"]
	settings, err := kafkaconsume.NewClient(brokers, notify.SettingsTopic, "pulse-notify-settings")
	if err != nil {
		return err
	}
	requests, err := kafkaconsume.NewClient(brokers, notify.RequestsTopic, "pulse-notify")
	if err != nil {
		settings.Close()
		return err
	}
	context.AfterFunc(ctx, settings.Close)
	context.AfterFunc(ctx, requests.Close)
	go func() {
		if err := notify.ConsumeSettings(ctx, settings, store); err != nil && ctx.Err() == nil {
			slog.Error("notify settings consumer stopped", "err", err)
		}
	}()
	go func() {
		if err := kafkaconsume.Run(ctx, requests, "notification", d.Handle); err != nil && ctx.Err() == nil {
			slog.Error("notification consumer stopped", "err", err)
		}
	}()
	go d.RunRetries(ctx, 15*time.Second) // requests a provider failed for now: off the topic, so they hold nothing up
	go notify.RunWeekly(ctx, ledger, time.Now)
	return nil
}

func checkHealth(port string) int {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, err := grpc.NewClient("localhost:"+port, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer conn.Close()
	res, err := healthpb.NewHealthClient(conn).Check(ctx, &healthpb.HealthCheckRequest{})
	if err != nil || res.GetStatus() != healthpb.HealthCheckResponse_SERVING {
		fmt.Fprintln(os.Stderr, "not serving:", err)
		return 1
	}
	return 0
}

// requiredEnv reads every named variable, failing fast with the full list of missing ones.
func requiredEnv(names ...string) (map[string]string, error) {
	values := map[string]string{}
	var missing []string
	for _, n := range names {
		if v := os.Getenv(n); v != "" {
			values[n] = v
		} else {
			missing = append(missing, n)
		}
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf("required environment variables are missing: %s", strings.Join(missing, ", "))
	}
	return values, nil
}

func env(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}
