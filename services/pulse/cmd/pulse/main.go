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
	"syscall"
	"time"

	fxv1 "github.com/flyinginsectsunpig/kitty/services/pulse/gen/kitty/fx/v1"
	"github.com/flyinginsectsunpig/kitty/services/pulse/internal/fx"
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
	dbURL := os.Getenv("PULSE_DATABASE_URL")
	if dbURL == "" {
		return fmt.Errorf("PULSE_DATABASE_URL is required")
	}
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

func env(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}
