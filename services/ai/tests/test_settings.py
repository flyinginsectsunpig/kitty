import psycopg.conninfo

from kitty_ai.settings import postgres_conninfo


def test_dotnet_style_connection_string_is_converted():
    # What Aspire hands out (the same string the ledger uses).
    converted = postgres_conninfo("Host=localhost;Port=5432;Username=postgres;Password=p@ss w0rd'!;Database=ledger")
    assert psycopg.conninfo.conninfo_to_dict(converted) == {
        "host": "localhost",
        "port": "5432",
        "user": "postgres",
        "password": "p@ss w0rd'!",
        "dbname": "ledger",
    }


def test_libpq_strings_pass_through():
    assert postgres_conninfo("postgresql://u:p@db:5432/ledger") == "postgresql://u:p@db:5432/ledger"
    assert postgres_conninfo("host=db dbname=ledger user=u password=p") == "host=db dbname=ledger user=u password=p"
