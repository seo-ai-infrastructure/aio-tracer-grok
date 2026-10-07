import os

from collab.cli import load_env


def test_load_env(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text('# comment\nexport A_KEY="quoted value"\nB_KEY=\nC_KEY=plain\nALREADY=from-file\n')
    for k in ("A_KEY", "B_KEY", "C_KEY"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("ALREADY", "from-shell")
    load_env(env)
    assert os.environ["A_KEY"] == "quoted value"
    assert "B_KEY" not in os.environ  # blank template lines are skipped
    assert os.environ["C_KEY"] == "plain"
    assert os.environ["ALREADY"] == "from-shell"  # the shell wins
