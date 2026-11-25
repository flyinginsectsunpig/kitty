# pulse

Kitty's Go service. It adds recurring expenses when they fall due (following the ledger's schedules on Kafka, calling
the ledger's `kitty.ledger.v1.RecurringService` with its own Keycloak service token), and it serves exchange rates over gRPC (`kitty.fx.v1.RatesService`, defined in
`contracts/proto/kitty/fx/v1/rates.proto`): ECB rates from [Frankfurter](https://frankfurter.dev), kept in its own
`pulse` schema in the shared Postgres. It also delivers notifications: the ledger decides who is told what (on the
`notifications.requested` topic) and publishes each person's settings (`ledger.notify-settings`); pulse sends each one
by Firebase push and/or email, once per channel, and asks the ledger for each week's summaries from Monday 06:00 UTC (later that week if it was down then).

## Run

Aspire starts it with the rest of the stack (`dotnet run --project aspire/Kitty.AppHost`). On its own:

```sh
PULSE_DATABASE_URL=postgres://user:pass@localhost:5432/ledger go run ./cmd/pulse
```

| Variable | Default | |
|---|---|---|
| `PULSE_DATABASE_URL` | (required) | Postgres URL; pulse creates its `pulse` schema on start |
| `PULSE_PORT` | `5090` | gRPC (plain HTTP/2) |
| `PULSE_FRANKFURTER_URL` | `https://api.frankfurter.dev/v1` | |
| `PULSE_KAFKA_BOOTSTRAP` | (required) | Kafka (Redpanda); pulse follows the `ledger.recurring` topic |
| `PULSE_LEDGER_GRPC` | (required) | the ledger's internal gRPC address, e.g. `ledger:8082` |
| `PULSE_TOKEN_URL` | (required) | Keycloak's token endpoint for client `kitty-pulse` |
| `PULSE_CLIENT_SECRET` | (required) | that client's secret |
| `PULSE_WEB_URL` | (required) | the site's address; links in emails open it |
| `PULSE_SMTP_HOST` | (empty: email off) | SMTP server for notification emails |
| `PULSE_SMTP_PORT` | `587` | |
| `PULSE_SMTP_SSL`, `PULSE_SMTP_STARTTLS` | (empty: by port) | `true`/`false`: TLS from the start, or STARTTLS. Unset, the port decides: `465` TLS, `587` STARTTLS, anything else plain (Mailpit) |
| `PULSE_SMTP_USER`, `PULSE_SMTP_PASSWORD` | (empty: no login) | |
| `PULSE_SMTP_FROM` | (required with a host) | e.g. `Kitty <kitty@example.com>` |
| `PULSE_FCM_CREDENTIALS` | (empty: push off) | path to a Firebase service-account key (JSON) |

## Generate and test

The code generators are Go tools pinned in `tools.go.mod`, kept apart from the service's own dependencies.

```sh
go tool -modfile=tools.go.mod buf lint ../../contracts   # lint the contracts (kitty/fx)
go tool -modfile=tools.go.mod buf generate               # regenerate gen/ (committed)
go vet ./... && go test ./...                            # store tests need Docker (Testcontainers)
```
