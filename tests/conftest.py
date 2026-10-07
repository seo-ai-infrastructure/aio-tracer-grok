from pathlib import Path

import pytest

from collab.adapters.ndjson import read_records
from collab.ingest import ingest
from collab.store import Store

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def records_a():
    return list(read_records(FIXTURES / "sim_small_a.ndjson"))


@pytest.fixture
def records_b():
    return list(read_records(FIXTURES / "sim_small_b.ndjson"))


@pytest.fixture
def store(records_a, records_b):
    s = Store()
    ingest(s, records_a, log=True)
    ingest(s, records_b, log=True)
    yield s
    s.close()
