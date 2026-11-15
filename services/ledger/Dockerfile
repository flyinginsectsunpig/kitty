# Build context: repository root.  docker build -f services/ledger/Dockerfile .
# The SDK stage runs on the build machine's architecture and cross-compiles for the target (amd64 or arm64).
FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:10.0 AS build
ARG TARGETARCH
WORKDIR /src

COPY global.json Directory.Build.props Directory.Packages.props ./
COPY contracts/ contracts/
COPY aspire/Kitty.ServiceDefaults/Kitty.ServiceDefaults.csproj aspire/Kitty.ServiceDefaults/
COPY services/ledger/src/Kitty.Ledger/Kitty.Ledger.csproj services/ledger/src/Kitty.Ledger/
RUN dotnet restore services/ledger/src/Kitty.Ledger/Kitty.Ledger.csproj -a $TARGETARCH

COPY aspire/Kitty.ServiceDefaults/ aspire/Kitty.ServiceDefaults/
COPY services/ledger/src/Kitty.Ledger/ services/ledger/src/Kitty.Ledger/
RUN dotnet publish services/ledger/src/Kitty.Ledger/Kitty.Ledger.csproj -c Release -a $TARGETARCH --no-restore -o /app

# Chiseled: no shell, no package manager, runs as a non-root user by default.
FROM mcr.microsoft.com/dotnet/aspnet:10.0-noble-chiseled
WORKDIR /app
COPY --from=build /app .
ENV ASPNETCORE_HTTP_PORTS=8080
EXPOSE 8080
ENTRYPOINT ["dotnet", "Kitty.Ledger.dll"]
