import pytest

REDPANDA = "docker.redpanda.com/redpandadata/redpanda:v26.2.6"
AZURITE = "mcr.microsoft.com/azure-storage/azurite:3.37.0"
POSTGRES = "pgvector/pgvector:pg17"


@pytest.fixture(scope="session")
def infra():
    """Redpanda, Azurite and Postgres for the worker tests, started once per test run."""
    from testcontainers.azurite import AzuriteContainer
    from testcontainers.kafka import RedpandaContainer
    from testcontainers.postgres import PostgresContainer

    # Azurite trails the newest storage API version the SDK sends, so skip its version check.
    azurite = AzuriteContainer(AZURITE).with_command(
        "azurite-blob --blobHost 0.0.0.0 --blobPort 10000 --skipApiVersionCheck --loose"
    )
    with RedpandaContainer(REDPANDA) as redpanda, azurite as blob, PostgresContainer(POSTGRES, driver=None) as pg:
        yield {
            "kafka_bootstrap": redpanda.get_bootstrap_server(),
            "schema_registry_url": redpanda.get_schema_registry_address(),
            "blob_connection_string": blob.get_connection_string(),
            "postgres_dsn": pg.get_connection_url(),
        }
