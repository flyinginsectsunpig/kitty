# Build context: repository root.  docker build -f services/pulse/Dockerfile .
# Built for amd64 and arm64 (the production VM is ARM). A static binary on distroless: no shell, so the container
# health check is the binary itself (`/pulse -health`).
FROM --platform=$BUILDPLATFORM golang:1.27.4 AS build
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY services/pulse/go.mod services/pulse/go.sum ./
RUN go mod download
COPY services/pulse/ ./
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/pulse ./cmd/pulse

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/pulse /pulse
EXPOSE 5090
ENTRYPOINT ["/pulse"]
